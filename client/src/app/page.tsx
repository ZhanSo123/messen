"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useState } from "react";
import { loadSettings, saveSettings, toggleChatInFocus, type UserSettings } from "../lib/settings";
import { loadRecentChats, saveRecentChats } from "../lib/recentChats";
import { PostFeed } from "../components/PostFeed";
import { clearCachedMe, clearToken, getMe, loadCachedMe, loadToken, saveCachedMe } from "../lib/auth";
import { isOnboarded } from "../lib/onboarding";

export default function HomePage() {
  const apiBase = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState(() => loadCachedMe());

  const meId = me?.id ?? null;
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [newChatId, setNewChatId] = useState("");

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
    if (!meId) return;
    setSettings(loadSettings(meId));
    setRecent(loadRecentChats(meId));
  }, [meId]);

  useEffect(() => {
    if (!meId) return;
    if (!isOnboarded(meId)) router.replace("/onboarding");
  }, [meId, router]);

  useEffect(() => {
    if (!meId) return;
    // Cross-tab sync.
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key === "nm:token" || e.key === "nm:me") {
        // Auth changed in another tab.
        const t = loadToken();
        if (!t) {
          router.replace("/login");
          return;
        }
        setToken(t);
        setMe(loadCachedMe());
        return;
      }
      if (e.key.startsWith(`nm:settings:${meId}`)) {
        setSettings(loadSettings(meId));
        return;
      }
      if (e.key.startsWith(`nm:recent:${meId}`)) {
        setRecent(loadRecentChats(meId));
        return;
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [meId, router]);

  useEffect(() => {
    if (!meId || !settings) return;
    saveSettings(meId, settings);
  }, [meId, settings]);

  useEffect(() => {
    if (!meId) return;
    saveRecentChats(meId, recent);
  }, [meId, recent]);

  const focusChats = useMemo(
    () => (settings ? settings.focusChats.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : []),
    [settings]
  );

  function addFocusChat() {
    const id = newChatId.trim();
    if (!id) return;
    setSettings((s) => (s ? toggleChatInFocus(s, id) : s));
    setNewChatId("");
  }

  if (!token || !meId || !settings) return null;
  if (!isOnboarded(meId)) return null;

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Focus</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          me: {me?.username ?? meId} | api: {apiBase}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={() => setSettings((s) => (s ? { ...s, silentMode: !s.silentMode } : s))}
          style={{ padding: "8px 12px", border: "1px solid #ddd", background: settings.silentMode ? "#111" : "#fff", color: settings.silentMode ? "#fff" : "#111" }}
        >
          Silent: {settings.silentMode ? "On" : "Off"}
        </button>
        <button
          onClick={() => {
            clearToken();
            clearCachedMe();
            router.replace("/login");
          }}
          style={{ padding: "8px 12px", border: "1px solid #ddd", background: "#fff" }}
        >
          Logout
        </button>
        <div style={{ opacity: 0.75, fontSize: 12 }}>Silent mode applies inside chat UI.</div>
      </div>

      <div style={{ border: "1px solid #ddd", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Recent chats</div>

        {recent.length === 0 ? (
          <div style={{ opacity: 0.75 }}>No recent chats yet. Open a chat to see it here.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recent.map((chatId) => (
              <div key={`r_${chatId}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Link href={`/chat/${encodeURIComponent(chatId)}`} style={{ textDecoration: "none" }}>
                  <span style={{ fontWeight: 650 }}>{chatId}</span>
                </Link>
                <button
                  onClick={() => setSettings((s) => (s ? toggleChatInFocus(s, chatId) : s))}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #ddd",
                    background: settings.focusChats.includes(chatId) ? "#111" : "#fff",
                    color: settings.focusChats.includes(chatId) ? "#fff" : "#111"
                  }}
                >
                  {settings.focusChats.includes(chatId) ? "Unpin" : "Pin"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ border: "1px solid #ddd", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Focus chats</div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newChatId}
            onChange={(e) => setNewChatId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addFocusChat();
            }}
            placeholder="chatId (e.g. chat_general)"
            style={{ flex: 1, padding: 10, border: "1px solid #ddd" }}
          />
          <button onClick={addFocusChat} style={{ padding: "10px 14px" }}>
            Add
          </button>
        </div>

        {focusChats.length === 0 ? (
          <div style={{ opacity: 0.75 }}>No focus chats yet. Add one to keep the surface quiet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {focusChats.map((chatId) => (
              <div key={chatId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Link href={`/chat/${encodeURIComponent(chatId)}`} style={{ textDecoration: "none" }}>
                  <span style={{ fontWeight: 650 }}>{chatId}</span>
                </Link>
                <button
                  onClick={() => setSettings((s) => (s ? toggleChatInFocus(s, chatId) : s))}
                  style={{ padding: "6px 10px", border: "1px solid #ddd", background: "#fff" }}
                >
                  Unpin
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <PostFeed token={token} meId={meId} realtimeUrl={apiBase} silentMode={settings.silentMode} />
    </div>
  );
}
