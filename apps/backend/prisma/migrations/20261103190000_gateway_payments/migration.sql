-- Online payment gateway attempts. Additive only: one new enum and one new
-- table; no existing rows or columns change.

-- CreateEnum
CREATE TYPE "GatewayPaymentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "gateway_payments" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "GatewayPaymentStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "externalId" TEXT,
    "action" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "paymentId" TEXT,
    "settledAt" TIMESTAMP(3),
    "settlementError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payments_paymentId_key" ON "gateway_payments"("paymentId");

-- CreateIndex
CREATE INDEX "gateway_payments_restaurantId_status_idx" ON "gateway_payments"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payments_orderId_idempotencyKey_key" ON "gateway_payments"("orderId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payments_provider_externalId_key" ON "gateway_payments"("provider", "externalId");

-- AddForeignKey
ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
