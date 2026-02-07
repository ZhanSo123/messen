import "dotenv/config";
import { prisma } from "../src/db.js";
import { config } from "../src/config.js";
import { signJwt } from "../src/authJwt.js";
import bcrypt from "bcryptjs";

async function main() {
  // Predictable IDs for MVP local dev.
  const meId = "u_1";
  const otherId = "u_2";
  const chatId = "chat_general";

  const seedPassword = "password123";
  const seedHash = await bcrypt.hash(seedPassword, 10);

  await prisma.user.upsert({
    where: { id: meId },
    update: { username: "u_1", passwordHash: seedHash, displayName: "u_1" },
    create: { id: meId, username: "u_1", passwordHash: seedHash, displayName: "u_1" }
  });

  await prisma.user.upsert({
    where: { id: otherId },
    update: { username: "u_2", passwordHash: seedHash, displayName: "u_2" },
    create: { id: otherId, username: "u_2", passwordHash: seedHash, displayName: "u_2" }
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

  const meToken = signJwt(meId, config.jwtSecret);
  const otherToken = signJwt(otherId, config.jwtSecret);

  // eslint-disable-next-line no-console
  console.log("Seed OK");
  // eslint-disable-next-line no-console
  console.log("chatId:", chatId);
  // eslint-disable-next-line no-console
  console.log("meId:", meId);
  // eslint-disable-next-line no-console
  console.log("meUsername:", "u_1");
  // eslint-disable-next-line no-console
  console.log("mePassword:", seedPassword);
  // eslint-disable-next-line no-console
  console.log("meToken:", meToken);
  // eslint-disable-next-line no-console
  console.log("otherId:", otherId);
  // eslint-disable-next-line no-console
  console.log("otherUsername:", "u_2");
  // eslint-disable-next-line no-console
  console.log("otherPassword:", seedPassword);
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
