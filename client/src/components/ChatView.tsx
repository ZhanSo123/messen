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
  const motionHydratedRef = useRef(false);
  const motionSeenRef = useRef<Set<string>>(new Set());
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
        // Prevent a second "new item" animation when tempId -> msgId swaps keys.
        motionSeenRef.current.add(ack.msgId);
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
    if (restStatus !== "ok") return;
    motionHydratedRef.current = true;
    for (const m of msgs) {
      const id = m.msgId ?? m.tempId ?? m.key;
      motionSeenRef.current.add(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restStatus]);

  useEffect(() => {
    if (!motionHydratedRef.current) return;
    for (const m of msgs) {
      const id = m.msgId ?? m.tempId ?? m.key;
      motionSeenRef.current.add(id);
    }
  }, [msgs]);

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
      <div className="nm-content nm-fadeIn">
        <div style={{ background: "var(--q-surface2)", border: "1px solid var(--q-divider)", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 750, fontSize: 16 }}>No access</div>
          <div className="nm-muted" style={{ fontSize: 13 }}>
            You are not a member of this chat.
          </div>
        </div>
      </div>
    );
  }

  if (restStatus === "unavailable") {
    return (
      <div className="nm-content nm-fadeIn">
        <div style={{ background: "var(--q-surface2)", border: "1px solid var(--q-divider)", borderRadius: 12, padding: 12 }}>
          <div style={{ fontWeight: 750, fontSize: 16 }}>Server unavailable</div>
          <div className="nm-muted" style={{ fontSize: 13 }}>
            Check that the realtime server is running, then retry.
          </div>
          <button className="nm-btn nm-tap m-press" onClick={() => setRestRetry((x) => x + 1)} style={{ width: "fit-content" }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const showSkeletons = restStatus === "loading" && msgs.length === 0;

  function fmtTime(ts: number | undefined): string | null {
    if (!ts) return null;
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return null;
    }
  }

  return (
    <div className="nm-content nm-chat nm-stack nm-fadeIn">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontWeight: 750, fontSize: 18 }}>Chat {chatId}</div>
        <div className="nm-muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {rt.socket.connected ? "online" : "offline"} · queue {rt.queueSize()}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className={`nm-pill nm-tap m-press${settings.silentMode ? " is-active" : ""}`}
          onClick={() =>
            setSettings((s) => {
              const next = { ...s, silentMode: !s.silentMode };
              void trackMetric({ apiBase: realtimeUrl, token, name: next.silentMode ? "silent_enabled" : "silent_disabled" });
              return next;
            })
          }
          aria-label="Toggle Silent Mode"
          type="button"
        >
          Silent
        </button>

        <button
          className={`nm-pill nm-tap m-press${settings.focusChats.includes(chatId) ? " is-active" : ""}`}
          onClick={() => setSettings((s) => toggleChatInFocus(s, chatId))}
          aria-label="Toggle Focus Pin"
          type="button"
        >
          {settings.focusChats.includes(chatId) ? "Pinned" : "Pin"}
        </button>

        <div className="nm-muted" style={{ fontSize: 12 }}>
          Quiet reactions. No counters.
        </div>
      </div>

      <div className={`nm-chat-list${!showSkeletons && restStatus === "ok" ? " m-swap" : ""}`}>
        {showSkeletons
          ? Array.from({ length: 7 }).map((_, i) => (
              <div key={`sk_${i}`} className="tg-msg-row">
                <div className="nm-msg">
                <div className="nm-msg-meta">
                  <div className="nm-skeleton" style={{ height: 12, width: 88, borderRadius: 999 }} />
                  <div className="nm-skeleton" style={{ height: 10, width: 56, borderRadius: 999, opacity: 0.8 }} />
                </div>
                <div className="nm-skeleton" style={{ height: 14, width: `${70 + (i % 3) * 10}%` }} />
                <div className="nm-skeleton" style={{ height: 14, width: `${45 + (i % 4) * 9}%`, marginTop: 8, opacity: 0.75 }} />
                </div>
              </div>
            ))
          : sorted.map((m) => {
              // Use `reactionsRev` to rerender when reactions change.
              void reactionsRev;
              const isMine = m.from === meId;
              const emojis = m.msgId ? reactionsRef.current.listEmojis(m.msgId) : [];
              const isOpen = m.msgId ? openReactions.has(m.msgId) : false;
              const expanded = !settings.silentMode || isOpen;
              const ts = m.status === "sent" ? (m.serverTs ?? m.clientTs) : m.clientTs;
              const time = fmtTime(ts);
              const animId = m.msgId ?? m.tempId ?? m.key;
              const animate = motionHydratedRef.current && !motionSeenRef.current.has(animId);

              return (
                <div key={m.key} className={`tg-msg-row${isMine ? " is-mine" : ""}`}>
                  <div
                    className={`nm-msg${isMine ? " is-mine" : ""}${m.status === "pending" ? " is-pending" : ""}${
                      m.status === "failed" ? " is-failed" : ""
                    }${animate ? " m-fade-up" : ""}`}
                  >
                  <div className="nm-msg-meta">
                    <div className="nm-msg-from">{isMine ? "You" : m.from}</div>
                    <div>
                      {m.status === "pending" ? "sending…" : null}
                      {m.status === "failed" ? <span style={{ color: "rgba(255,120,120,0.95)" }}>failed</span> : null}
                      {m.status === "sent" && time ? <span className="nm-muted">{time}</span> : null}
                    </div>
                  </div>

                  <div className="nm-msg-text">{m.text}</div>

                  {m.status === "failed" ? (
                    <div className="nm-muted" style={{ fontSize: 12, marginTop: 8 }}>
                      {m.failReason ? `Reason: ${m.failReason}` : "Tap Send again after reconnect."}
                    </div>
                  ) : null}

                  {m.msgId ? (
                    <div className="nm-reactions-row">
                      {settings.silentMode && !isOpen ? (
                        <button
                          className="nm-pill nm-tap m-press"
                          onClick={() =>
                            setOpenReactions((prev) => {
                              const next = new Set(prev);
                              next.add(m.msgId!);
                              return next;
                            })
                          }
                          type="button"
                          aria-label="Show reactions"
                        >
                          Show reactions{emojis.length > 0 ? " \u00b7" : ""}
                        </button>
                      ) : null}

                      <div className={`m-collapsible${expanded ? " is-open" : ""}`}>
                        <div className="nm-reactions-row" style={{ marginTop: 0 }}>
                          {emojis.map((e) => {
                            const mine = reactionsRef.current.hasMine(m.msgId!, e, meId);
                            return (
                              <button
                                key={e}
                                className={`nm-emoji-pill nm-tap m-press${mine ? " is-mine" : ""}`}
                                onClick={() => toggleReaction(m.msgId!, e)}
                                aria-label={`react ${e}`}
                                type="button"
                              >
                                {e}
                              </button>
                            );
                          })}

                          {expanded ? (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {quickEmojis.map((e) => (
                                <button
                                  key={`q_${e}`}
                                  className="nm-emoji-pill nm-tap m-press"
                                  onClick={() => toggleReaction(m.msgId!, e)}
                                  aria-label={`quick react ${e}`}
                                  type="button"
                                  style={{ opacity: 0.92, borderStyle: "dashed" }}
                                >
                                  {e}
                                </button>
                              ))}
                            </div>
                          ) : null}

                          {settings.silentMode && isOpen ? (
                            <button
                              className="nm-pill nm-tap m-press"
                              onClick={() =>
                                setOpenReactions((prev) => {
                                  const next = new Set(prev);
                                  next.delete(m.msgId!);
                                  return next;
                                })
                              }
                              type="button"
                              aria-label="Hide reactions"
                              style={{ opacity: 0.85 }}
                            >
                              Hide
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  </div>
                </div>
              );
            })}
      </div>

      <div className="nm-composer-wrap" aria-label="Message composer">
        <div className="nm-composer">
          <input
            className="nm-input nm-composer-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSend();
            }}
            placeholder="Write quietly…"
            aria-label="Message"
          />
          <button
            className="nm-icon-btn nm-tap m-press"
            onClick={onSend}
            disabled={!text.trim()}
            aria-label="Send"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3.5 11.5 21 3.8l-7.7 17.7-2.7-7-7.1-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M10.6 14.5 21 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
