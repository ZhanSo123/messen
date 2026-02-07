"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { clearCachedMe, clearToken, getMe, loadCachedMe, loadToken, saveCachedMe } from "../../lib/auth";
import { isOnboarded } from "../../lib/onboarding";
import { loadSettings, saveSettings, type UserSettings } from "../../lib/settings";

export default function SettingsPage() {
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

  useEffect(() => {
    if (!me) return;
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key === "nm:token" || e.key === "nm:me") {
        const t = loadToken();
        if (!t) router.replace("/login");
        return;
      }
      if (e.key.startsWith(`nm:settings:${me.id}`)) setSettings(loadSettings(me.id));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [me, router]);

  if (!token || !me || !settings) return null;
  if (!isOnboarded(me.id)) return null;

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>Settings</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>me: {me.username}</div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={() => setSettings((s) => (s ? { ...s, silentMode: !s.silentMode } : s))}
          style={{
            padding: "8px 12px",
            border: "1px solid #ddd",
            background: settings.silentMode ? "#111" : "#fff",
            color: settings.silentMode ? "#fff" : "#111"
          }}
        >
          Silent: {settings.silentMode ? "On" : "Off"}
        </button>
        <div style={{ opacity: 0.75, fontSize: 12 }}>A quieter UI (collapses reactions by default).</div>
      </div>

      <button
        onClick={() => {
          clearToken();
          clearCachedMe();
          router.replace("/login");
        }}
        style={{ padding: "10px 14px", border: "1px solid #ddd", background: "#fff", width: "fit-content" }}
      >
        Logout
      </button>
    </div>
  );
}

