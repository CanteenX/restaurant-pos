-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable: existing expenses keep counting (default APPROVED backfills them).
ALTER TABLE "expenses" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "status" "ExpenseStatus" NOT NULL DEFAULT 'APPROVED';

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "expenseApprovalThreshold" DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "expenses_branchId_status_idx" ON "expenses"("branchId", "status");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
