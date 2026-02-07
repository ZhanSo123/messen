"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { getAuthConfig, loadToken, register, saveCachedMe, saveToken } from "../../lib/auth";
import { isOnboarded } from "../../lib/onboarding";

export default function RegisterPage() {
  const apiBase = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteRequired, setInviteRequired] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const token = loadToken();
    if (!token) return;
    router.replace("/");
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getAuthConfig({ apiBase });
        if (cancelled) return;
        setInviteRequired(cfg.inviteRequired);
      } catch {
        // Default: don't show invite field if server doesn't expose config.
        if (!cancelled) setInviteRequired(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const resp = await register({
        apiBase,
        username: username.trim(),
        password,
        ...(inviteRequired ? { inviteCode: inviteCode.trim() } : {})
      });
      saveToken(resp.token);
      saveCachedMe(resp.user);
      if (!isOnboarded(resp.user.id)) router.replace("/onboarding");
      else router.replace("/");
    } catch (e: any) {
      setErr(String(e?.message ?? "register_failed"));
    }
  }

  return (
      <div style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Register</div>
      <div style={{ opacity: 0.7, fontSize: 12 }}>username 3-24, [a-zA-Z0-9_], password {">="} 8</div>

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
          autoComplete="new-password"
          type="password"
          style={{ padding: 10, border: "1px solid #ddd" }}
        />
        {inviteRequired ? (
          <input
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="invite code"
            autoComplete="off"
            style={{ padding: 10, border: "1px solid #ddd" }}
          />
        ) : null}
        <button type="submit" style={{ padding: "10px 12px" }}>
          Register
        </button>
      </form>

      {err ? <div style={{ color: "#b00020", fontSize: 12 }}>error: {err}</div> : null}

      <div style={{ fontSize: 12, opacity: 0.85 }}>
        Have an account? <Link href="/login">Login</Link>
      </div>
    </div>
  );
}
