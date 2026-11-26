import { PrismaClient } from '@prisma/client';
import { quoteIdent } from '../system/db-identity-upgrade';
import { captureSql } from './capture-sql';

export async function installCapture(db: PrismaClient, runtimeRole?: string) {
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('sync_capture'))`,
      );
      for (const sql of captureSql()) await tx.$executeRawUnsafe(sql);
      await tx.$queryRawUnsafe('SELECT sync_install_triggers()');
      await tx.$executeRawUnsafe(`UPDATE sync_state SET "schemaVersion" = (
      SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL
    ) WHERE id = 1`);
      if (!runtimeRole) return;

      // Match the old CASCADE within the app schema, but bake the exact set of
      // targets into the function. A new external FK stops the reset safely.
      const tables = await tx.$queryRaw<
        { name: string }[]
      >`WITH RECURSIVE targets(oid) AS (
      SELECT oid FROM pg_catalog.pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND (public.sync_is_synced_table(relname) OR relname = 'verifactu_records')
      UNION
      SELECT fk.conrelid FROM pg_catalog.pg_constraint AS fk
      JOIN targets ON fk.confrelid = targets.oid WHERE fk.contype = 'f'
    ) SELECT relname AS name FROM targets JOIN pg_catalog.pg_class USING (oid)
      WHERE relnamespace = 'public'::regnamespace ORDER BY relname`;
      const qualified = tables.map(({ name }) => `public.${quoteIdent(name)}`);
      await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.sync_reset_for_adopt() RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        LOCK TABLE public.verifactu_records IN ACCESS EXCLUSIVE MODE;
        IF EXISTS (SELECT 1 FROM public.verifactu_records) THEN RETURN false; END IF;
        ALTER TABLE public.verifactu_records DISABLE TRIGGER verifactu_records_no_truncate;
        TRUNCATE ${qualified.join(', ')};
        ALTER TABLE public.verifactu_records ENABLE TRIGGER verifactu_records_no_truncate;
        RETURN true;
      END $$`);
      await tx.$executeRawUnsafe(
        'REVOKE ALL ON FUNCTION public.sync_reset_for_adopt() FROM PUBLIC',
      );
      await tx.$executeRawUnsafe(
        `GRANT EXECUTE ON FUNCTION public.sync_reset_for_adopt() TO ${quoteIdent(runtimeRole)}`,
      );
    },
    { timeout: 120_000 },
  );
}
