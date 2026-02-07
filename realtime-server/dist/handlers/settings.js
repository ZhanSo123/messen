import { z } from "zod";
const SettingsSchema = z.object({
    silentMode: z.boolean().optional(),
    focusChats: z.array(z.string().min(1).max(80)).max(200).optional()
});
export function registerSettingsHandlers(opts) {
    const { socket, store } = opts;
    function getOrDefault(userId) {
        return store.get(userId) ?? { silentMode: false, focusChats: [] };
    }
    socket.on("settings:get", () => {
        const userId = socket.data.userId;
        if (!userId)
            return;
        socket.emit("settings:resp", getOrDefault(userId));
    });
    socket.on("settings:set", (raw, ack) => {
        const userId = socket.data.userId;
        if (!userId)
            return;
        const parsed = SettingsSchema.safeParse(raw);
        if (!parsed.success) {
            socket.emit("msg:error", { reason: "invalid_payload" });
            ack?.({ ok: false });
            return;
        }
        const current = getOrDefault(userId);
        const next = {
            silentMode: parsed.data.silentMode ?? current.silentMode,
            focusChats: parsed.data.focusChats ?? current.focusChats
        };
        store.set(userId, next);
        ack?.({ ok: true, settings: next });
        socket.emit("settings:resp", next);
    });
}
