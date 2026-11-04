-- Petty cash float and ledger (#72). Additive only: one enum, two new tables
-- and one defaulted column on cash_closings; existing rows are unchanged.

-- CreateEnum
CREATE TYPE "PettyCashKind" AS ENUM ('TOP_UP', 'PAYOUT', 'ADJUST');

-- AlterTable
ALTER TABLE "cash_closings" ADD COLUMN     "pettyCashTopUps" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "petty_cash_floats" (
    "branchId" TEXT NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "petty_cash_floats_pkey" PRIMARY KEY ("branchId")
);

-- CreateTable
CREATE TABLE "petty_cash_entries" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "kind" "PettyCashKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "receiptRef" TEXT,
    "fromTill" BOOLEAN NOT NULL DEFAULT false,
    "expenseId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_entries_expenseId_key" ON "petty_cash_entries"("expenseId");

-- CreateIndex
CREATE INDEX "petty_cash_entries_branchId_businessDate_idx" ON "petty_cash_entries"("branchId", "businessDate");

-- AddForeignKey
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "petty_cash_entries" ADD CONSTRAINT "petty_cash_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

