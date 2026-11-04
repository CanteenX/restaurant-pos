-- CreateTable
CREATE TABLE "integration_outbox" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "orderId" TEXT,
    "branchId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "integration_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_outbox_status_nextAttemptAt_idx" ON "integration_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "integration_outbox_connectionId_orderId_createdAt_idx" ON "integration_outbox"("connectionId", "orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "integration_outbox_connectionId_dedupeKey_key" ON "integration_outbox"("connectionId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "integration_outbox" ADD CONSTRAINT "integration_outbox_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

