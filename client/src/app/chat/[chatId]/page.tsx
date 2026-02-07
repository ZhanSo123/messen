"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import { ChatView } from "../../../components/ChatView";
import { clearCachedMe, clearToken, getMe, loadCachedMe, loadToken, saveCachedMe } from "../../../lib/auth";

export default function ChatPage(props: { params: { chatId: string } }) {
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

  const chatId = decodeURIComponent(props.params.chatId);
  if (!token || !me) return null;
  return <ChatView chatId={chatId} token={token} meId={me.id} realtimeUrl={apiBase} />;
}
