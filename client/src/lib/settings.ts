export type UserSettings = {
  silentMode: boolean;
  focusChats: string[];
};

const DEFAULT_SETTINGS: UserSettings = {
  silentMode: false,
  focusChats: []
};

function key(meId: string) {
  return `nm:settings:${meId}`;
}

export function loadSettings(meId: string): UserSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(key(meId));
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const silentMode = Boolean(parsed?.silentMode);
    const focusChats = Array.isArray(parsed?.focusChats)
      ? parsed.focusChats.filter((x: any) => typeof x === "string" && x.length > 0).slice(0, 200)
      : [];
    return { silentMode, focusChats };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(meId: string, settings: UserSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key(meId), JSON.stringify(settings));
}

export function toggleChatInFocus(settings: UserSettings, chatId: string): UserSettings {
  const set = new Set(settings.focusChats);
  if (set.has(chatId)) set.delete(chatId);
  else set.add(chatId);
  return { ...settings, focusChats: Array.from(set) };
}

