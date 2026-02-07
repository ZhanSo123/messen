import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Server, Socket } from "socket.io";
import { chatRoom } from "../rooms.js";
import type { TokenBucketRateLimiter } from "../ratelimit.js";

const MsgNewSchema = z.object({
  tempId: z.string().min(1).max(80),
  chatId: z.string().min(1).max(80),
  text: z
    .string()
    .max(4000)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0 && v.length <= 2000),
  clientTs: z.number().int().nonnegative()
});

const MsgSyncSchema = z.object({
  chatId: z.string().min(1).max(80),
  afterServerTs: z.number().int().nonnegative(),
  afterMsgId: z.string().min(1).max(80).optional()
});

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
  reason: "invalid_payload" | "not_found" | "forbidden" | "rate_limited" | "tempid_conflict" | "server_error";
};

export type MsgSyncResp = {
  chatId: string;
  items: MsgBroadcast[];
};

export function registerMessageHandlers(opts: {
  io: Server;
  socket: Socket;
  prisma: PrismaClient;
  limiter: TokenBucketRateLimiter;
}) {
  const { io, socket, prisma, limiter } = opts;

  socket.on("msg:new", async (raw, ack?: (data: MsgAck) => void) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    const parsed = MsgNewSchema.safeParse(raw);
    if (!parsed.success) {
      const tempId = typeof raw?.tempId === "string" ? raw.tempId : undefined;
      const chatId = typeof raw?.chatId === "string" ? raw.chatId : undefined;
      socket.emit("msg:error", { tempId, chatId, reason: "invalid_payload" } satisfies MsgError);
      return;
    }
    const { tempId, chatId, text, clientTs } = parsed.data;

    // Idempotency first: if it already exists, always ack (even if membership changed later).
    const existing = await prisma.message.findUnique({
      where: { fromId_tempId: { fromId: userId, tempId } },
      select: { id: true, serverTs: true, chatId: true, text: true, fromId: true }
    });

    if (existing) {
      if (existing.chatId !== chatId || existing.text !== text) {
        socket.emit(
          "msg:error",
          { tempId, chatId, reason: "tempid_conflict" } satisfies MsgError
        );
        return;
      }

      const payload: MsgAck = {
        tempId,
        msgId: existing.id,
        serverTs: existing.serverTs.getTime()
      };
      socket.emit("msg:ack", payload);
      ack?.(payload);

      // Optional at-least-once re-broadcast for the sender's current chat session.
      // This helps if the first request created the row but the sender never saw the broadcast.
      const room = chatRoom(existing.chatId);
      if (socket.rooms.has(room)) {
        const broadcast: MsgBroadcast = {
          msgId: existing.id,
          chatId: existing.chatId,
          from: existing.fromId,
          text: existing.text,
          serverTs: existing.serverTs.getTime()
        };
        io.to(room).emit("msg:broadcast", broadcast);
      }
      return;
    }

    if (!limiter.consume(`msg:new:${userId}`, 1)) {
      socket.emit(
        "msg:error",
        { tempId, chatId, reason: "rate_limited" } satisfies MsgError
      );
      return;
    }

    // Must be a member of the chat to create a new message.
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { id: true }
    });
    if (!member) {
      socket.emit("msg:error", { tempId, chatId, reason: "forbidden" } satisfies MsgError);
      return;
    }

    try {
      const created = await prisma.message.create({
        data: {
          chatId,
          fromId: userId,
          tempId,
          text,
          clientTs: BigInt(clientTs)
        },
        select: { id: true, serverTs: true }
      });

      const ackPayload: MsgAck = {
        tempId,
        msgId: created.id,
        serverTs: created.serverTs.getTime()
      };
      socket.emit("msg:ack", ackPayload);
      ack?.(ackPayload);

      const broadcast: MsgBroadcast = {
        msgId: created.id,
        chatId,
        from: userId,
        text,
        serverTs: created.serverTs.getTime()
      };
      io.to(chatRoom(chatId)).emit("msg:broadcast", broadcast);
      return;
    } catch (e: any) {
      // Another in-flight send won the race; resolve by reading existing and acking it.
      if (e?.code === "P2002") {
        const raced = await prisma.message.findUnique({
          where: { fromId_tempId: { fromId: userId, tempId } },
          select: { id: true, serverTs: true, chatId: true, text: true, fromId: true }
        });
        if (!raced) {
          socket.emit("msg:error", { tempId, chatId, reason: "server_error" } satisfies MsgError);
          return;
        }
        if (raced.chatId !== chatId || raced.text !== text) {
          socket.emit(
            "msg:error",
            { tempId, chatId, reason: "tempid_conflict" } satisfies MsgError
          );
          return;
        }

        const payload: MsgAck = {
          tempId,
          msgId: raced.id,
          serverTs: raced.serverTs.getTime()
        };
        socket.emit("msg:ack", payload);
        ack?.(payload);

        const room = chatRoom(raced.chatId);
        if (socket.rooms.has(room)) {
          const broadcast: MsgBroadcast = {
            msgId: raced.id,
            chatId: raced.chatId,
            from: raced.fromId,
            text: raced.text,
            serverTs: raced.serverTs.getTime()
          };
          io.to(room).emit("msg:broadcast", broadcast);
        }
        return;
      }

      socket.emit("msg:error", { tempId, chatId, reason: "server_error" } satisfies MsgError);
      return;
    }
  });

  socket.on("msg:sync", async (raw) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    const parsed = MsgSyncSchema.safeParse(raw);
    if (!parsed.success) {
      const chatId = typeof raw?.chatId === "string" ? raw.chatId : undefined;
      socket.emit("msg:error", { chatId, reason: "invalid_payload" } satisfies MsgError);
      return;
    }

    const { chatId, afterServerTs, afterMsgId } = parsed.data;

    // Must be a member of the chat to sync.
    const member = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { id: true }
    });
    if (!member) {
      socket.emit("msg:error", { chatId, reason: "forbidden" } satisfies MsgError);
      return;
    }

    try {
      const cursorTs = new Date(afterServerTs);
      const where = afterMsgId
        ? {
            chatId,
            OR: [
              { serverTs: { gt: cursorTs } },
              { AND: [{ serverTs: cursorTs }, { id: { gt: afterMsgId } }] }
            ]
          }
        : {
            chatId,
            serverTs: { gt: cursorTs }
          };

      const items = await prisma.message.findMany({
        where,
        orderBy: [{ serverTs: "asc" }, { id: "asc" }],
        take: 50,
        select: { id: true, chatId: true, fromId: true, text: true, serverTs: true }
      });

      const resp: MsgSyncResp = {
        chatId,
        items: items.map((m: { id: string; chatId: string; fromId: string; text: string; serverTs: Date }) => ({
          msgId: m.id,
          chatId: m.chatId,
          from: m.fromId,
          text: m.text,
          serverTs: m.serverTs.getTime()
        }))
      };
      socket.emit("msg:sync:resp", resp);
    } catch {
      socket.emit("msg:error", { chatId, reason: "server_error" } satisfies MsgError);
    }
  });
}
