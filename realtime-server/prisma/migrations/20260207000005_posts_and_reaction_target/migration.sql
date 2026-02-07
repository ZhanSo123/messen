-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReactionTargetType" AS ENUM ('MESSAGE', 'POST');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "tempId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "clientTs" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Post_authorId_tempId_key" ON "Post"("authorId", "tempId");

-- CreateIndex
CREATE INDEX "Post_createdAt_id_idx" ON "Post"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (Reaction -> generic target)
ALTER TABLE "Reaction" ADD COLUMN "targetType" "ReactionTargetType";
ALTER TABLE "Reaction" ADD COLUMN "targetId" TEXT;
ALTER TABLE "Reaction" ADD COLUMN "chatId" TEXT;

-- Backfill existing message reactions (if any)
UPDATE "Reaction" SET "targetType" = 'MESSAGE', "targetId" = "msgId" WHERE "targetType" IS NULL;
UPDATE "Reaction" r
SET "chatId" = m."chatId"
FROM "Message" m
WHERE r."msgId" = m."id" AND r."chatId" IS NULL;

ALTER TABLE "Reaction" ALTER COLUMN "targetType" SET NOT NULL;
ALTER TABLE "Reaction" ALTER COLUMN "targetId" SET NOT NULL;

-- Drop old indexes/constraints/column
DROP INDEX IF EXISTS "Reaction_msgId_idx";
DROP INDEX IF EXISTS "Reaction_userId_msgId_emoji_key";
ALTER TABLE "Reaction" DROP CONSTRAINT IF EXISTS "Reaction_msgId_fkey";
ALTER TABLE "Reaction" DROP COLUMN IF EXISTS "msgId";

-- New indexes
CREATE UNIQUE INDEX "Reaction_userId_targetType_targetId_emoji_key" ON "Reaction"("userId", "targetType", "targetId", "emoji");
CREATE INDEX "Reaction_targetType_targetId_idx" ON "Reaction"("targetType", "targetId");
CREATE INDEX "Reaction_chatId_idx" ON "Reaction"("chatId");

