import type { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';

type Connection = Pick<PrismaClient, '$queryRaw' | '$disconnect'>;

/** Return the verified worker connection, or disconnect it before refusing the job. */
export async function verifyMailWorkerDatabase<T extends Connection>(db: T, signal: AbortSignal): Promise<T> {
  try {
    signal.throwIfAborted();
    const [login] = await db.$queryRaw<{ dedicated: boolean }[]>`
      SELECT current_user = session_user AND r.rolcanlogin
        AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
        AND COALESCE(pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('control_mail_worker'), 'USAGE'), false)
        AND NOT COALESCE(pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('control_runtime'), 'MEMBER'), false)
        AND NOT COALESCE(pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('control_staff_operator'), 'MEMBER'), false)
        AND NOT pg_catalog.pg_has_role(r.oid, d.datdba, 'MEMBER')
        AND pg_catalog.has_schema_privilege(r.oid, pg_catalog.to_regnamespace('control'), 'USAGE')
        AND NOT pg_catalog.has_schema_privilege(r.oid, pg_catalog.to_regnamespace('control'), 'CREATE') AS dedicated
      FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_database d ON d.datname = pg_catalog.current_database()
      JOIN pg_catalog.pg_stat_activity a ON a.pid = pg_catalog.pg_backend_pid() AND a.usesysid = r.oid
      WHERE r.rolname = session_user`;
    signal.throwIfAborted();
    if (login?.dedicated === true) return db;
  } catch { /* Keep database diagnostics out of scheduler output. */ }

  try { await db.$disconnect(); } catch { /* Preserve the redacted failure. */ }
  throw new Error('Mail worker database connection refused');
}
