import React from "react";
import { ChatView } from "../../../components/ChatView";

export default function ChatPage(props: { params: { chatId: string } }) {
  const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4001";
  const meId = process.env.NEXT_PUBLIC_ME_ID ?? "u_1";
  const token = process.env.NEXT_PUBLIC_TOKEN ?? "";

  const chatId = decodeURIComponent(props.params.chatId);
  return <ChatView chatId={chatId} token={token} meId={meId} realtimeUrl={realtimeUrl} />;
}

