import "dotenv/config";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { extractTokenFromHandshake } from "./auth.js";
import { verifyJwt } from "./authJwt.js";
import { TokenBucketRateLimiter } from "./ratelimit.js";
import { joinChatRoom, userRoom } from "./rooms.js";
import { registerMessageHandlers } from "./handlers/messages.js";
import { registerReactionHandlers } from "./handlers/reactions.js";
import { registerPostHandlers } from "./handlers/posts.js";
import { createHttpHandler } from "./http.js";

const authLimiter = new TokenBucketRateLimiter({
  capacity: 10,
  refillTokens: 10,
  refillMs: 60_000
});

const httpServer = createServer(
  createHttpHandler({
    prisma,
    jwtSecret: config.jwtSecret,
    corsOrigin: config.corsOrigin,
    authLimiter
  })
);

const io = new Server(httpServer, {
  cors: {
    origin: config.corsOrigin,
    credentials: true
  }
});

io.use((socket, next) => {
  try {
    const token = extractTokenFromHandshake(socket.handshake as any);
    if (!token) return next(new Error("unauthorized"));
    const { userId } = verifyJwt(token, config.jwtSecret);
    socket.data.userId = userId;
    return next();
  } catch {
    return next(new Error("unauthorized"));
  }
});

const msgLimiter = new TokenBucketRateLimiter({
  capacity: 10,
  refillTokens: 10,
  refillMs: 2000
});

const postLimiter = new TokenBucketRateLimiter({
  capacity: 3,
  refillTokens: 3,
  refillMs: 10_000
});

const reactLimiter = new TokenBucketRateLimiter({
  capacity: 20,
  refillTokens: 20,
  refillMs: 2000
});

io.on("connection", (socket) => {
  // Per-user room for private feed items (posts/reactions).
  const userId = socket.data.userId as string | undefined;
  if (userId) socket.join(userRoom(userId));

  // Join flow kept explicit to avoid auto-subscribing to arbitrary rooms.
  socket.on("chat:join", async (raw, ack?: (data: { ok: true } | { ok: false }) => void) => {
    const chatId = typeof raw?.chatId === "string" ? raw.chatId : null;
    if (!chatId) return;
    const ok = await joinChatRoom({ socket, prisma, chatId });
    ack?.(ok ? { ok: true } : { ok: false });
  });

  registerMessageHandlers({ io, socket, prisma, limiter: msgLimiter });
  registerReactionHandlers({ io, socket, prisma, limiter: reactLimiter });
  registerPostHandlers({ io, socket, prisma, limiter: postLimiter });
});

httpServer.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[realtime] listening on :${config.port}`);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
