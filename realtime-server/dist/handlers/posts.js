import { z } from "zod";
import { userRoom } from "../rooms.js";
const FEED_SCOPE = "feed";
const VisibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
const PostNewSchema = z.object({
    tempId: z.string().min(1).max(80),
    text: z
        .string()
        .max(8000)
        .transform((v) => v.trim())
        .refine((v) => v.length > 0 && v.length <= 4000),
    clientTs: z.number().int().nonnegative(),
    visibility: VisibilitySchema.optional()
});
const PostSyncSchema = z.object({
    afterServerTs: z.number().int().nonnegative(),
    afterId: z.string().min(1).max(80).optional()
});
export function registerPostHandlers(opts) {
    const { io, socket, prisma, limiter } = opts;
    socket.on("post:new", async (raw, ack) => {
        const userId = socket.data.userId;
        if (!userId)
            return;
        const parsed = PostNewSchema.safeParse(raw);
        if (!parsed.success) {
            const tempId = typeof raw?.tempId === "string" ? raw.tempId : undefined;
            socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "invalid_payload" });
            return;
        }
        const { tempId, text, clientTs } = parsed.data;
        const visibility = (parsed.data.visibility ?? "PUBLIC");
        const existing = await prisma.post.findUnique({
            where: { authorId_tempId: { authorId: userId, tempId } },
            select: { id: true, createdAt: true, text: true, visibility: true }
        });
        if (existing) {
            if (existing.text !== text || existing.visibility !== visibility) {
                socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "tempid_conflict" });
                return;
            }
            const payload = { tempId, postId: existing.id, serverTs: existing.createdAt.getTime() };
            socket.emit("post:ack", payload);
            ack?.(payload);
            return;
        }
        if (!limiter.consume(`post:new:${userId}`, 1)) {
            socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "rate_limited" });
            return;
        }
        try {
            const created = await prisma.post.create({
                data: {
                    authorId: userId,
                    tempId,
                    text,
                    clientTs: BigInt(clientTs),
                    visibility: visibility
                },
                select: { id: true, createdAt: true, visibility: true }
            });
            // Privacy-safe analytics (no content).
            try {
                await prisma.eventMetric.create({
                    data: {
                        name: created.visibility === "PUBLIC" ? "post_created_public" : "post_created_private",
                        userId
                    }
                });
            }
            catch { }
            const ackPayload = { tempId, postId: created.id, serverTs: created.createdAt.getTime() };
            socket.emit("post:ack", ackPayload);
            ack?.(ackPayload);
            const broadcast = {
                postId: created.id,
                authorId: userId,
                text,
                serverTs: created.createdAt.getTime(),
                visibility: created.visibility
            };
            if (created.visibility === "PUBLIC")
                io.emit("post:broadcast", broadcast);
            else
                io.to(userRoom(userId)).emit("post:broadcast", broadcast);
        }
        catch (e) {
            if (e?.code === "P2002") {
                const raced = await prisma.post.findUnique({
                    where: { authorId_tempId: { authorId: userId, tempId } },
                    select: { id: true, createdAt: true, text: true, visibility: true }
                });
                if (!raced) {
                    socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "server_error" });
                    return;
                }
                if (raced.text !== text || raced.visibility !== visibility) {
                    socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "tempid_conflict" });
                    return;
                }
                const payload = { tempId, postId: raced.id, serverTs: raced.createdAt.getTime() };
                socket.emit("post:ack", payload);
                ack?.(payload);
                return;
            }
            socket.emit("msg:error", { scope: FEED_SCOPE, tempId, reason: "server_error" });
        }
    });
    socket.on("post:sync", async (raw) => {
        const userId = socket.data.userId;
        if (!userId)
            return;
        const parsed = PostSyncSchema.safeParse(raw);
        if (!parsed.success) {
            socket.emit("msg:error", { scope: FEED_SCOPE, reason: "invalid_payload" });
            return;
        }
        const { afterServerTs, afterId } = parsed.data;
        try {
            const cursorTs = new Date(afterServerTs);
            const where = afterId
                ? {
                    AND: [
                        {
                            OR: [
                                { createdAt: { gt: cursorTs } },
                                { AND: [{ createdAt: cursorTs }, { id: { gt: afterId } }] }
                            ]
                        },
                        {
                            OR: [{ visibility: "PUBLIC" }, { visibility: "PRIVATE", authorId: userId }]
                        }
                    ]
                }
                : {
                    AND: [
                        { createdAt: { gt: cursorTs } },
                        { OR: [{ visibility: "PUBLIC" }, { visibility: "PRIVATE", authorId: userId }] }
                    ]
                };
            const rows = await prisma.post.findMany({
                where: where,
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: 50,
                select: { id: true, authorId: true, text: true, createdAt: true, visibility: true }
            });
            const resp = {
                items: rows.map((p) => ({
                    postId: p.id,
                    authorId: p.authorId,
                    text: p.text,
                    serverTs: p.createdAt.getTime(),
                    visibility: p.visibility
                }))
            };
            socket.emit("post:sync:resp", resp);
        }
        catch {
            socket.emit("msg:error", { scope: FEED_SCOPE, reason: "server_error" });
        }
    });
}
