import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  deriveRestorePassword,
  restorePasswordVerifier,
  RESTORE_ROLE,
} from '../backup/restore-role';
import { quoteIdent, quoteLiteral } from './db-identity-upgrade';

export const OWNER = 'nventra_owner';
export const RUNTIME = 'nventra_runtime';
const restricted =
  'NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT';
export const randomPassword = () => randomBytes(32).toString('hex');

export function roleUrl(url: string, role: string, password: string): string {
  const u = new URL(url);
  u.username = role;
  u.password = encodeURIComponent(password);
  return u.toString();
}

const passwordSql = (password: string) =>
  quoteLiteral(restorePasswordVerifier(password));

// Scope the ownership handoff to the app schema. REASSIGN OWNED would also
// transfer the stock administrator's shared objects, including databases.
const handoffSql = `DO $$
DECLARE obj record;
BEGIN
  ALTER SCHEMA public OWNER TO ${OWNER};
  FOR obj IN
    SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind, c.relname
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = current_user::regrole
        AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      ORDER BY (c.relkind = 'S')
  LOOP
    EXECUTE format('ALTER %s public.%I OWNER TO ${OWNER}', obj.kind, obj.relname);
  END LOOP;
  FOR obj IN SELECT oid::regprocedure AS name FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proowner = current_user::regrole
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO ${OWNER}', obj.name);
  END LOOP;
  FOR obj IN SELECT typname FROM pg_type
    WHERE typnamespace = 'public'::regnamespace AND typowner = current_user::regrole
      AND typtype IN ('e', 'd')
  LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO ${OWNER}', obj.typname);
  END LOOP;
END $$`;

export async function prepareOwner(admin: PrismaClient, password: string) {
  await admin.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL search_path = pg_catalog');
    for (const role of [OWNER, RUNTIME, RESTORE_ROLE]) {
      await tx.$executeRawUnsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} ${restricted};
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}' AND
          (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR
           EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid OR roleid = pg_roles.oid))) THEN
          RAISE EXCEPTION 'Unexpected attributes or membership on managed database role ${role}';
        END IF;
      END $$`);
    }
    await tx.$executeRawUnsafe(handoffSql);
    await tx.$executeRawUnsafe(
      `ALTER ROLE ${OWNER} ${restricted} LOGIN PASSWORD ${passwordSql(password)}`,
    );
  });
}

export async function grantDataAccess(admin: PrismaClient, password: string) {
  await admin.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    const [{ db }] = await tx.$queryRaw<
      { db: string }[]
    >`SELECT current_database() AS db`;
    await tx.$executeRawUnsafe(
      `REVOKE CREATE, TEMPORARY ON DATABASE ${quoteIdent(db)} FROM PUBLIC`,
    );
    // Restore reconciles sequence counters in a transaction-local temp table.
    await tx.$executeRawUnsafe(
      `GRANT TEMPORARY ON DATABASE ${quoteIdent(db)} TO ${RESTORE_ROLE}`,
    );
    await tx.$executeRawUnsafe(
      'REVOKE ALL ON public._prisma_migrations FROM PUBLIC',
    );
    for (const [role, secret] of [
      [RUNTIME, password],
      [RESTORE_ROLE, deriveRestorePassword(password)],
    ]) {
      await tx.$executeRawUnsafe(
        `ALTER ROLE ${role} ${restricted} LOGIN PASSWORD ${passwordSql(secret)}`,
      );
      await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.$executeRawUnsafe(
        `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
      );
      await tx.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      );
      await tx.$executeRawUnsafe(
        `REVOKE INSERT, UPDATE, DELETE ON public._prisma_migrations FROM ${role}`,
      );
      await tx.$executeRawUnsafe(
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`,
      );
      await tx.$executeRawUnsafe(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      );
    }
    await tx.$executeRawUnsafe(
      `GRANT UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${RESTORE_ROLE}`,
    );
  });
}

export async function checkRuntime(url: string) {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    const [role] = await client.$queryRaw<{ safe: boolean }[]>`SELECT
      current_user = ${RUNTIME} AND session_user = current_user AND
      NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) OR
        has_database_privilege(current_database(), 'CREATE, TEMP') OR
        EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(oid, 'CREATE')) OR
        EXISTS (SELECT 1 FROM pg_class WHERE relowner = pg_roles.oid) OR
        EXISTS (SELECT 1 FROM pg_proc WHERE proowner = pg_roles.oid) OR
        EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND
          has_table_privilege(format('%I.%I', schemaname, tablename), 'TRIGGER, TRUNCATE')))
      AS safe FROM pg_roles WHERE rolname = current_user`;
    if (!role?.safe)
      throw new Error('Managed runtime database role is elevated or incorrect');
  } finally {
    await client.$disconnect();
  }
}
