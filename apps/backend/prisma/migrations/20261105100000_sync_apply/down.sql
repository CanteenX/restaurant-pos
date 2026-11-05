-- Reverses 20261105100000_sync_apply (not run by Prisma; apply by hand with
-- psql, then delete the migration's row so it can be re-applied later):
--   psql "$DATABASE_URL" -f down.sql
-- Only objects this migration added are dropped. customers.walletBalance is
-- untouched, so no balance changes.
BEGIN;
DROP TABLE IF EXISTS "customer_wallet_entries";
DROP TABLE IF EXISTS "sync_order_flags";
DROP TABLE IF EXISTS "sync_peers";
ALTER TABLE "sync_state"
  DROP COLUMN IF EXISTS "branchIds",
  DROP COLUMN IF EXISTS "failures",
  DROP COLUMN IF EXISTS "nextAttemptAt",
  DROP COLUMN IF EXISTS "pausedReason",
  DROP COLUMN IF EXISTS "peerKey";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261105100000_sync_apply';
COMMIT;
