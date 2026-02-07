-- Post already has (createdAt, id) index from prior migration. This migration adds reaction sync indexes.

CREATE INDEX IF NOT EXISTS "Reaction_targetType_createdAt_id_idx"
ON "Reaction"("targetType", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "Reaction_targetType_chatId_createdAt_id_idx"
ON "Reaction"("targetType", "chatId", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "Reaction_userId_targetType_targetId_idx"
ON "Reaction"("userId", "targetType", "targetId");

