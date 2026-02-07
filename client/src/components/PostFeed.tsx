"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PostAck, PostBroadcast, PostVisibility } from "../lib/realtimeTypes";
import { createRealtimeClient } from "../lib/realtime";
import { ReactionStore } from "../lib/reactionStore";

type UiPost = {
  key: string; // tempId or postId
  postId?: string;
  tempId?: string;
  authorId: string;
  text: string;
  visibility: PostVisibility;
  clientTs: number;
  serverTs?: number;
  status: "pending" | "sent" | "failed";
  failReason?: string;
};

function makeReactTempId(): string {
  const now = Date.now();
  const rnd = Math.random().toString(16).slice(2);
  return `r_${now}_${rnd}`;
}

export function PostFeed(props: { token: string; meId: string; realtimeUrl: string; silentMode: boolean }) {
  const { token, meId, realtimeUrl, silentMode } = props;
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<PostVisibility>("PUBLIC");
  const [posts, setPosts] = useState<UiPost[]>([]);

  const reactionsRef = useRef(new ReactionStore());
  const [reactionsRev, setReactionsRev] = useState(0);
  const bumpReactions = () => setReactionsRev((x) => x + 1);
  const pendingReactRef = useRef(new Map<string, { targetId: string; emoji: string; op: "add" | "remove" }>());
  const [openReactions, setOpenReactions] = useState<Set<string>>(() => new Set());

  const quickEmojis = ["😀", "🔥", "❤️", "😭", "🎉", "🤝"];

  const rt = useMemo(() => {
    return createRealtimeClient({
      url: realtimeUrl,
      token,
      onAck: () => {},
      onBroadcast: () => {},
      onPostAck: (ack: PostAck) => {
        setPosts((prev) => {
          if (prev.some((p) => p.postId === ack.postId)) return prev.filter((p) => p.tempId !== ack.tempId);
          return prev.map((p) => {
            if (p.tempId !== ack.tempId) return p;
            return { ...p, status: "sent", postId: ack.postId, key: ack.postId, serverTs: ack.serverTs };
          });
        });
      },
      onPostBroadcast: (p: PostBroadcast) => {
        setPosts((prev) => {
          if (prev.some((x) => x.postId === p.postId)) return prev;
          return [
            ...prev,
            {
              key: p.postId,
              postId: p.postId,
              authorId: p.authorId,
              text: p.text,
              visibility: p.visibility,
              clientTs: p.serverTs,
              serverTs: p.serverTs,
              status: "sent"
            }
          ];
        });
      },
      onPostGiveUp: ({ tempId, reason }) => {
        setPosts((prev) =>
          prev.map((p) => {
            if (p.tempId !== tempId) return p;
            return { ...p, status: "failed", failReason: reason };
          })
        );
      },
      onReactBroadcast: (evt) => {
        if (evt.targetType !== "post") return;
        reactionsRef.current.add({ msgId: evt.targetId, emoji: evt.emoji, userId: evt.userId });
        bumpReactions();
      },
      onReactRemoveBroadcast: (evt) => {
        if (evt.targetType !== "post") return;
        reactionsRef.current.remove({ msgId: evt.targetId, emoji: evt.emoji, userId: evt.userId });
        bumpReactions();
      },
      onReactSync: (resp) => {
        if (resp.targetType !== "post") return;
        for (const it of resp.items) reactionsRef.current.add({ msgId: it.targetId, emoji: it.emoji, userId: it.userId });
        bumpReactions();
      },
      onReactAck: (ack) => {
        if (!ack?.tempId) return;
        pendingReactRef.current.delete(ack.tempId);
      },
      onError: (err) => {
        const tempId = err?.tempId;
        if (!tempId || !tempId.startsWith("r_")) return;
        const op = pendingReactRef.current.get(tempId);
        if (!op) return;
        pendingReactRef.current.delete(tempId);

        if (op.op === "add") {
          reactionsRef.current.remove({ msgId: op.targetId, emoji: op.emoji, userId: meId });
        } else {
          reactionsRef.current.add({ msgId: op.targetId, emoji: op.emoji, userId: meId });
        }
        bumpReactions();
      }
    });
  }, [realtimeUrl, token, meId]);

  useEffect(() => {
    rt.setFeedActive(true);
    return () => {
      rt.setFeedActive(false);
      rt.close();
    };
  }, [rt]);

  function onPost() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { tempId, clientTs } = rt.createPost(trimmed, visibility);
    setPosts((prev) => [
      ...prev,
      { key: tempId, tempId, authorId: meId, text: trimmed, visibility, clientTs, status: "pending" }
    ]);
    setText("");
  }

  function toggleReaction(targetId: string, emoji: string) {
    const mine = reactionsRef.current.hasMine(targetId, emoji, meId);
    if (mine) {
      const tempId = makeReactTempId();
      reactionsRef.current.remove({ msgId: targetId, emoji, userId: meId });
      bumpReactions();
      pendingReactRef.current.set(tempId, { targetId, emoji, op: "remove" });
      rt.removePostReaction(targetId, emoji, tempId);
      return;
    }
    const tempId = makeReactTempId();
    reactionsRef.current.add({ msgId: targetId, emoji, userId: meId });
    bumpReactions();
    pendingReactRef.current.set(tempId, { targetId, emoji, op: "add" });
    rt.addPostReaction(targetId, emoji, tempId);
  }

  const sorted = useMemo(() => {
    const copy = [...posts];
    copy.sort((a, b) => {
      const aTs = a.status === "sent" ? a.serverTs ?? a.clientTs : a.clientTs;
      const bTs = b.status === "sent" ? b.serverTs ?? b.clientTs : b.clientTs;
      if (aTs !== bTs) return bTs - aTs; // feed: newest first
      return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
    });
    return copy;
  }, [posts]);

  return (
    <div style={{ border: "1px solid #ddd", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 800 }}>Posts</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>No likes. Just reactions.</div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => setVisibility((v) => (v === "PUBLIC" ? "PRIVATE" : "PUBLIC"))}
          style={{
            padding: "10px 12px",
            border: "1px solid #ddd",
            background: visibility === "PRIVATE" ? "#111" : "#fff",
            color: visibility === "PRIVATE" ? "#fff" : "#111"
          }}
        >
          {visibility}
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onPost();
          }}
          placeholder="A thought"
          style={{ flex: 1, padding: 10, border: "1px solid #ddd" }}
        />
        <button onClick={onPost} style={{ padding: "10px 14px" }}>
          Post
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.map((p) => {
          void reactionsRev;
          const emojis = p.postId ? reactionsRef.current.listEmojis(p.postId) : [];
          const isOpen = p.postId ? openReactions.has(p.postId) : false;

          return (
            <div
              key={p.key}
              style={{
                border: "1px solid #eee",
                padding: 10,
                opacity: p.status === "pending" ? 0.65 : 1,
                color: p.status === "failed" ? "#b00020" : "inherit"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <div style={{ fontWeight: 650 }}>{p.authorId}</div>
                  {p.visibility === "PRIVATE" ? <div style={{ opacity: 0.8, fontSize: 12 }}>Private</div> : null}
                </div>
                {p.status === "pending" ? <div style={{ opacity: 0.7, fontSize: 12 }}>(posting)</div> : null}
                {p.status === "failed" ? (
                  <div style={{ opacity: 0.9, fontSize: 12 }}>(failed: {p.failReason ?? "unknown"})</div>
                ) : null}
              </div>
              <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{p.text}</div>

              {p.postId ? (
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {silentMode && !isOpen ? (
                    <button
                      onClick={() =>
                        setOpenReactions((prev) => {
                          const next = new Set(prev);
                          next.add(p.postId!);
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

                  {!silentMode || isOpen
                    ? emojis.map((e) => {
                        const mine = reactionsRef.current.hasMine(p.postId!, e, meId);
                        return (
                          <button
                            key={e}
                            onClick={() => toggleReaction(p.postId!, e)}
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

                  {!silentMode || isOpen ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      {quickEmojis.map((e) => (
                        <button
                          key={`q_${e}`}
                          onClick={() => toggleReaction(p.postId!, e)}
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

                  {silentMode && isOpen ? (
                    <button
                      onClick={() =>
                        setOpenReactions((prev) => {
                          const next = new Set(prev);
                          next.delete(p.postId!);
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
          );
        })}
      </div>
    </div>
  );
}
