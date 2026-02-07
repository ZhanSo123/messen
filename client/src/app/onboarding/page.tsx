"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { clearCachedMe, clearToken, getMe, loadCachedMe, loadToken, saveCachedMe } from "../../lib/auth";
import { isOnboarded, setOnboarded } from "../../lib/onboarding";

export default function OnboardingPage() {
  const apiBase = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState(() => loadCachedMe());

  useEffect(() => {
    const t = loadToken();
    if (!t) {
      router.replace("/login");
      return;
    }
    setToken(t);
  }, [router]);

  useEffect(() => {
    if (!token) return;
    if (me) return;
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await getMe({ apiBase, token });
        if (cancelled) return;
        saveCachedMe(fresh);
        setMe(fresh);
      } catch {
        clearToken();
        clearCachedMe();
        router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, token, me, router]);

  useEffect(() => {
    if (!me) return;
    if (isOnboarded(me.id)) router.replace("/");
  }, [me, router]);

  if (!token || !me) return null;

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 900, fontSize: 20 }}>Welcome</div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>me: {me.username}</div>
      </div>

      <div style={{ border: "1px solid #ddd", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 800 }}>Private thoughts</div>
        <div style={{ opacity: 0.8 }}>Create PRIVATE posts that only you can see. A calm space for ideas.</div>
      </div>

      <div style={{ border: "1px solid #ddd", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 800 }}>Silent Mode</div>
        <div style={{ opacity: 0.8 }}>Reactions are there, but without pressure. Collapse them by default.</div>
      </div>

      <div style={{ border: "1px solid #ddd", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 800 }}>Focus</div>
        <div style={{ opacity: 0.8 }}>Pin important chats and keep the main surface quiet.</div>
      </div>

      <button
        onClick={() => {
          setOnboarded(me.id);
          router.replace("/");
        }}
        style={{ padding: "12px 16px", border: "1px solid #111", background: "#111", color: "#fff", width: "fit-content" }}
      >
        Start
      </button>
    </div>
  );
}

