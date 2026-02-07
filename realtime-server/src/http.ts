import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { TokenBucketRateLimiter } from "./ratelimit.js";
import { extractBearer } from "./auth.js";
import { signJwt, verifyJwt } from "./authJwt.js";
import bcrypt from "bcryptjs";

const DEFAULT_CHAT_ID = "chat_general";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const UsernameSchema = z
  .string()
  .min(3)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/);

const PasswordSchema = z.string().min(8).max(200);

const RegisterSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema
});

const LoginSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema
});

type AuthErrorCode = "invalid_payload" | "invalid_credentials" | "username_taken";

function json(res: ServerResponse, status: number, body: any, extraHeaders?: Record<string, string>) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(JSON.stringify(body));
}

function setCors(res: ServerResponse, corsOrigin: string) {
  res.setHeader("access-control-allow-origin", corsOrigin);
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
}

function getIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  const addr = req.socket.remoteAddress ?? "";
  return addr.length > 0 ? addr : "unknown";
}

function toInt(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function clampLimit(v: number | null): number {
  const raw = v ?? DEFAULT_LIMIT;
  if (raw < 1) return 1;
  if (raw > MAX_LIMIT) return MAX_LIMIT;
  return raw;
}

function parseCursor(sp: URLSearchParams): { afterTs: number | null; afterId: string | null; limit: number } {
  const afterTs = toInt(sp.get("afterTs"));
  const afterId = sp.get("afterId");
  const limit = clampLimit(toInt(sp.get("limit")));
  return { afterTs: afterTs !== null && afterTs >= 0 ? afterTs : null, afterId: afterId ? afterId : null, limit };
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<any | null> {
  return await new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve(null);
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export function createHttpHandler(opts: {
  prisma: PrismaClient;
  jwtSecret: string;
  corsOrigin: string;
  authLimiter: TokenBucketRateLimiter;
}) {
  const { prisma, jwtSecret, corsOrigin, authLimiter } = opts;

  function requireAuth(req: IncomingMessage): { ok: true; userId: string } | { ok: false } {
    const token = extractBearer(req.headers.authorization) ?? extractBearer(req.headers.Authorization);
    if (!token) return { ok: false };
    try {
      const { userId } = verifyJwt(token, jwtSecret);
      return { ok: true, userId };
    } catch {
      return { ok: false };
    }
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    setCors(res, corsOrigin);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Feed history: public posts + private posts of the author.
    // Cursor is stable: (createdAt,id), ASC.
    if (path === "/feed" && req.method === "GET") {
      const auth = requireAuth(req);
      if (!auth.ok) {
        json(res, 401, { error: "invalid_credentials" });
        return;
      }

      const { afterTs, afterId, limit } = parseCursor(url.searchParams);
      const userId = auth.userId;

      const baseWhere = {
        OR: [{ visibility: "PUBLIC" as const }, { visibility: "PRIVATE" as const, authorId: userId }]
      };

      try {
        let rows: Array<{ id: string; authorId: string; text: string; createdAt: Date; visibility: "PUBLIC" | "PRIVATE" }> = [];

        if (afterTs === null) {
          // Tail mode for cold start: newest N, returned ASC.
          rows = await prisma.post.findMany({
            where: baseWhere as any,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit,
            select: { id: true, authorId: true, text: true, createdAt: true, visibility: true }
          });
          rows.reverse();
        } else {
          const cursorTs = new Date(afterTs);
          const cursorWhere = afterId
            ? {
                OR: [{ createdAt: { gt: cursorTs } }, { AND: [{ createdAt: cursorTs }, { id: { gt: afterId } }] }]
              }
            : { createdAt: { gt: cursorTs } };

          rows = await prisma.post.findMany({
            where: { AND: [baseWhere as any, cursorWhere as any] } as any,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: limit,
            select: { id: true, authorId: true, text: true, createdAt: true, visibility: true }
          });
        }

        json(res, 200, {
          items: rows.map((p) => ({
            postId: p.id,
            authorId: p.authorId,
            text: p.text,
            serverTs: p.createdAt.getTime(),
            visibility: p.visibility
          }))
        });
        return;
      } catch {
        json(res, 500, { error: "server_error" });
        return;
      }
    }

    // Chat message history for cold start.
    // Cursor is stable: (serverTs,id), ASC.
    if (path.startsWith("/chat/") && path.endsWith("/messages") && req.method === "GET") {
      const auth = requireAuth(req);
      if (!auth.ok) {
        json(res, 401, { error: "invalid_credentials" });
        return;
      }

      const parts = path.split("/").filter(Boolean); // ["chat", ":chatId", "messages"]
      const chatId = parts.length === 3 && parts[0] === "chat" && parts[2] === "messages" ? decodeURIComponent(parts[1]!) : null;
      if (!chatId) {
        json(res, 400, { error: "invalid_payload" });
        return;
      }

      const userId = auth.userId;
      const member = await prisma.chatMember.findUnique({
        where: { chatId_userId: { chatId, userId } },
        select: { id: true }
      });
      if (!member) {
        json(res, 403, { error: "forbidden" });
        return;
      }

      const { afterTs, afterId, limit } = parseCursor(url.searchParams);

      try {
        let rows: Array<{ id: string; chatId: string; fromId: string; text: string; serverTs: Date }> = [];

        if (afterTs === null) {
          rows = await prisma.message.findMany({
            where: { chatId },
            orderBy: [{ serverTs: "desc" }, { id: "desc" }],
            take: limit,
            select: { id: true, chatId: true, fromId: true, text: true, serverTs: true }
          });
          rows.reverse();
        } else {
          const cursorTs = new Date(afterTs);
          const cursorWhere = afterId
            ? {
                OR: [{ serverTs: { gt: cursorTs } }, { AND: [{ serverTs: cursorTs }, { id: { gt: afterId } }] }]
              }
            : { serverTs: { gt: cursorTs } };

          rows = await prisma.message.findMany({
            where: { AND: [{ chatId }, cursorWhere as any] } as any,
            orderBy: [{ serverTs: "asc" }, { id: "asc" }],
            take: limit,
            select: { id: true, chatId: true, fromId: true, text: true, serverTs: true }
          });
        }

        json(res, 200, {
          items: rows.map((m) => ({
            msgId: m.id,
            chatId: m.chatId,
            from: m.fromId,
            text: m.text,
            serverTs: m.serverTs.getTime()
          }))
        });
        return;
      } catch {
        json(res, 500, { error: "server_error" });
        return;
      }
    }

    if (path === "/auth/register" && req.method === "POST") {
      const ip = getIp(req);
      if (!authLimiter.consume(`auth:register:${ip}`, 1)) {
        json(res, 429, { error: "rate_limited" });
        return;
      }

      const body = await readJson(req, 16 * 1024);
      const parsed = RegisterSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "invalid_payload" satisfies AuthErrorCode });
        return;
      }

      const { username, password } = parsed.data;
      const passwordHash = await bcrypt.hash(password, 10);

      try {
        const created = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { username, passwordHash, displayName: username },
            select: { id: true, username: true, displayName: true, avatarUrl: true }
          });

          // MVP default chat membership so messaging works without extra endpoints.
          await tx.chat.upsert({
            where: { id: DEFAULT_CHAT_ID },
            update: {},
            create: { id: DEFAULT_CHAT_ID }
          });
          await tx.chatMember.upsert({
            where: { chatId_userId: { chatId: DEFAULT_CHAT_ID, userId: user.id } },
            update: {},
            create: { chatId: DEFAULT_CHAT_ID, userId: user.id }
          });

          // Demo: first-run private thought (visible only to the author).
          await tx.post.create({
            data: {
              authorId: user.id,
              tempId: "onboarding_1",
              visibility: "PRIVATE",
              clientTs: BigInt(Date.now()),
              text:
                "Welcome. This is a PRIVATE post only you can see.\n\nTry:\n- Create a PRIVATE thought\n- Toggle Silent Mode\n- Pin a chat in Focus\n\nYou can delete this later."
            },
            select: { id: true }
          });

          return user;
        });

        const token = signJwt(created.id, jwtSecret);
        json(res, 200, { token, user: created });
        return;
      } catch (e: any) {
        if (e?.code === "P2002") {
          json(res, 409, { error: "username_taken" satisfies AuthErrorCode });
          return;
        }
        json(res, 500, { error: "server_error" });
        return;
      }
    }

    if (path === "/auth/login" && req.method === "POST") {
      const ip = getIp(req);
      if (!authLimiter.consume(`auth:login:${ip}`, 1)) {
        json(res, 429, { error: "rate_limited" });
        return;
      }

      const body = await readJson(req, 16 * 1024);
      const parsed = LoginSchema.safeParse(body);
      if (!parsed.success) {
        json(res, 400, { error: "invalid_payload" satisfies AuthErrorCode });
        return;
      }

      const { username, password } = parsed.data;
      const user = await prisma.user.findUnique({
        where: { username },
        select: { id: true, username: true, displayName: true, avatarUrl: true, passwordHash: true }
      });
      if (!user) {
        json(res, 401, { error: "invalid_credentials" satisfies AuthErrorCode });
        return;
      }

      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) {
        json(res, 401, { error: "invalid_credentials" satisfies AuthErrorCode });
        return;
      }

      const token = signJwt(user.id, jwtSecret);
      const { passwordHash: _ph, ...profile } = user;
      json(res, 200, { token, user: profile });
      return;
    }

    if (path === "/me" && req.method === "GET") {
      const auth = requireAuth(req);
      if (!auth.ok) {
        json(res, 401, { error: "invalid_credentials" satisfies AuthErrorCode });
        return;
      }
      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { id: true, username: true, displayName: true, avatarUrl: true }
      });
      if (!user) {
        json(res, 401, { error: "invalid_credentials" satisfies AuthErrorCode });
        return;
      }
      json(res, 200, { user });
      return;
    }

    json(res, 404, { error: "not_found" });
  };
}
