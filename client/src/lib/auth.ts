"use client";

export type MeUser = { id: string; username: string; displayName: string; avatarUrl?: string | null };

const TOKEN_KEY = "nm:token";
const ME_KEY = "nm:me";

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function loadCachedMe(): MeUser | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.id !== "string" || typeof obj.username !== "string" || typeof obj.displayName !== "string") return null;
    return { id: obj.id, username: obj.username, displayName: obj.displayName, avatarUrl: obj.avatarUrl ?? null };
  } catch {
    return null;
  }
}

export function saveCachedMe(me: MeUser) {
  localStorage.setItem(ME_KEY, JSON.stringify(me));
}

export function clearCachedMe() {
  localStorage.removeItem(ME_KEY);
}

export type AuthResp = { token: string; user: MeUser };

export async function register(opts: { apiBase: string; username: string; password: string }): Promise<AuthResp> {
  const res = await fetch(`${opts.apiBase}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: opts.username, password: opts.password })
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? "register_failed");
  return json as AuthResp;
}

export async function login(opts: { apiBase: string; username: string; password: string }): Promise<AuthResp> {
  const res = await fetch(`${opts.apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: opts.username, password: opts.password })
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? "login_failed");
  return json as AuthResp;
}

export async function getMe(opts: { apiBase: string; token: string }): Promise<MeUser> {
  const res = await fetch(`${opts.apiBase}/me`, {
    method: "GET",
    headers: { authorization: `Bearer ${opts.token}` }
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? "me_failed");
  return (json as any).user as MeUser;
}

