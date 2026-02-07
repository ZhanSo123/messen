import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
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
  password: PasswordSchema,
  inviteCode: z.string().min(1).max(80).optional()
});

const LoginSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema
});

type AuthErrorCode = "invalid_payload" | "invalid_credentials" | "username_taken";
type InviteErrorCode = "invalid_invite" | "invite_used";

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
  inviteRequired: boolean;
  publicLimiter: TokenBucketRateLimiter;
  invitePublicLimiter: TokenBucketRateLimiter;
}) {
  const { prisma, jwtSecret, corsOrigin, authLimiter, inviteRequired, publicLimiter, invitePublicLimiter } = opts;

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

    if (path === "/auth/config" && req.method === "GET") {
      const ip = getIp(req);
      if (!publicLimiter.consume(`pub:config:${ip}`, 1)) {
        json(res, 429, { error: "rate_limited" });
        return;
      }
      json(res, 200, { inviteRequired });
      return;
    }

    if (path === "/invite/create" && req.method === "POST") {
      const auth = requireAuth(req);
      if (!auth.ok) {
        json(res, 401, { error: "invalid_credentials" });
        return;
      }

      const active = await prisma.inviteCode.count({
        where: { createdByUserId: auth.userId, usedAt: null }
      });
      if (active >= 5) {
        json(res, 400, { error: "limit_reached" });
        return;
      }

      // Short, URL-safe invite code (crypto-strong).
      let created: { code: string; createdAt: Date } | null = null;
      for (let i = 0; i < 3; i++) {
        const code = randomBytes(18).toString("base64url");
        try {
          created = await prisma.inviteCode.create({
            data: { code, createdByUserId: auth.userId },
            select: { code: true, createdAt: true }
          });
          break;
        } catch (e: any) {
          if (e?.code === "P2002") continue;
          throw e;
        }
      }
      if (!created) {
        json(res, 500, { error: "server_error" });
        return;
      }
      json(res, 200, { code: created.code, createdAt: created.createdAt.getTime() });
      return;
    }

    if (path === "/invite/mine" && req.method === "GET") {
      const auth = requireAuth(req);
      if (!auth.ok) {
        json(res, 401, { error: "invalid_credentials" });
        return;
      }
      const rows = await prisma.inviteCode.findMany({
        where: { createdByUserId: auth.userId, usedAt: null },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { code: true, createdAt: true }
      });
      json(res, 200, { items: rows.map((r) => ({ code: r.code, createdAt: r.createdAt.getTime() })) });
      return;
    }

    if (path === "/invite/revoke" && req.method === "POST") {
      const auth = requireAuth(req);
      if (!auth.ok) {
        json(res, 401, { error: "invalid_credentials" });
        return;
      }
      const body = await readJson(req, 8 * 1024);
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      if (!code || code.length > 80) {
        json(res, 400, { error: "invalid_payload" });
        return;
      }
      const resDel = await prisma.inviteCode.deleteMany({
        where: { code, createdByUserId: auth.userId, usedAt: null }
      });
      if (resDel.count !== 1) {
        json(res, 400, { error: "invalid_invite" satisfies InviteErrorCode });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    if (path.startsWith("/invite/") && req.method === "GET") {
      const ip = getIp(req);
      if (!publicLimiter.consume(`pub:invite:${ip}`, 1)) {
        json(res, 429, { error: "rate_limited" });
        return;
      }
      if (!invitePublicLimiter.consume(`pub:invite:strict:${ip}`, 1)) {
        json(res, 429, { error: "rate_limited" });
        return;
      }
      const code = decodeURIComponent(path.slice("/invite/".length));
      if (!code || code.length > 80) {
        json(res, 400, { error: "invalid_invite" satisfies InviteErrorCode });
        return;
      }
      const inv = await prisma.inviteCode.findUnique({
        where: { code },
        select: { usedAt: true }
      });
      if (!inv) {
        json(res, 400, { error: "invalid_invite" satisfies InviteErrorCode });
        return;
      }
      if (inv.usedAt) {
        json(res, 400, { error: "invite_used" satisfies InviteErrorCode });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

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

      const { username, password, inviteCode } = parsed.data;
      const passwordHash = await bcrypt.hash(password, 10);

      try {
        const created = await prisma.$transaction(async (tx) => {
          let inviteCodeClean: string | null = null;
          if (inviteRequired) {
            const code = (inviteCode ?? "").trim();
            if (!code) {
              const err: any = new Error("invalid_invite");
              err._code = "invalid_invite";
              throw err;
            }
            const inv = await tx.inviteCode.findUnique({
              where: { code },
              select: { usedAt: true }
            });
            if (!inv) {
              const err: any = new Error("invalid_invite");
              err._code = "invalid_invite";
              throw err;
            }
            if (inv.usedAt) {
              const err: any = new Error("invite_used");
              err._code = "invite_used";
              throw err;
            }
            inviteCodeClean = code;
          }

          const user = await tx.user.create({
            data: { username, passwordHash, displayName: username },
            select: { id: true, username: true, displayName: true, avatarUrl: true }
          });

          if (inviteRequired) {
            const res = await tx.inviteCode.updateMany({
              where: { code: inviteCodeClean!, usedAt: null },
              data: { usedByUserId: user.id, usedAt: new Date() }
            });
            if (res.count !== 1) {
              const err: any = new Error("invite_used");
              err._code = "invite_used";
              throw err;
            }
          }

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
        if (e?._code === "invalid_invite") {
          json(res, 400, { error: "invalid_invite" satisfies InviteErrorCode });
          return;
        }
        if (e?._code === "invite_used") {
          json(res, 400, { error: "invite_used" satisfies InviteErrorCode });
          return;
        }
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
