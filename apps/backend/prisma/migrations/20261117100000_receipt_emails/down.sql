-- Reverses 20261117100000_receipt_emails (not run by Prisma; apply with psql).
BEGIN;
DROP TABLE IF EXISTS "receipt_emails";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "receiptConsentAt";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "receiptEmail";
ALTER TABLE "restaurants" DROP COLUMN IF EXISTS "digitalReceiptsEnabled";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261117100000_receipt_emails';
COMMIT;
