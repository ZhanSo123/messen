import jwt from "jsonwebtoken";
import { z } from "zod";

const JwtPayloadSchema = z.object({
  sub: z.string()
});

export type AuthUser = { userId: string };

export function verifyJwt(token: string, secret: string): AuthUser {
  const decoded = jwt.verify(token, secret);
  const payload = JwtPayloadSchema.parse(decoded);
  return { userId: payload.sub };
}

function extractBearer(headerValue: unknown): string | null {
  if (typeof headerValue !== "string") return null;
  const v = headerValue.trim();
  if (v.length === 0) return null;
  const lower = v.toLowerCase();
  if (!lower.startsWith("bearer ")) return null;
  const token = v.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function extractTokenFromHandshake(handshake: {
  auth?: unknown;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): string | null {
  const authToken = (handshake.auth as any)?.token;
  if (typeof authToken === "string" && authToken.trim().length > 0) return authToken.trim();

  const header =
    extractBearer(handshake.headers?.authorization) ??
    extractBearer(handshake.headers?.Authorization);
  if (header) return header;

  const queryToken = handshake.query?.token;
  if (typeof queryToken === "string" && queryToken.trim().length > 0) return queryToken.trim();

  return null;
}
