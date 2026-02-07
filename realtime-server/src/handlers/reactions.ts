import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Server, Socket } from "socket.io";
import { chatRoom } from "../rooms.js";
import type { TokenBucketRateLimiter } from "../ratelimit.js";
import { userRoom } from "../rooms.js";

const FEED_SCOPE = "feed";

const TargetTypeSchema = z.enum(["message", "post"]);

const ReactSchema = z
  .object({
    emoji: z.string().min(1).max(16),
    tempId: z.string().min(1).max(80).optional(),
    targetType: TargetTypeSchema.optional(),
    targetId: z.string().min(1).max(80).optional(),
    // Back-compat for message reactions:
    msgId: z.string().min(1).max(80).optional()
  })
  .superRefine((v, ctx) => {
    if (v.msgId) return;
    if (v.targetType && v.targetId) return;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "missing target" });
  });

const ReactSyncSchema = z.object({
  targetType: TargetTypeSchema.optional(), // default message
  chatId: z.string().min(1).max(80).optional(), // required for message scope
  afterServerTs: z.number().int().nonnegative(),
  afterId: z.string().min(1).max(80).optional(),
  // Back-compat alias:
  afterMsgId: z.string().min(1).max(80).optional()
});

export type ReactAck = {
  targetType: "message" | "post";
  targetId: string;
  emoji: string;
  tempId?: string;
};

export type ReactBroadcast = {
  targetType: "message" | "post";
  targetId: string;
  emoji: string;
  userId: string;
  id?: string; // reaction row id, if available
  serverTs?: number; // reaction createdAt
};

export type MsgError = {
  tempId?: string;
  chatId?: string;
  scope?: "feed";
  reason: "invalid_payload" | "not_found" | "forbidden" | "rate_limited" | "tempid_conflict" | "server_error";
};

export type ReactSyncResp = {
  targetType: "message" | "post";
  chatId?: string;
  items: Array<{ id: string; targetId: string; emoji: string; userId: string; serverTs: number }>;
};

function toDbTargetType(t: "message" | "post"): "MESSAGE" | "POST" {
  return t === "message" ? "MESSAGE" : "POST";
}

async function getChatIdForMsg(prisma: PrismaClient, msgId: string): Promise<string | null> {
  const msg = await prisma.message.findUnique({
    where: { id: msgId },
    select: { chatId: true }
  });
  return msg?.chatId ?? null;
}

async function ensureMember(prisma: PrismaClient, chatId: string, userId: string): Promise<boolean> {
  const member = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { id: true }
  });
  return Boolean(member);
}

function emitReaction(opts: {
  io: Server;
  chatId: string | null;
  userId: string | null;
  event: string;
  payload: ReactBroadcast;
}) {
  if (opts.userId) {
    opts.io.to(userRoom(opts.userId)).emit(opts.event, opts.payload);
    return;
  }
  if (opts.chatId) {
    opts.io.to(chatRoom(opts.chatId)).emit(opts.event, opts.payload);
    return;
  }
  opts.io.emit(opts.event, opts.payload);
}

