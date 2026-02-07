export function chatRoom(chatId) {
    return `chat:${chatId}`;
}
export function userRoom(userId) {
    return `user:${userId}`;
}
export async function joinChatRoom(opts) {
    const userId = opts.socket.data.userId;
    if (!userId)
        return false;
    const member = await opts.prisma.chatMember.findUnique({
        where: { chatId_userId: { chatId: opts.chatId, userId } },
        select: { id: true }
    });
    if (!member)
        return false;
    opts.socket.join(chatRoom(opts.chatId));
    return true;
}
