import type { PrismaClient } from "@prisma/client";
import type { Socket } from "socket.io";

export function chatRoom(chatId: string): string {
  return `chat:${chatId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export async function joinChatRoom(opts: {
  socket: Socket;
  prisma: PrismaClient;
  chatId: string;
}): Promise<boolean> {
  const userId = opts.socket.data.userId as string | undefined;
  if (!userId) return false;

  const member = await opts.prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId: opts.chatId, userId } },
    select: { id: true }
  });
  if (!member) return false;

  opts.socket.join(chatRoom(opts.chatId));
  return true;
}
