export function getEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env: ${name}`);
}

export const config = {
  port: Number(process.env.PORT ?? "4001"),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  jwtSecret: getEnv("JWT_SECRET", "dev_secret_change_me"),
  inviteRequired: (process.env.INVITE_REQUIRED ?? "false").toLowerCase() === "true"
};
