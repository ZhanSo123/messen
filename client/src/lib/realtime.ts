import { io, type Socket } from "socket.io-client";
import type {
  MsgAck,
  MsgBroadcast,
  MsgError,
  MsgNew,
  MsgSyncReq,
  MsgSyncResp,
  PostAck,
  PostBroadcast,
  PostNew,
  PostVisibility,
  PostSyncReq,
  PostSyncResp,
  ReactionTargetType,
  ReactAck,
  ReactAddReq,
  ReactBroadcast,
  ReactRemoveReq,
  ReactSyncReq,
  ReactSyncResp
} from "./realtimeTypes";
import { MessageQueue } from "./messageQueue";
import { BoundedIdSet } from "./boundedIdSet";
import { PostQueue } from "./postQueue";

export type RealtimeClient = {
  socket: Socket;
  joinChat: (chatId: string) => Promise<boolean>;
  setActiveChat: (chatId: string | null) => void;
  syncChat: (chatId: string) => void;
  sendMessage: (chatId: string, text: string) => { tempId: string; clientTs: number };
  syncReactions: (chatId: string) => void; // message reactions
  syncPostReactions: () => void;
  addReaction: (msgId: string, emoji: string, tempId?: string) => void; // message target
  removeReaction: (msgId: string, emoji: string, tempId?: string) => void; // message target
  addPostReaction: (postId: string, emoji: string, tempId?: string) => void;
  removePostReaction: (postId: string, emoji: string, tempId?: string) => void;
  setFeedActive: (active: boolean) => void;
  syncPosts: () => void;
  createPost: (text: string, visibility: PostVisibility) => { tempId: string; clientTs: number };
  queueSize: () => number;
  close: () => void;
};

function makeTempId(): string {
  const now = Date.now();
  const rnd = Math.random().toString(16).slice(2);
  return `c_${now}_${rnd}`;
}