export function registerReactionHandlers(opts: {
  io: Server;
  socket: Socket;
  prisma: PrismaClient;
  limiter: TokenBucketRateLimiter;
}) {
  const { io, socket, prisma, limiter } = opts;

  async function loadPostAudience(postId: string): Promise<
    | { ok: true; visibility: "PUBLIC" | "PRIVATE"; authorId: string; audienceKey: string }
    | { ok: false; reason: "not_found" }
  > {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, visibility: true }
    });
    if (!post) return { ok: false, reason: "not_found" };
    const visibility = post.visibility as any as "PUBLIC" | "PRIVATE";
    const audienceKey = visibility === "PUBLIC" ? FEED_SCOPE : `${FEED_SCOPE}:${post.authorId}`;
    return { ok: true, visibility, authorId: post.authorId, audienceKey };
  }

  socket.on("react:add", async (raw, ack?: (data: ReactAck) => void) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    const parsed = ReactSchema.safeParse(raw);
    if (!parsed.success) {
      const msgId = typeof raw?.msgId === "string" ? raw.msgId : undefined;
      const tempId = typeof raw?.tempId === "string" ? raw.tempId : undefined;
      const hinted = typeof raw?.targetType === "string" ? raw.targetType : undefined;
      const chatId = msgId ? (await getChatIdForMsg(prisma, msgId)) ?? undefined : undefined;
      socket.emit(
        "msg:error",
        hinted === "post"
          ? ({ scope: FEED_SCOPE, tempId, reason: "invalid_payload" } satisfies MsgError)
          : ({ chatId, tempId, reason: "invalid_payload" } satisfies MsgError)
      );
      return;
    }

    const tempId = parsed.data.tempId;
    const emoji = parsed.data.emoji;
    const targetType: "message" | "post" = parsed.data.msgId ? "message" : (parsed.data.targetType as any);
    const targetId = parsed.data.msgId ?? parsed.data.targetId!;

    const dbTargetType = toDbTargetType(targetType);

    let chatId: string | null = null;
    let feedUserId: string | null = null;
    let audienceKey: string | null = null;
    if (targetType === "message") {
      chatId = await getChatIdForMsg(prisma, targetId);
      if (!chatId) {
        socket.emit("msg:error", { tempId, reason: "invalid_payload" } satisfies MsgError);
        return;
      }
      const ok = await ensureMember(prisma, chatId, userId);
      if (!ok) {
        socket.emit("msg:error", { chatId, tempId, reason: "forbidden" } satisfies MsgError);
        return;
      }
    } else {
      const aud = await loadPostAudience(targetId);
      if (!aud.ok) {
        socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: aud.reason } satisfies MsgError);
        return;
      }
      if (aud.visibility === "PRIVATE" && aud.authorId !== userId) {
        socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "forbidden" } satisfies MsgError);
        return;
      }
      audienceKey = aud.audienceKey;
      feedUserId = aud.visibility === "PRIVATE" ? aud.authorId : null;
    }

    if (!limiter.consume(`react:add:${userId}`, 1)) {
      socket.emit(
        "msg:error",
        targetType === "post"
          ? ({ scope: FEED_SCOPE, tempId, reason: "rate_limited" } satisfies MsgError)
          : ({ chatId: chatId ?? undefined, tempId, reason: "rate_limited" } satisfies MsgError)
      );
      return;
    }

    try {
      const created = await prisma.reaction.create({
        data: {
          userId,
          emoji,
          targetType: dbTargetType,
          targetId,
          // For MESSAGE: actual chatId. For POST: feed audience key ("feed" or "feed:<authorId>").
          chatId: targetType === "message" ? chatId : audienceKey
        },
        select: { id: true, createdAt: true }
      });

      const ackPayload: ReactAck = { targetType, targetId, emoji, tempId };
      socket.emit("react:ack", ackPayload);
      ack?.(ackPayload);

      emitReaction({
        io,
        chatId: targetType === "message" ? chatId : null,
        userId: feedUserId,
        event: "react:broadcast",
        payload: {
          targetType,
          targetId,
          emoji,
          userId,
          id: created.id,
          serverTs: created.createdAt.getTime()
        }
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        const ackPayload: ReactAck = { targetType, targetId, emoji, tempId };
        socket.emit("react:ack", ackPayload);
        ack?.(ackPayload);
        return;
      }
      socket.emit(
        "msg:error",
        targetType === "post"
          ? ({ scope: FEED_SCOPE, tempId, reason: "server_error" } satisfies MsgError)
          : ({ chatId: chatId ?? undefined, tempId, reason: "server_error" } satisfies MsgError)
      );
    }
  });

  socket.on("react:remove", async (raw, ack?: (data: ReactAck) => void) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    const parsed = ReactSchema.safeParse(raw);
    if (!parsed.success) {
      const msgId = typeof raw?.msgId === "string" ? raw.msgId : undefined;
      const tempId = typeof raw?.tempId === "string" ? raw.tempId : undefined;
      const hinted = typeof raw?.targetType === "string" ? raw.targetType : undefined;
      const chatId = msgId ? (await getChatIdForMsg(prisma, msgId)) ?? undefined : undefined;
      socket.emit(
        "msg:error",
        hinted === "post"
          ? ({ scope: FEED_SCOPE, tempId, reason: "invalid_payload" } satisfies MsgError)
          : ({ chatId, tempId, reason: "invalid_payload" } satisfies MsgError)
      );
      return;
    }

    const tempId = parsed.data.tempId;
    const emoji = parsed.data.emoji;
    const targetType: "message" | "post" = parsed.data.msgId ? "message" : (parsed.data.targetType as any);
    const targetId = parsed.data.msgId ?? parsed.data.targetId!;
    const dbTargetType = toDbTargetType(targetType);

    let chatId: string | null = null;
    let feedUserId: string | null = null;
    if (targetType === "message") {
      chatId = await getChatIdForMsg(prisma, targetId);
      if (!chatId) {
        socket.emit("msg:error", { tempId, reason: "invalid_payload" } satisfies MsgError);
        return;
      }
      const ok = await ensureMember(prisma, chatId, userId);
      if (!ok) {
        socket.emit("msg:error", { chatId, tempId, reason: "forbidden" } satisfies MsgError);
        return;
      }
    } else {
      const aud = await loadPostAudience(targetId);
      if (!aud.ok) {
        socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: aud.reason } satisfies MsgError);
        return;
      }
      if (aud.visibility === "PRIVATE" && aud.authorId !== userId) {
        socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "forbidden" } satisfies MsgError);
        return;
      }
      feedUserId = aud.visibility === "PRIVATE" ? aud.authorId : null;
    }

    if (!limiter.consume(`react:remove:${userId}`, 1)) {
      socket.emit(
        "msg:error",
        targetType === "post"
          ? ({ scope: FEED_SCOPE, tempId, reason: "rate_limited" } satisfies MsgError)
          : ({ chatId: chatId ?? undefined, tempId, reason: "rate_limited" } satisfies MsgError)
      );
      return;
    }

    try {
      const res = await prisma.reaction.deleteMany({
        where: { userId, emoji, targetType: dbTargetType, targetId }
      });

      const ackPayload: ReactAck = { targetType, targetId, emoji, tempId };
      socket.emit("react:ack", ackPayload);
      ack?.(ackPayload);

      if (res.count > 0) {
        emitReaction({
          io,
          chatId: targetType === "message" ? chatId : null,
          userId: feedUserId,
          event: "react:remove:broadcast",
          payload: { targetType, targetId, emoji, userId }
        });
      }
    } catch {
      socket.emit(
        "msg:error",
        targetType === "post"
          ? ({ scope: FEED_SCOPE, tempId, reason: "server_error" } satisfies MsgError)
          : ({ chatId: chatId ?? undefined, tempId, reason: "server_error" } satisfies MsgError)
      );
    }
  });

  socket.on("react:sync", async (raw) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    const parsed = ReactSyncSchema.safeParse(raw);
    if (!parsed.success) {
      const chatId = typeof raw?.chatId === "string" ? raw.chatId : undefined;
      const hinted = typeof raw?.targetType === "string" ? raw.targetType : undefined;
      socket.emit(
        "msg:error",
        hinted === "post"
          ? ({ scope: FEED_SCOPE, reason: "invalid_payload" } satisfies MsgError)
          : ({ chatId, reason: "invalid_payload" } satisfies MsgError)
      );
      return;
    }

    const targetType: "message" | "post" = parsed.data.targetType ?? "message";
    const chatId = parsed.data.chatId;
    const afterServerTs = parsed.data.afterServerTs;
    const afterId = parsed.data.afterId ?? parsed.data.afterMsgId;

    if (targetType === "message") {
      if (!chatId) {
        socket.emit("msg:error", { reason: "invalid_payload" } satisfies MsgError);
        return;
      }
      const ok = await ensureMember(prisma, chatId, userId);
      if (!ok) {
        socket.emit("msg:error", { chatId, reason: "forbidden" } satisfies MsgError);
        return;
      }
    }

    try {
      const cursorTs = new Date(afterServerTs);
      const whereBase =
        targetType === "message"
          ? { targetType: toDbTargetType("message"), chatId }
          : {
              targetType: toDbTargetType("post"),
              chatId: { in: [FEED_SCOPE, `${FEED_SCOPE}:${userId}`] }
            };

      const where = afterId
        ? {
            ...whereBase,
            OR: [
              { createdAt: { gt: cursorTs } },
              { AND: [{ createdAt: cursorTs }, { id: { gt: afterId } }] }
            ]
          }
        : {
            ...whereBase,
            createdAt: { gt: cursorTs }
          };

      const rows = await prisma.reaction.findMany({
        where: where as any,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 200,
        select: { id: true, targetId: true, userId: true, emoji: true, createdAt: true }
      });

      const resp: ReactSyncResp = {
        targetType,
        ...(targetType === "message" ? { chatId } : {}),
        items: rows.map((r: { id: string; targetId: string; userId: string; emoji: string; createdAt: Date }) => ({
          id: r.id,
          targetId: r.targetId,
          emoji: r.emoji,
          userId: r.userId,
          serverTs: r.createdAt.getTime()
        }))
      };
      socket.emit("react:sync:resp", resp);
    } catch {
      socket.emit(
        "msg:error",
        targetType === "post"
          ? ({ scope: FEED_SCOPE, reason: "server_error" } satisfies MsgError)
          : ({ chatId, reason: "server_error" } satisfies MsgError)
      );
    }
  });
}
