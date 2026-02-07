function key(meId: string) {
  return `nm:recent:${meId}`;
}

export function loadRecentChats(meId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key(meId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x: any) => typeof x === "string" && x.length > 0).slice(0, 10);
  } catch {
    return [];
  }
}

export function saveRecentChats(meId: string, chatIds: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key(meId), JSON.stringify(chatIds.slice(0, 10)));
}

export function pushRecentChat(meId: string, chatId: string) {
  if (typeof window === "undefined") return;
  const id = chatId.trim();
  if (!id) return;
  const prev = loadRecentChats(meId);
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, 10);
  saveRecentChats(meId, next);
}