export function createRealtimeClient(opts: {
  url: string;
  token: string;
  onAck: (ack: MsgAck) => void;
  onBroadcast: (msg: MsgBroadcast) => void;
  onPostAck?: (ack: PostAck) => void;
  onPostBroadcast?: (post: PostBroadcast) => void;
  onReactBroadcast?: (evt: ReactBroadcast) => void;
  onReactRemoveBroadcast?: (evt: ReactBroadcast) => void;
  onReactSync?: (resp: ReactSyncResp) => void;
  onReactAck?: (ack: ReactAck) => void;
  onError?: (err: MsgError) => void;
  onGiveUp?: (info: { tempId: string; reason: string }) => void;
  onPostGiveUp?: (info: { tempId: string; reason: string }) => void;
}): RealtimeClient {
  const socket = io(opts.url, {
    transports: ["websocket"],
    auth: { token: opts.token },
    autoConnect: true,
    reconnection: true
  });

  const FEED_KEY = "feed";

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleFlushNow() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      queue.flushNow();
    }, 300);
  }

  let activeChatId: string | null = null;
  let feedActive = false;
  type Cursor = { ts: number; msgId: string | null };
  const chatCursor = new Map<string, Cursor>();
  const reactCursor = new Map<string, Cursor>(); // key: chatId for message, "feed" for posts
  const seenIds = new BoundedIdSet(20_000);
  const kMsg = (id: string) => `m:${id}`;
  const kPost = (id: string) => `p:${id}`;
  const kReact = (id: string) => `r:${id}`;
  const tempToChatId = new Map<string, string>();
  const tempToFeed = new Set<string>(); // post tempIds

  function getCursor(chatId: string): Cursor {
    let cur = chatCursor.get(chatId);
    if (!cur) {
      cur = { ts: 0, msgId: null };
      chatCursor.set(chatId, cur);
    }
    return cur;
  }

  function observeCursor(chatId: string, serverTs: number, msgId: string) {
    const cur = getCursor(chatId);
    if (serverTs > cur.ts) {
      cur.ts = serverTs;
      cur.msgId = msgId;
      return;
    }
    if (serverTs < cur.ts) return;

    const prevId = cur.msgId ?? "";
    if (msgId > prevId) cur.msgId = msgId;
  }

  function getReactCursor(chatId: string): Cursor {
    let cur = reactCursor.get(chatId);
    if (!cur) {
      cur = { ts: 0, msgId: null };
      reactCursor.set(chatId, cur);
    }
    return cur;
  }

  function observeReactCursor(chatId: string, serverTs: number, id: string) {
    const cur = getReactCursor(chatId);
    if (serverTs > cur.ts) {
      cur.ts = serverTs;
      cur.msgId = id;
      return;
    }
    if (serverTs < cur.ts) return;
    const prevId = cur.msgId ?? "";
    if (id > prevId) cur.msgId = id;
  }

  let recoverTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRecoverActiveChat() {
    if (!activeChatId) return;
    const chatId = activeChatId;
    if (recoverTimer) clearTimeout(recoverTimer);
    recoverTimer = setTimeout(() => {
      recoverTimer = null;
      if (!socket.connected) return;
      // Socket.IO rooms are not preserved across reconnects unless we re-join.
      socket.emit("chat:join", { chatId }, () => {});
      syncChat(chatId);
      syncReactions(chatId);
    }, 400);
  }

  let feedRecoverTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRecoverFeed() {
    if (!feedActive) return;
    if (feedRecoverTimer) clearTimeout(feedRecoverTimer);
    feedRecoverTimer = setTimeout(() => {
      feedRecoverTimer = null;
      if (!socket.connected) return;
      syncPosts();
      syncPostReactions();
      postQueue.flushNow();
    }, 450);
  }

  function handleAck(ack: MsgAck) {
    if (!ack?.tempId || !ack.msgId) return;
    const chatId = tempToChatId.get(ack.tempId);
    const removed = queue.markAcked(ack.tempId);
    if (!removed) return;
    if (chatId) {
      observeCursor(chatId, ack.serverTs, ack.msgId);
      seenIds.add(kMsg(ack.msgId));
      tempToChatId.delete(ack.tempId);
    }
    opts.onAck(ack);
  }

  function handlePostAck(ack: PostAck) {
    if (!ack?.tempId || !ack.postId) return;
    const removed = postQueue.markAcked(ack.tempId);
    if (!removed) return;
    tempToFeed.delete(ack.tempId);
    // Cursor for feed posts.
    observeCursor(FEED_KEY, ack.serverTs, ack.postId);
    seenIds.add(kPost(ack.postId));
    opts.onPostAck?.(ack);
  }

  const queue = new MessageQueue({
    socket,
    onAck: handleAck,
    onGiveUp: (info) => {
      tempToChatId.delete(info.tempId);
      opts.onGiveUp?.(info);
    }
  });

  const postQueue = new PostQueue({
    socket,
    onAck: handlePostAck,
    onGiveUp: (info) => {
      tempToFeed.delete(info.tempId);
      opts.onPostGiveUp?.(info);
    }
  });

  socket.on("connect", () => scheduleFlushNow());
  socket.io.on("reconnect", () => scheduleFlushNow());
  socket.on("connect", () => scheduleRecoverActiveChat());
  socket.io.on("reconnect", () => scheduleRecoverActiveChat());
  socket.on("connect", () => scheduleRecoverFeed());
  socket.io.on("reconnect", () => scheduleRecoverFeed());

  socket.on("msg:ack", (ack: MsgAck) => {
    handleAck(ack);
  });

  socket.on("post:ack", (ack: PostAck) => {
    handlePostAck(ack);
  });

  socket.on("msg:broadcast", (msg: MsgBroadcast) => {
    if (!msg?.msgId) return;
    if (seenIds.has(kMsg(msg.msgId))) return;
    seenIds.add(kMsg(msg.msgId));
    observeCursor(msg.chatId, msg.serverTs, msg.msgId);
    opts.onBroadcast(msg);
  });

  socket.on("post:broadcast", (post: PostBroadcast) => {
    if (!post?.postId) return;
    if (seenIds.has(kPost(post.postId))) return;
    seenIds.add(kPost(post.postId));
    observeCursor(FEED_KEY, post.serverTs, post.postId);
    opts.onPostBroadcast?.(post);
  });

  socket.on("msg:sync:resp", (resp: MsgSyncResp) => {
    const chatId = resp?.chatId;
    const items = resp?.items;
    if (typeof chatId !== "string" || !Array.isArray(items)) return;

    for (const it of items) {
      if (!it?.msgId) continue;
      if (seenIds.has(kMsg(it.msgId))) continue;
      seenIds.add(kMsg(it.msgId));
      observeCursor(it.chatId, it.serverTs, it.msgId);
      // Reuse the same UI path as broadcasts (same payload shape).
      opts.onBroadcast({
        msgId: it.msgId,
        chatId: it.chatId,
        from: it.from,
        text: it.text,
        serverTs: it.serverTs
      });
    }

    // After messages are synced in the active chat, sync reactions too.
    if (activeChatId && chatId === activeChatId) {
      syncReactions(chatId);
    }
  });

  socket.on("post:sync:resp", (resp: PostSyncResp) => {
    const items = resp?.items;
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!it?.postId) continue;
      if (seenIds.has(kPost(it.postId))) continue;
      seenIds.add(kPost(it.postId));
      observeCursor(FEED_KEY, it.serverTs, it.postId);
      opts.onPostBroadcast?.(it);
    }
    if (feedActive) syncPostReactions();
  });

  socket.on("msg:error", (err: MsgError) => {
    opts.onError?.(err);
    const tempId = err?.tempId;
    if (!tempId) return;

    if (err.reason === "rate_limited") {
      if (tempToFeed.has(tempId)) {
        postQueue.forgiveAttempt(tempId);
        postQueue.delay(tempId, 2000);
      } else {
        queue.forgiveAttempt(tempId);
        queue.delay(tempId, 2000);
      }
      return;
    }

    if (tempToFeed.has(tempId)) postQueue.fail(tempId, err.reason);
    else queue.fail(tempId, err.reason);
  });

  socket.on("react:broadcast", (evt: ReactBroadcast) => {
    if (!evt?.targetId || !evt.emoji || !evt.userId) return;
    if (evt.id && seenIds.has(kReact(evt.id))) return;
    if (evt.id) seenIds.add(kReact(evt.id));

    if (evt.targetType === "message" && activeChatId && typeof evt.serverTs === "number" && typeof evt.id === "string") {
      observeReactCursor(activeChatId, evt.serverTs, evt.id);
    }
    if (evt.targetType === "post" && feedActive && typeof evt.serverTs === "number" && typeof evt.id === "string") {
      observeReactCursor(FEED_KEY, evt.serverTs, evt.id);
    }
    opts.onReactBroadcast?.(evt);
  });

  socket.on("react:remove:broadcast", (evt: ReactBroadcast) => {
    if (!evt?.targetId || !evt.emoji || !evt.userId) return;
    opts.onReactRemoveBroadcast?.(evt);
  });

  socket.on("react:ack", (ack: ReactAck) => {
    if (!ack?.targetId || !ack.emoji) return;
    opts.onReactAck?.(ack);
  });

  socket.on("react:sync:resp", (resp: ReactSyncResp) => {
    if (!resp?.targetType || !Array.isArray(resp.items)) return;

    const last = resp.items[resp.items.length - 1];
    if (last && typeof last.serverTs === "number" && typeof last.id === "string") {
      if (resp.targetType === "message" && resp.chatId) observeReactCursor(resp.chatId, last.serverTs, last.id);
      if (resp.targetType === "post") observeReactCursor(FEED_KEY, last.serverTs, last.id);
    }

    const freshItems = resp.items.filter((it) => {
      if (!it?.id) return false;
      if (seenIds.has(kReact(it.id))) return false;
      seenIds.add(kReact(it.id));
      return true;
    });
    if (freshItems.length === 0) return;
    opts.onReactSync?.({ ...resp, items: freshItems });
  });

  function setActiveChat(chatId: string | null) {
    activeChatId = chatId;
  }

  function setFeedActive(active: boolean) {
    feedActive = active;
    if (feedActive) {
      syncPosts();
      syncPostReactions();
      postQueue.flushNow();
    }
  }

  async function joinChat(chatId: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      socket.emit("chat:join", { chatId }, (res: { ok: true } | { ok: false } | undefined) => {
        const ok = Boolean(res?.ok);
        resolve(ok);
      });
    });
  }

  function syncChat(chatId: string) {
    const cur = getCursor(chatId);
    const req: MsgSyncReq = {
      chatId,
      afterServerTs: cur.ts,
      ...(cur.msgId ? { afterMsgId: cur.msgId } : {})
    };
    socket.emit("msg:sync", req);
  }

  function syncReactions(chatId: string) {
    const cur = getReactCursor(chatId);
    const req: ReactSyncReq = {
      targetType: "message",
      chatId,
      afterServerTs: cur.ts,
      ...(cur.msgId ? { afterId: cur.msgId } : {})
    };
    socket.emit("react:sync", req);
  }

  function syncPostReactions() {
    const cur = getReactCursor(FEED_KEY);
    const req: ReactSyncReq = {
      targetType: "post",
      afterServerTs: cur.ts,
      ...(cur.msgId ? { afterId: cur.msgId } : {})
    };
    socket.emit("react:sync", req);
  }

  function syncPosts() {
    const cur = getCursor(FEED_KEY);
    const req: PostSyncReq = {
      afterServerTs: cur.ts,
      ...(cur.msgId ? { afterId: cur.msgId } : {})
    };
    socket.emit("post:sync", req);
  }

  function sendMessage(chatId: string, text: string) {
    const tempId = makeTempId();
    const clientTs = Date.now();
    const msg: MsgNew = { tempId, chatId, text, clientTs };
    tempToChatId.set(tempId, chatId);
    queue.enqueue(msg);
    queue.flushNow(); // optimistic send now; retry loop will take over if offline
    return { tempId, clientTs };
  }

  function addReaction(msgId: string, emoji: string, tempId?: string) {
    const payload: ReactAddReq = { targetType: "message", targetId: msgId, emoji, ...(tempId ? { tempId } : {}) };
    socket.emit("react:add", payload);
  }

  function removeReaction(msgId: string, emoji: string, tempId?: string) {
    const payload: ReactRemoveReq = { targetType: "message", targetId: msgId, emoji, ...(tempId ? { tempId } : {}) };
    socket.emit("react:remove", payload);
  }

  function addPostReaction(postId: string, emoji: string, tempId?: string) {
    const payload: ReactAddReq = { targetType: "post", targetId: postId, emoji, ...(tempId ? { tempId } : {}) };
    socket.emit("react:add", payload);
  }

  function removePostReaction(postId: string, emoji: string, tempId?: string) {
    const payload: ReactRemoveReq = { targetType: "post", targetId: postId, emoji, ...(tempId ? { tempId } : {}) };
    socket.emit("react:remove", payload);
  }

  function createPost(text: string, visibility: PostVisibility) {
    const tempId = makeTempId();
    const clientTs = Date.now();
    const post: PostNew = { tempId, text, clientTs, visibility };
    tempToFeed.add(tempId);
    postQueue.enqueue(post);
    postQueue.flushNow();
    return { tempId, clientTs };
  }

  return {
    socket,
    joinChat,
    setActiveChat,
    syncChat,
    sendMessage,
    syncReactions,
    syncPostReactions,
    addReaction,
    removeReaction,
    addPostReaction,
    removePostReaction,
    setFeedActive,
    syncPosts,
    createPost,
    queueSize: () => queue.size() + postQueue.size(),
    close: () => {
      if (flushTimer) clearTimeout(flushTimer);
      if (recoverTimer) clearTimeout(recoverTimer);
      if (feedRecoverTimer) clearTimeout(feedRecoverTimer);
      socket.close();
    }
  };
}
