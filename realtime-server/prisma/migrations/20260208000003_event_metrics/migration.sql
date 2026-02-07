-- CreateTable
CREATE TABLE "EventMetric" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventMetric_name_createdAt_idx" ON "EventMetric"("name", "createdAt");

-- CreateIndex
CREATE INDEX "EventMetric_createdAt_idx" ON "EventMetric"("createdAt");

-- CreateIndex
CREATE INDEX "EventMetric_userId_createdAt_idx" ON "EventMetric"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "EventMetric" ADD CONSTRAINT "EventMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

