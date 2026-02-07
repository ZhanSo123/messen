import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Server, Socket } from "socket.io";
import type { TokenBucketRateLimiter } from "../ratelimit.js";
import { userRoom } from "../rooms.js";

const FEED_SCOPE = "feed";

const VisibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);

const PostNewSchema = z.object({
  tempId: z.string().min(1).max(80),
  text: z
    .string()
    .max(8000)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0 && v.length <= 4000),
  clientTs: z.number().int().nonnegative(),
  visibility: VisibilitySchema.optional()
});

const PostSyncSchema = z.object({
  afterServerTs: z.number().int().nonnegative(),
  afterId: z.string().min(1).max(80).optional()
});

export type PostAck = {
  tempId: string;
  postId: string;
  serverTs: number;
};

export type PostBroadcast = {
  postId: string;
  authorId: string;
  text: string;
  serverTs: number;
  visibility: "PUBLIC" | "PRIVATE";
};

export type PostSyncResp = {
  items: PostBroadcast[];
};

export type MsgError = {
  tempId?: string;
  chatId?: string;
  scope?: "feed";
  reason: "invalid_payload" | "not_found" | "forbidden" | "rate_limited" | "tempid_conflict" | "server_error";
};

export function registerPostHandlers(opts: {
  io: Server;
  socket: Socket;
  prisma: PrismaClient;
  limiter: TokenBucketRateLimiter;
}) {
  const { io, socket, prisma, limiter } = opts;

  socket.on("post:new", async (raw, ack?: (data: PostAck) => void) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    const parsed = PostNewSchema.safeParse(raw);
    if (!parsed.success) {
      const tempId = typeof raw?.tempId === "string" ? raw.tempId : undefined;
      socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "invalid_payload" } satisfies MsgError);
      return;
    }

    const { tempId, text, clientTs } = parsed.data;
    const visibility = (parsed.data.visibility ?? "PUBLIC") as "PUBLIC" | "PRIVATE";

    const existing = await prisma.post.findUnique({
      where: { authorId_tempId: { authorId: userId, tempId } },
      select: { id: true, createdAt: true, text: true, visibility: true }
    });

    if (existing) {
      if (existing.text !== text || existing.visibility !== (visibility as any)) {
        socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "tempid_conflict" } satisfies MsgError);
        return;
      }

      const payload: PostAck = { tempId, postId: existing.id, serverTs: existing.createdAt.getTime() };
      socket.emit("post:ack", payload);
      ack?.(payload);
      return;
    }

    if (!limiter.consume(`post:new:${userId}`, 1)) {
      socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "rate_limited" } satisfies MsgError);
      return;
    }

    try {
      const created = await prisma.post.create({
        data: {
          authorId: userId,
          tempId,
          text,
          clientTs: BigInt(clientTs),
          visibility: visibility as any
        },
        select: { id: true, createdAt: true, visibility: true }
      });

      const ackPayload: PostAck = { tempId, postId: created.id, serverTs: created.createdAt.getTime() };
      socket.emit("post:ack", ackPayload);
      ack?.(ackPayload);

      const broadcast: PostBroadcast = {
        postId: created.id,
        authorId: userId,
        text,
        serverTs: created.createdAt.getTime(),
        visibility: created.visibility as any
      };
      if (created.visibility === "PUBLIC") io.emit("post:broadcast", broadcast);
      else io.to(userRoom(userId)).emit("post:broadcast", broadcast);
    } catch (e: any) {
      if (e?.code === "P2002") {
        const raced = await prisma.post.findUnique({
          where: { authorId_tempId: { authorId: userId, tempId } },
          select: { id: true, createdAt: true, text: true, visibility: true }
        });
        if (!raced) {
          socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "server_error" } satisfies MsgError);
          return;
        }
        if (raced.text !== text || raced.visibility !== (visibility as any)) {
          socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "tempid_conflict" } satisfies MsgError);
          return;
        }
        const payload: PostAck = { tempId, postId: raced.id, serverTs: raced.createdAt.getTime() };
        socket.emit("post:ack", payload);
        ack?.(payload);
        return;
      }
      socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "server_error" } satisfies MsgError);
    }
  });

  socket.on("post:sync", async (raw) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    const parsed = PostSyncSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit("msg:error", { scope: FEED_SCOPE, reason: "invalid_payload" } satisfies MsgError);
      return;
    }

    const { afterServerTs, afterId } = parsed.data;

    try {
      const cursorTs = new Date(afterServerTs);
      const where = afterId
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { gt: cursorTs } },
                  { AND: [{ createdAt: cursorTs }, { id: { gt: afterId } }] }
                ]
              },
              {
                OR: [{ visibility: "PUBLIC" }, { visibility: "PRIVATE", authorId: userId }]
              }
            ]
          }
        : {
            AND: [
              { createdAt: { gt: cursorTs } },
              { OR: [{ visibility: "PUBLIC" }, { visibility: "PRIVATE", authorId: userId }] }
            ]
          };

      const rows = await prisma.post.findMany({
        where: where as any,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 50,
        select: { id: true, authorId: true, text: true, createdAt: true, visibility: true }
      });

      const resp: PostSyncResp = {
        items: rows.map((p: { id: string; authorId: string; text: string; createdAt: Date; visibility: any }) => ({
          postId: p.id,
          authorId: p.authorId,
          text: p.text,
          serverTs: p.createdAt.getTime(),
          visibility: p.visibility
        }))
      };
      socket.emit("post:sync:resp", resp);
    } catch {
      socket.emit("msg:error", { scope: FEED_SCOPE, reason: "server_error" } satisfies MsgError);
    }
  });
}
