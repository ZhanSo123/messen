export type ReactionKey = { msgId: string; emoji: string; userId: string };

export class ReactionStore {
  private byMsg = new Map<string, Map<string, Set<string>>>(); // msgId -> emoji -> userIds

  add(r: ReactionKey) {
    let byEmoji = this.byMsg.get(r.msgId);
    if (!byEmoji) {
      byEmoji = new Map();
      this.byMsg.set(r.msgId, byEmoji);
    }

    let users = byEmoji.get(r.emoji);
    if (!users) {
      users = new Set();
      byEmoji.set(r.emoji, users);
    }
    users.add(r.userId);
  }

  remove(r: ReactionKey) {
    const byEmoji = this.byMsg.get(r.msgId);
    if (!byEmoji) return;
    const users = byEmoji.get(r.emoji);
    if (!users) return;
    users.delete(r.userId);
    if (users.size === 0) byEmoji.delete(r.emoji);
    if (byEmoji.size === 0) this.byMsg.delete(r.msgId);
  }

  hasMine(msgId: string, emoji: string, myUserId: string): boolean {
    const byEmoji = this.byMsg.get(msgId);
    if (!byEmoji) return false;
    const users = byEmoji.get(emoji);
    if (!users) return false;
    return users.has(myUserId);
  }

  listEmojis(msgId: string): string[] {
    const byEmoji = this.byMsg.get(msgId);
    if (!byEmoji) return [];
    // Stable order for UI.
    return Array.from(byEmoji.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

