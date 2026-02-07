import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { TokenBucketRateLimiter } from "./ratelimit.js";
import { extractBearer } from "./auth.js";
import { signJwt, verifyJwt } from "./authJwt.js";
import bcrypt from "bcryptjs";

const DEFAULT_CHAT_ID = "chat_general";

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

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    setCors(res, corsOrigin);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

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
      const token = extractBearer(req.headers.authorization) ?? extractBearer(req.headers.Authorization);
      if (!token) {
        json(res, 401, { error: "invalid_credentials" satisfies AuthErrorCode });
        return;
      }

      try {
        const { userId } = verifyJwt(token, jwtSecret);
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, displayName: true, avatarUrl: true }
        });
        if (!user) {
          json(res, 401, { error: "invalid_credentials" satisfies AuthErrorCode });
          return;
        }
        json(res, 200, { user });
        return;
      } catch {
        json(res, 401, { error: "invalid_credentials" satisfies AuthErrorCode });
        return;
      }
    }

    json(res, 404, { error: "not_found" });
  };
}
