"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";
import { loadSettings, saveSettings, toggleChatInFocus, type UserSettings } from "../lib/settings";
import { loadRecentChats, saveRecentChats } from "../lib/recentChats";
import { PostFeed } from "../components/PostFeed";

export default function HomePage() {
  const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const meId = process.env.NEXT_PUBLIC_ME_ID ?? "u_1";
  const token = process.env.NEXT_PUBLIC_TOKEN ?? "";

  const [settings, setSettings] = useState<UserSettings>(() => loadSettings(meId));
  const [recent, setRecent] = useState<string[]>(() => loadRecentChats(meId));
  const [newChatId, setNewChatId] = useState("");

  useEffect(() => {
    // Cross-tab sync.
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
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
  }, [meId]);

  useEffect(() => {
    saveSettings(meId, settings);
  }, [meId, settings]);

  useEffect(() => {
    saveRecentChats(meId, recent);
  }, [meId, recent]);

  const focusChats = useMemo(
    () => settings.focusChats.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    [settings.focusChats]
  );

  function addFocusChat() {
    const id = newChatId.trim();
    if (!id) return;
    setSettings((s) => toggleChatInFocus(s, id));
    setNewChatId("");
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 720 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Missing token</div>
        <div style={{ opacity: 0.8 }}>
          Set <code>NEXT_PUBLIC_TOKEN</code> in <code>client/.env.local</code> (copy from <code>client/.env.example</code>)
          using the output of <code>realtime-server</code> <code>npm run seed:dev</code>.
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Focus</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          me: {meId} | realtime: {realtimeUrl}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={() => setSettings((s) => ({ ...s, silentMode: !s.silentMode }))}
          style={{ padding: "8px 12px", border: "1px solid #ddd", background: settings.silentMode ? "#111" : "#fff", color: settings.silentMode ? "#fff" : "#111" }}
        >
          Silent: {settings.silentMode ? "On" : "Off"}
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
                  onClick={() => setSettings((s) => toggleChatInFocus(s, chatId))}
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
            placeholder="chatId (e.g. chat_123)"
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
                  onClick={() => setSettings((s) => toggleChatInFocus(s, chatId))}
                  style={{ padding: "6px 10px", border: "1px solid #ddd", background: "#fff" }}
                >
                  Unpin
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <PostFeed token={token} meId={meId} realtimeUrl={realtimeUrl} silentMode={settings.silentMode} />
    </div>
  );
}
