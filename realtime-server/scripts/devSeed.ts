import "dotenv/config";
import jwt from "jsonwebtoken";
import { prisma } from "../src/db.js";
import { config } from "../src/config.js";

async function main() {
  // Predictable IDs for MVP local dev.
  const meId = "u_1";
  const otherId = "u_2";
  const chatId = "chat_123";

  await prisma.user.upsert({
    where: { id: meId },
    update: {},
    create: { id: meId }
  });

  await prisma.user.upsert({
    where: { id: otherId },
    update: {},
    create: { id: otherId }
  });

  await prisma.chat.upsert({
    where: { id: chatId },
    update: {},
    create: { id: chatId }
  });

  await prisma.chatMember.upsert({
    where: { chatId_userId: { chatId, userId: meId } },
    update: {},
    create: { chatId, userId: meId }
  });

  await prisma.chatMember.upsert({
    where: { chatId_userId: { chatId, userId: otherId } },
    update: {},
    create: { chatId, userId: otherId }
  });

  const meToken = jwt.sign({ sub: meId }, config.jwtSecret, { expiresIn: "7d" });
  const otherToken = jwt.sign({ sub: otherId }, config.jwtSecret, { expiresIn: "7d" });

  // eslint-disable-next-line no-console
  console.log("Seed OK");
  // eslint-disable-next-line no-console
  console.log("chatId:", chatId);
  // eslint-disable-next-line no-console
  console.log("meId:", meId);
  // eslint-disable-next-line no-console
  console.log("meToken:", meToken);
  // eslint-disable-next-line no-console
  console.log("otherId:", otherId);
  // eslint-disable-next-line no-console
  console.log("otherToken:", otherToken);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

