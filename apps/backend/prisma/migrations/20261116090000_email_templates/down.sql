-- Reverses 20261116090000_email_templates (not run by Prisma; apply by hand
-- with psql, then the migration can be re-applied later):
--   psql "$DATABASE_URL" -f down.sql
-- Drops only the two tables this migration added. With the code reverted,
-- every email falls back to its built-in wording.
BEGIN;
DROP TABLE IF EXISTS "email_branding";
DROP TABLE IF EXISTS "email_templates";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261116090000_email_templates';
COMMIT;
