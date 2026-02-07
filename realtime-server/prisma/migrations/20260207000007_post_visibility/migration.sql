-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PostVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Post_visibility_createdAt_id_idx" ON "Post"("visibility", "createdAt", "id");

-- Backfill: existing post reactions should be treated as public feed.
UPDATE "Reaction" SET "chatId" = 'feed' WHERE "targetType" = 'POST' AND "chatId" IS NULL;

