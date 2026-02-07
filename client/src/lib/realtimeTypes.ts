export type MsgNew = {
  tempId: string;
  chatId: string;
  text: string;
  clientTs: number;
};

export type MsgAck = {
  tempId: string;
  msgId: string;
  serverTs: number;
};

export type MsgBroadcast = {
  msgId: string;
  chatId: string;
  from: string;
  text: string;
  serverTs: number;
};

export type MsgError = {
  tempId?: string;
  chatId?: string;
  scope?: "feed";
  reason: "invalid_payload" | "not_found" | "forbidden" | "rate_limited" | "tempid_conflict" | "server_error";
};

export type MsgSyncReq = {
  chatId: string;
  afterServerTs: number;
  afterMsgId?: string;
};

export type MsgSyncResp = {
  chatId: string;
  items: Array<{
    msgId: string;
    chatId: string;
    from: string;
    text: string;
    serverTs: number;
  }>;
};

export type PostVisibility = "PUBLIC" | "PRIVATE";
export type PostNew = { tempId: string; text: string; clientTs: number; visibility: PostVisibility };
export type PostAck = { tempId: string; postId: string; serverTs: number };
export type PostBroadcast = { postId: string; authorId: string; text: string; serverTs: number; visibility: PostVisibility };
export type PostSyncReq = { afterServerTs: number; afterId?: string };
export type PostSyncResp = { items: PostBroadcast[] };

export type ReactionTargetType = "message" | "post";

export type ReactAddReq = { targetType: ReactionTargetType; targetId: string; emoji: string; tempId?: string };
export type ReactRemoveReq = { targetType: ReactionTargetType; targetId: string; emoji: string; tempId?: string };
export type ReactAck = { targetType: ReactionTargetType; targetId: string; emoji: string; tempId?: string };
export type ReactBroadcast = {
  targetType: ReactionTargetType;
  targetId: string;
  emoji: string;
  userId: string;
  serverTs?: number;
  id?: string; // reaction row id
};

export type ReactSyncReq = {
  targetType: ReactionTargetType;
  chatId?: string;
  afterServerTs: number;
  afterId?: string;
  // Back-compat alias for older cursor naming:
  afterMsgId?: string;
};
export type ReactSyncResp = {
  targetType: ReactionTargetType;
  chatId?: string;
  items: Array<{ id: string; targetId: string; emoji: string; userId: string; serverTs: number }>;
};
