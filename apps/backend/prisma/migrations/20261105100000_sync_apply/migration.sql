-- Multi-branch sync 3/4 (#82): peers, retry state, order flags and the
-- store-credit ledger. Additive only (new tables and nullable/defaulted
-- columns); down.sql next to this file reverses it without touching any
-- existing column, so customers.walletBalance keeps its value either way.

-- AlterTable
ALTER TABLE "sync_state" ADD COLUMN     "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN     "pausedReason" TEXT,
ADD COLUMN     "peerKey" TEXT;

-- CreateTable
CREATE TABLE "sync_peers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchIds" TEXT[],
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "sync_peers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_order_flags" (
    "orderId" TEXT NOT NULL,
    "branchId" TEXT,
    "peer" TEXT NOT NULL,
    "problems" JSONB NOT NULL,
    "flaggedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_order_flags_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "customer_wallet_entries" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "delta" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "refundId" TEXT,
    "orderId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_wallet_entries_idempotencyKey_key" ON "customer_wallet_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_wallet_entries_customerId_createdAt_idx" ON "customer_wallet_entries"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "customer_wallet_entries" ADD CONSTRAINT "customer_wallet_entries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Open the ledger with every customer's current store credit, so
-- sum(delta) = walletBalance from day one. The id and idempotency key derive
-- from the customer id, so HQ and the owning branch create the same row and
-- a later push of the branch's opening entry updates HQ's copy by key.
INSERT INTO "customer_wallet_entries" ("id", "branchId", "customerId", "delta", "reason", "idempotencyKey")
SELECT 'wopen_' || md5(c."id"), c."branchId", c."id", c."walletBalance", 'OPENING', 'opening:' || c."id"
  FROM "customers" c
 WHERE c."walletBalance" <> 0;
