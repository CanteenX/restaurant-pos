-- Reverses 20261117120000_auth_tokens (not run by Prisma; apply by hand
-- with psql, then the migration can be re-applied later):
--   psql "$DATABASE_URL" -f down.sql
-- Drops only the table this migration added. Outstanding reset and invite
-- links stop working; nothing else changes.
BEGIN;
DROP TABLE IF EXISTS "auth_tokens";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261117120000_auth_tokens';
COMMIT;
