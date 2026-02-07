"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { loadCachedMe, loadToken, login, saveCachedMe, saveToken } from "../../lib/auth";
import { isOnboarded } from "../../lib/onboarding";

export default function LoginPage() {
  const apiBase = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const token = loadToken();
    if (!token) return;
    const me = loadCachedMe();
    if (me && !isOnboarded(me.id)) router.replace("/onboarding");
    else router.replace("/");
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const resp = await login({ apiBase, username: username.trim(), password });
      saveToken(resp.token);
      saveCachedMe(resp.user);
      if (!isOnboarded(resp.user.id)) router.replace("/onboarding");
      else router.replace("/");
    } catch (e: any) {
      setErr(String(e?.message ?? "login_failed"));
    }
  }

  const cached = loadCachedMe();

  return (
    <div style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 18 }}>Login</div>
      <div style={{ opacity: 0.7, fontSize: 12 }}>api: {apiBase}</div>

      {cached ? (
        <div style={{ opacity: 0.8, fontSize: 12 }}>
          cached: {cached.username} ({cached.id})
        </div>
      ) : null}

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          autoComplete="username"
          style={{ padding: 10, border: "1px solid #ddd" }}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          autoComplete="current-password"
          type="password"
          style={{ padding: 10, border: "1px solid #ddd" }}
        />
        <button type="submit" style={{ padding: "10px 12px" }}>
          Login
        </button>
      </form>

      {err ? <div style={{ color: "#b00020", fontSize: 12 }}>error: {err}</div> : null}

      <div style={{ fontSize: 12, opacity: 0.85 }}>
        No account? <Link href="/register">Register</Link>
      </div>
    </div>
  );
}
