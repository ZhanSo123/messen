"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MsgAck, MsgBroadcast } from "../lib/realtimeTypes";
import { createRealtimeClient } from "../lib/realtime";
import { ReactionStore } from "../lib/reactionStore";
import { loadSettings, saveSettings, toggleChatInFocus, type UserSettings } from "../lib/settings";
import { pushRecentChat } from "../lib/recentChats";
import { clearCachedMe, clearToken } from "../lib/auth";
import { trackMetric } from "../lib/metrics";

type UiMsg = {
  key: string; // tempId or msgId
  chatId: string;
  text: string;
  from: string;
  clientTs: number;
  serverTs?: number;
  status: "pending" | "sent" | "failed";
  tempId?: string;
  msgId?: string;
  failReason?: string;
};

export function ChatView(props: { chatId: string; token: string; meId: string; realtimeUrl: string }) {
  const { chatId, token, meId, realtimeUrl } = props;
  const router = useRouter();
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [restStatus, setRestStatus] = useState<"loading" | "ok" | "forbidden" | "unavailable">("loading");
  const [restRetry, setRestRetry] = useState(0);
  const reactionsRef = useRef(new ReactionStore());
  const [reactionsRev, setReactionsRev] = useState(0);
  const bumpReactions = () => setReactionsRev((x) => x + 1);
  const pendingReactRef = useRef(new Map<string, { msgId: string; emoji: string; op: "add" | "remove" }>());
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings(meId));
  const [openReactions, setOpenReactions] = useState<Set<string>>(() => new Set());

  function makeReactTempId(): string {
    const now = Date.now();
    const rnd = Math.random().toString(16).slice(2);
    return `r_${now}_${rnd}`;
  }

  const rt = useMemo(() => {
    return createRealtimeClient({
      url: realtimeUrl,
      token,
      autoConnect: false,
      onAck: (ack: MsgAck) => {
        setMsgs((prev) => {
          // If broadcast landed before ack, prefer the broadcast row and just drop pending.
          if (prev.some((m) => m.msgId === ack.msgId)) {
            return prev.filter((m) => m.tempId !== ack.tempId);
          }
          return prev.map((m) => {
            if (m.tempId !== ack.tempId) return m;
            return {
              ...m,
              status: "sent",
              msgId: ack.msgId,
              key: ack.msgId,
              serverTs: ack.serverTs
            };
          });
        });
      },
      onBroadcast: (m: MsgBroadcast) => {
        setMsgs((prev) => {
          if (prev.some((x) => x.msgId === m.msgId)) return prev;
          return [
            ...prev,
            {
              key: m.msgId,
              msgId: m.msgId,
              chatId: m.chatId,
              text: m.text,
              from: m.from,
              clientTs: m.serverTs,
              serverTs: m.serverTs,
              status: "sent"
            }
          ];
        });
      },
      onReactBroadcast: (evt) => {
        if (evt.targetType !== "message") return;
        reactionsRef.current.add({ msgId: evt.targetId, emoji: evt.emoji, userId: evt.userId });
        bumpReactions();
      },
      onReactRemoveBroadcast: (evt) => {
        if (evt.targetType !== "message") return;
        reactionsRef.current.remove({ msgId: evt.targetId, emoji: evt.emoji, userId: evt.userId });
        bumpReactions();
      },
      onReactAck: (ack) => {
        if (!ack?.tempId) return;
        pendingReactRef.current.delete(ack.tempId);
      },
      onReactSync: (resp) => {
        if (resp.targetType !== "message") return;
        if (resp.chatId !== chatId) return;
        for (const it of resp.items) reactionsRef.current.add({ msgId: it.targetId, emoji: it.emoji, userId: it.userId });
        bumpReactions();
      },
      onError: (err) => {
        // Rollback only for optimistic reaction toggles that carry tempId.
        const tempId = err?.tempId;
        if (!tempId || !tempId.startsWith("r_")) return;
        const op = pendingReactRef.current.get(tempId);
        if (!op) return;
        pendingReactRef.current.delete(tempId);

        if (op.op === "add") {
          reactionsRef.current.remove({ msgId: op.msgId, emoji: op.emoji, userId: meId });
        } else {
          reactionsRef.current.add({ msgId: op.msgId, emoji: op.emoji, userId: meId });
        }
        bumpReactions();
      },
      onGiveUp: ({ tempId, reason }) => {
        setMsgs((prev) =>
          prev.map((m) => {
            if (m.tempId !== tempId) return m;
            return { ...m, status: "failed", failReason: reason };
          })
        );
      }
    });
  }, [realtimeUrl, token, meId]);

  useEffect(() => {
    saveSettings(meId, settings);
  }, [meId, settings]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (!e.key.startsWith(`nm:settings:${meId}`)) return;
      setSettings(loadSettings(meId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [meId]);

  useEffect(() => {
    let cancelled = false;
    setRestStatus("loading");

    void (async () => {
      try {
        const res = await fetch(`${realtimeUrl}/chat/${encodeURIComponent(chatId)}/messages?limit=50`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` }
        });
        if (cancelled) return;
        if (res.status === 401) {
          clearToken();
          clearCachedMe();
          router.replace("/login");
          return;
        }
        if (res.status === 403) {
          setRestStatus("forbidden");
          return;
        }
        if (!res.ok) {
          setRestStatus("unavailable");
          return;
        }

        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const items: MsgBroadcast[] = Array.isArray(data?.items) ? data.items : [];

        // Prime bounded dedup + cursor so sync/broadcast don't churn.
        rt.primeChatHistory(items);

        setMsgs((prev) => {
          const next = [...prev];
          for (const m of items) {
            if (!m?.msgId) continue;
            if (next.some((x) => x.msgId === m.msgId)) continue;
            next.push({
              key: m.msgId,
              msgId: m.msgId,
              chatId: m.chatId,
              text: m.text,
              from: m.from,
              clientTs: m.serverTs,
              serverTs: m.serverTs,
              status: "sent"
            });
          }
          return next;
        });
        setRestStatus("ok");
      } catch {
        if (!cancelled) setRestStatus("unavailable");
      }
    })();

    pushRecentChat(meId, chatId);
    return () => {
      cancelled = true;
      rt.setActiveChat(null);
      rt.close();
    };
  }, [rt, chatId, realtimeUrl, token, meId, router, restRetry]);

  useEffect(() => {
    if (restStatus !== "ok") return;
    rt.ensureConnected();
    let cancelled = false;
    void rt.joinChat(chatId).then(() => {
      if (cancelled) return;
      rt.setActiveChat(chatId);
      rt.syncChat(chatId);
      rt.syncReactions(chatId);
    });
    return () => {
      cancelled = true;
    };
  }, [restStatus, rt, chatId]);

  function onSend() {
    const trimmed = text.trim();
    if (!trimmed) return;

    const { tempId, clientTs } = rt.sendMessage(chatId, trimmed);
    setMsgs((prev) => [
      ...prev,
      { key: tempId, tempId, chatId, text: trimmed, from: meId, status: "pending", clientTs }
    ]);
    setText("");
  }

  const sorted = useMemo(() => {
    const copy = [...msgs];
    copy.sort((a, b) => {
      const aTs = a.status === "sent" ? a.serverTs ?? a.clientTs : a.clientTs;
      const bTs = b.status === "sent" ? b.serverTs ?? b.clientTs : b.clientTs;
      if (aTs !== bTs) return aTs - bTs;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return copy;
  }, [msgs]);

  function toggleReaction(msgId: string, emoji: string) {
    const mine = reactionsRef.current.hasMine(msgId, emoji, meId);
    if (mine) {
      const tempId = makeReactTempId();
      reactionsRef.current.remove({ msgId, emoji, userId: meId });
      bumpReactions();
      pendingReactRef.current.set(tempId, { msgId, emoji, op: "remove" });
      rt.removeReaction(msgId, emoji, tempId);
      return;
    }
    const tempId = makeReactTempId();
    reactionsRef.current.add({ msgId, emoji, userId: meId });
    bumpReactions();
    pendingReactRef.current.set(tempId, { msgId, emoji, op: "add" });
    rt.addReaction(msgId, emoji, tempId);
  }

  const quickEmojis = ["😀", "🔥", "❤️", "😭", "🎉", "🤝"];

  if (restStatus === "forbidden") {
    return (
      <div style={{ maxWidth: 720 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>No access</div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>You are not a member of this chat.</div>
      </div>
    );
  }

  if (restStatus === "unavailable") {
    return (
      <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Server unavailable</div>
        <button onClick={() => setRestRetry((x) => x + 1)} style={{ padding: "10px 14px", width: "fit-content" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>Chat {chatId}</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          socket: {rt.socket.connected ? "online" : "offline"} | queue: {rt.queueSize()}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          onClick={() =>
            setSettings((s) => {
              const next = { ...s, silentMode: !s.silentMode };
              void trackMetric({ apiBase: realtimeUrl, token, name: next.silentMode ? "silent_enabled" : "silent_disabled" });
              return next;
            })
          }
          style={{
            padding: "8px 12px",
            border: "1px solid #ddd",
            background: settings.silentMode ? "#111" : "#fff",
            color: settings.silentMode ? "#fff" : "#111"
          }}
        >
          Silent: {settings.silentMode ? "On" : "Off"}
        </button>

        <button
          onClick={() => setSettings((s) => toggleChatInFocus(s, chatId))}
          style={{
            padding: "8px 12px",
            border: "1px solid #ddd",
            background: settings.focusChats.includes(chatId) ? "#111" : "#fff",
            color: settings.focusChats.includes(chatId) ? "#fff" : "#111"
          }}
        >
          Focus: {settings.focusChats.includes(chatId) ? "Pinned" : "Pin"}
        </button>

        <div style={{ opacity: 0.7, fontSize: 12 }}>Silent mode collapses reactions.</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid #ddd" }}>
        {sorted.map((m) => {
          // Use `reactionsRev` to rerender when reactions change.
          void reactionsRev;
          const emojis = m.msgId ? reactionsRef.current.listEmojis(m.msgId) : [];
          const isOpen = m.msgId ? openReactions.has(m.msgId) : false;
          return (
          <div
            key={m.key}
            style={{
              opacity: m.status === "pending" ? 0.6 : 1,
              color: m.status === "failed" ? "#b00020" : "inherit"
            }}
          >
            <span style={{ fontWeight: 600 }}>{m.from}</span>
            <span style={{ marginLeft: 8 }}>{m.text}</span>
            {m.status === "pending" ? <span style={{ marginLeft: 8 }}>(sending)</span> : null}
            {m.status === "failed" ? (
              <span style={{ marginLeft: 8 }}>(failed: {m.failReason ?? "unknown"})</span>
            ) : null}

            {m.msgId ? (
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                {settings.silentMode && !isOpen ? (
                  <button
                    onClick={() =>
                      setOpenReactions((prev) => {
                        const next = new Set(prev);
                        next.add(m.msgId!);
                        return next;
                      })
                    }
                    style={{
                      border: "1px solid #ddd",
                      background: "#fff",
                      borderRadius: 999,
                      padding: "4px 10px",
                      lineHeight: "16px",
                      cursor: "pointer",
                      opacity: 0.9
                    }}
                  >
                    Show reactions{emojis.length > 0 ? " \u00b7" : ""}
                  </button>
                ) : null}

                {!settings.silentMode || isOpen
                  ? emojis.map((e) => {
                      const mine = reactionsRef.current.hasMine(m.msgId!, e, meId);
                      return (
                        <button
                          key={e}
                          onClick={() => toggleReaction(m.msgId!, e)}
                          style={{
                            border: "1px solid #ddd",
                            background: mine ? "#111" : "#fff",
                            color: mine ? "#fff" : "#111",
                            borderRadius: 999,
                            padding: "4px 8px",
                            lineHeight: "16px",
                            cursor: "pointer"
                          }}
                          aria-label={`react ${e}`}
                        >
                          {e}
                        </button>
                      );
                    })
                  : null}

                {!settings.silentMode || isOpen ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    {quickEmojis.map((e) => (
                      <button
                        key={`q_${e}`}
                        onClick={() => toggleReaction(m.msgId!, e)}
                        style={{
                          border: "1px dashed #ddd",
                          background: "#fff",
                          borderRadius: 999,
                          padding: "4px 8px",
                          lineHeight: "16px",
                          cursor: "pointer",
                          opacity: 0.85
                        }}
                        aria-label={`quick react ${e}`}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                ) : null}

                {settings.silentMode && isOpen ? (
                  <button
                    onClick={() =>
                      setOpenReactions((prev) => {
                        const next = new Set(prev);
                        next.delete(m.msgId!);
                        return next;
                      })
                    }
                    style={{
                      border: "1px solid #ddd",
                      background: "#fff",
                      borderRadius: 999,
                      padding: "4px 10px",
                      lineHeight: "16px",
                      cursor: "pointer",
                      opacity: 0.7
                    }}
                  >
                    Hide
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )})}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSend();
          }}
          placeholder="Message"
          style={{ flex: 1, padding: 10, border: "1px solid #ddd" }}
        />
        <button onClick={onSend} style={{ padding: "10px 14px" }}>
          Send
        </button>
      </div>
    </div>
  );
}
