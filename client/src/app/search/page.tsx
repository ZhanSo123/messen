"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { clearCachedMe, clearToken, getMe, loadCachedMe, loadToken, saveCachedMe } from "../../lib/auth";
import { isOnboarded } from "../../lib/onboarding";

export default function SearchPage() {
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
  }, [apiBase, token, router]);

  useEffect(() => {
    if (!me) return;
    if (!isOnboarded(me.id)) router.replace("/onboarding");
  }, [me, router]);

  if (!token || !me) return null;
  if (!isOnboarded(me.id)) return null;

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontWeight: 900, fontSize: 18 }}>Search</div>
      <div style={{ opacity: 0.75 }}>Coming soon.</div>
    </div>
  );
}

