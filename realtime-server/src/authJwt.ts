import jwt from "jsonwebtoken";
import { z } from "zod";

const JwtPayloadSchema = z.object({
  sub: z.string()
});

export type AuthUser = { userId: string };

export function signJwt(userId: string, secret: string): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: "7d" });
}

export function verifyJwt(token: string, secret: string): AuthUser {
  const decoded = jwt.verify(token, secret);
  const payload = JwtPayloadSchema.parse(decoded);
  return { userId: payload.sub };
}

