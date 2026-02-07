"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { clearCachedMe, clearToken, getMe, loadCachedMe, loadToken, saveCachedMe } from "../../lib/auth";
import { isOnboarded } from "../../lib/onboarding";
import { loadSettings, saveSettings, type UserSettings } from "../../lib/settings";
import { trackMetric } from "../../lib/metrics";

type InviteItem = { code: string; createdAt: number };

export default function SettingsPage() {
  const apiBase = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState(() => loadCachedMe());
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [origin, setOrigin] = useState<string>("");

  useEffect(() => {
    const t = loadToken();
    if (!t) {
      router.replace("/login");
      return;
    }
    setToken(t);
  }, [router]);

  useEffect(() => {
    setOrigin(typeof window !== "undefined" ? window.location.origin : "");
  }, []);

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

  async function loadInvites(t: string) {
    setInviteErr(null);
    try {
      const res = await fetch(`${apiBase}/invite/mine`, { method: "GET", headers: { authorization: `Bearer ${t}` } });
      if (res.status === 401) {
        clearToken();
        clearCachedMe();
        router.replace("/login");
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setInviteErr(String(data?.error ?? "failed"));
        return;
      }
      const items: InviteItem[] = Array.isArray(data?.items) ? data.items : [];
      setInvites(items);
    } catch {
      setInviteErr("server_unavailable");
    }
  }

  async function createInvite(t: string) {
    setInviteBusy(true);
    setInviteErr(null);
    try {
      const res = await fetch(`${apiBase}/invite/create`, { method: "POST", headers: { authorization: `Bearer ${t}` } });
      if (res.status === 401) {
        clearToken();
        clearCachedMe();
        router.replace("/login");
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setInviteErr(String(data?.error ?? "failed"));
        return;
      }
      await loadInvites(t);
    } catch {
      setInviteErr("server_unavailable");
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeInvite(t: string, code: string) {
    setInviteBusy(true);
    setInviteErr(null);
    try {
      const res = await fetch(`${apiBase}/invite/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: JSON.stringify({ code })
      });
      if (res.status === 401) {
        clearToken();
        clearCachedMe();
        router.replace("/login");
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setInviteErr(String(data?.error ?? "failed"));
        return;
      }
      await loadInvites(t);
    } catch {
      setInviteErr("server_unavailable");
    } finally {
      setInviteBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore: iOS may block without user gesture; the button click is a gesture though.
    }
  }

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

  useEffect(() => {
    if (!token) return;
    void loadInvites(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
          onClick={() =>
            setSettings((s) => {
              if (!s) return s;
              const next = { ...s, silentMode: !s.silentMode };
              void trackMetric({ apiBase, token, name: next.silentMode ? "silent_enabled" : "silent_disabled" });
              return next;
            })
          }
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

      <div style={{ border: "1px solid #ddd", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontWeight: 800 }}>Invites</div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>Closed alpha. Create up to 5 active invite codes.</div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => createInvite(token)}
            disabled={inviteBusy}
            style={{ padding: "10px 14px", border: "1px solid #ddd", background: "#fff", width: "fit-content" }}
          >
            {inviteBusy ? "Creating..." : "Create"}
          </button>
          <button
            onClick={() => loadInvites(token)}
            style={{ padding: "10px 14px", border: "1px solid #ddd", background: "#fff", width: "fit-content" }}
          >
            Refresh
          </button>
          {inviteErr ? <div style={{ color: "#b00020", fontSize: 12 }}>error: {inviteErr}</div> : null}
        </div>

        {invites.length === 0 ? (
          <div style={{ opacity: 0.75, fontSize: 12 }}>No active invites.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {invites.map((it) => (
              <div
                key={it.code}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #eee", padding: 10 }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{it.code}</div>
                  {origin ? (
                    <div style={{ opacity: 0.72, fontSize: 12, wordBreak: "break-all" }}>
                      {origin}/register?invite={it.code}
                    </div>
                  ) : null}
                  <div style={{ opacity: 0.65, fontSize: 12 }}>{new Date(it.createdAt).toLocaleString()}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={() => copy(it.code)}
                    style={{ padding: "8px 12px", border: "1px solid #ddd", background: "#fff" }}
                  >
                    Copy code
                  </button>
                  <button
                    onClick={() => origin && copy(`${origin}/register?invite=${it.code}`)}
                    style={{ padding: "8px 12px", border: "1px solid #ddd", background: "#fff" }}
                    disabled={!origin}
                  >
                    Copy link
                  </button>
                  <button
                    onClick={() => revokeInvite(token, it.code)}
                    style={{ padding: "8px 12px", border: "1px solid #ddd", background: "#fff" }}
                    disabled={inviteBusy}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
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
