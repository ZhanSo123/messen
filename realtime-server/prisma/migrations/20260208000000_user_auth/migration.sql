-- Add basic auth fields to User.
ALTER TABLE "User" ADD COLUMN "username" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "displayName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;

-- Backfill existing rows (dev seeds), without requiring a DB reset.
UPDATE "User" SET "username" = "id" WHERE "username" IS NULL;
UPDATE "User" SET "displayName" = "username" WHERE "displayName" = '' OR "displayName" IS NULL;

ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;

-- Unique username for login/register.
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

