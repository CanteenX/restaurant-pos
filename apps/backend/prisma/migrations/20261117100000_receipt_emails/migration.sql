-- Email templates 3/5 (#222): digital receipt emails. Additive only.
ALTER TABLE "restaurants" ADD COLUMN "digitalReceiptsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "receiptEmail" TEXT;
ALTER TABLE "customers" ADD COLUMN "receiptConsentAt" TIMESTAMPTZ(3);

CREATE TABLE "receipt_emails" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "consentAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "receipt_emails_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receipt_emails_orderId_key" ON "receipt_emails"("orderId");
CREATE INDEX "receipt_emails_restaurantId_idx" ON "receipt_emails"("restaurantId");
ALTER TABLE "receipt_emails" ADD CONSTRAINT "receipt_emails_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
