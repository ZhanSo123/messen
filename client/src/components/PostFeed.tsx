"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PostAck, PostBroadcast, PostVisibility } from "../lib/realtimeTypes";
import { createRealtimeClient } from "../lib/realtime";
import { ReactionStore } from "../lib/reactionStore";
import { clearCachedMe, clearToken } from "../lib/auth";

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
  const router = useRouter();
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<PostVisibility>("PUBLIC");
  const [posts, setPosts] = useState<UiPost[]>([]);
  const [restStatus, setRestStatus] = useState<"loading" | "ok" | "forbidden" | "unavailable">("loading");
  const [restRetry, setRestRetry] = useState(0);

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
      autoConnect: false,
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
    let cancelled = false;
    setRestStatus("loading");

    void (async () => {
      try {
        const res = await fetch(`${realtimeUrl}/feed?limit=50`, {
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
        const items: PostBroadcast[] = Array.isArray(data?.items) ? data.items : [];

        rt.primeFeedHistory(items);

        setPosts((prev) => {
          const next = [...prev];
          for (const p of items) {
            if (!p?.postId) continue;
            if (next.some((x) => x.postId === p.postId)) continue;
            next.push({
              key: p.postId,
              postId: p.postId,
              authorId: p.authorId,
              text: p.text,
              visibility: p.visibility,
              clientTs: p.serverTs,
              serverTs: p.serverTs,
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

    return () => {
      cancelled = true;
    };
  }, [rt, realtimeUrl, token, router, restRetry]);

  useEffect(() => {
    if (restStatus !== "ok") return;
    rt.ensureConnected();
    rt.setFeedActive(true);
    return () => {
      rt.setFeedActive(false);
      rt.close();
    };
  }, [rt, restStatus]);

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

  if (restStatus === "forbidden") {
    return (
      <div style={{ background: "var(--q-surface2)", border: "1px solid var(--q-divider)", borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 750, fontSize: 16 }}>No access</div>
        <div className="nm-muted" style={{ fontSize: 13 }}>
          You are not allowed to view the feed.
        </div>
      </div>
    );
  }

  if (restStatus === "unavailable") {
    return (
      <div style={{ background: "var(--q-surface2)", border: "1px solid var(--q-divider)", borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 750, fontSize: 16 }}>Server unavailable</div>
        <div className="nm-muted" style={{ fontSize: 13 }}>
          Check that the realtime server is running, then retry.
        </div>
        <button className="nm-btn nm-tap" onClick={() => setRestRetry((x) => x + 1)} style={{ width: "fit-content" }}>
          Retry
        </button>
      </div>
    );
  }

  const showSkeletons = restStatus === "loading" && posts.length === 0;

  return (
    <div className="nm-stack">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Posts</div>
        <div className="nm-muted" style={{ fontSize: 12 }}>
          No likes. Just reactions.
        </div>
      </div>

      <div className="tg-post">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className={`nm-pill nm-tap${visibility === "PUBLIC" ? " is-active" : ""}`}
            onClick={() => setVisibility("PUBLIC")}
            type="button"
            aria-label="Set Public"
          >
            Public
          </button>
          <button
            className={`nm-pill nm-tap${visibility === "PRIVATE" ? " is-active" : ""}`}
            onClick={() => setVisibility("PRIVATE")}
            type="button"
            aria-label="Set Private"
          >
            Private
          </button>
          <div className="nm-muted" style={{ fontSize: 12 }}>
            Quiet thoughts, minimal noise.
          </div>
          <div style={{ flex: 1 }} />
          <button className="nm-icon-btn nm-tap" onClick={onPost} aria-label="Post" type="button" disabled={!text.trim()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3.5 11.5 21 3.8l-7.7 17.7-2.7-7-7.1-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M10.6 14.5 21 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div style={{ marginTop: 10 }}>
          <input
            className="nm-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onPost();
            }}
            placeholder="Write a post…"
            aria-label="Post text"
          />
        </div>
      </div>

      {restStatus === "ok" && sorted.length === 0 ? (
        <div className="tg-post">
          <div style={{ fontWeight: 750, marginBottom: 6 }}>Helper</div>
          <div className="nm-muted" style={{ fontSize: 13 }}>
            Write a thought. Use <span style={{ color: "rgba(246,242,235,0.9)", fontWeight: 700 }}>Private</span> for yourself, or{" "}
            <span style={{ color: "rgba(246,242,235,0.9)", fontWeight: 700 }}>Public</span> to share.
          </div>
        </div>
      ) : null}

      <div className="nm-stack" style={{ gap: 10 }}>
        {showSkeletons
          ? Array.from({ length: 7 }).map((_, i) => (
              <div key={`sk_${i}`} className="tg-post">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                  <div className="nm-skeleton" style={{ height: 12, width: 92, borderRadius: 999 }} />
                  <div className="nm-skeleton" style={{ height: 10, width: 56, borderRadius: 999, opacity: 0.8 }} />
                </div>
                <div className="nm-skeleton" style={{ height: 14, width: `${72 + (i % 3) * 8}%`, marginTop: 10 }} />
                <div className="nm-skeleton" style={{ height: 14, width: `${46 + (i % 4) * 10}%`, marginTop: 8, opacity: 0.75 }} />
                <div className="nm-skeleton" style={{ height: 14, width: `${62 + (i % 5) * 6}%`, marginTop: 8, opacity: 0.7 }} />
              </div>
            ))
          : sorted.map((p) => {
              void reactionsRev;
              const isMine = p.authorId === meId;
              const emojis = p.postId ? reactionsRef.current.listEmojis(p.postId) : [];
              const isOpen = p.postId ? openReactions.has(p.postId) : false;
              const expanded = !silentMode || isOpen;

              return (
                <div
                  key={p.key}
                  className="tg-post"
                  style={{
                    opacity: p.status === "pending" ? 0.72 : 1,
                    borderColor: isMine ? "rgba(42, 171, 238, 0.22)" : undefined
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 750 }}>{isMine ? "You" : p.authorId}</div>
                      {p.visibility === "PRIVATE" ? (
                        <div className="nm-muted" style={{ fontSize: 12 }}>
                          Private
                        </div>
                      ) : null}
                    </div>
                    {p.status === "pending" ? (
                      <div className="nm-muted" style={{ fontSize: 12 }}>
                        posting…
                      </div>
                    ) : null}
                    {p.status === "failed" ? (
                      <div style={{ color: "var(--nm-danger)", fontSize: 12 }}>failed</div>
                    ) : null}
                  </div>

                  <div className="nm-msg-text" style={{ marginTop: 10 }}>
                    {p.text}
                  </div>

                  {p.status === "failed" ? (
                    <div className="nm-muted" style={{ fontSize: 12, marginTop: 8 }}>
                      {p.failReason ? `Reason: ${p.failReason}` : "Try again after reconnect."}
                    </div>
                  ) : null}

                  {p.postId ? (
                    <div className="nm-reactions-row">
                      {silentMode && !isOpen ? (
                        <button
                          className="nm-pill nm-tap"
                          onClick={() =>
                            setOpenReactions((prev) => {
                              const next = new Set(prev);
                              next.add(p.postId!);
                              return next;
                            })
                          }
                          type="button"
                          aria-label="Show reactions"
                        >
                          Show reactions{emojis.length > 0 ? " \u00b7" : ""}
                        </button>
                      ) : null}

                      <div className={`nm-collapsible${expanded ? " is-open" : ""}`}>
                        <div className="nm-reactions-row" style={{ marginTop: 0 }}>
                          {emojis.map((e) => {
                            const mine = reactionsRef.current.hasMine(p.postId!, e, meId);
                            return (
                              <button
                                key={e}
                                className={`nm-emoji-pill nm-tap${mine ? " is-mine" : ""}`}
                                onClick={() => toggleReaction(p.postId!, e)}
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
                                  className="nm-emoji-pill nm-tap"
                                  onClick={() => toggleReaction(p.postId!, e)}
                                  aria-label={`quick react ${e}`}
                                  type="button"
                                  style={{ opacity: 0.92, borderStyle: "dashed" }}
                                >
                                  {e}
                                </button>
                              ))}
                            </div>
                          ) : null}

                          {silentMode && isOpen ? (
                            <button
                              className="nm-pill nm-tap"
                              onClick={() =>
                                setOpenReactions((prev) => {
                                  const next = new Set(prev);
                                  next.delete(p.postId!);
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
              );
            })}
      </div>
    </div>
  );
}
