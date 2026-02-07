"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { PostFeed } from "../../components/PostFeed";
import { clearCachedMe, clearToken, getMe, loadCachedMe, loadToken, saveCachedMe } from "../../lib/auth";
import { isOnboarded } from "../../lib/onboarding";
import { loadSettings, saveSettings, type UserSettings } from "../../lib/settings";

export default function FeedPage() {
  const apiBase = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState(() => loadCachedMe());
  const [settings, setSettings] = useState<UserSettings | null>(null);

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
    if (!isOnboarded(me.id)) {
      router.replace("/onboarding");
      return;
    }
    setSettings(loadSettings(me.id));
  }, [me, router]);

  useEffect(() => {
    if (!me || !settings) return;
    saveSettings(me.id, settings);
  }, [me, settings]);

  if (!token || !me || !settings) return null;
  if (!isOnboarded(me.id)) return null;

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Feed</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>me: {me.username}</div>
      </div>
      <PostFeed token={token} meId={me.id} realtimeUrl={apiBase} silentMode={settings.silentMode} />
    </div>
  );
}

