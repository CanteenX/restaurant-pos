import { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function openPortalDatabase(url: string) {
  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: url });
    const [login] = await db.$queryRaw<{ dedicated: boolean }[]>`
      SELECT current_user = session_user AND r.rolcanlogin
        AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
        AND COALESCE(pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('control_portal_runtime'), 'USAGE'), false)
        AND NOT COALESCE(pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('control_runtime'), 'MEMBER'), false)
        AND NOT COALESCE(pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('control_staff_operator'), 'MEMBER'), false)
        AND NOT COALESCE(pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('control_mail_worker'), 'MEMBER'), false)
        AND NOT pg_catalog.pg_has_role(r.oid, d.datdba, 'MEMBER')
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_roles p
          WHERE p.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program',
            'pg_read_server_files', 'pg_write_server_files')
          AND pg_catalog.pg_has_role(r.oid, p.oid, 'MEMBER'))
        AND NOT pg_catalog.has_any_column_privilege(r.oid, 'control.staff', 'SELECT,INSERT,UPDATE,REFERENCES')
        AND NOT pg_catalog.has_table_privilege(r.oid, 'control.staff', 'DELETE,TRUNCATE,TRIGGER')
        AND NOT EXISTS (SELECT FROM (VALUES ('control.business'), ('control.outlet'), ('control.billing_invoice'),
          ('control.billing_payment'), ('control.hosted_access_event'), ('control.outlet_service_term'),
          ('control.service_plan_version'), ('control.ticket'), ('control.ticket_message'), ('control.portal_ticket'),
          ('control.inbound_receipt'), ('control.ticket_reply_outbox'), ('control.audit_event')) AS protected(name)
          WHERE pg_catalog.has_any_column_privilege(r.oid, protected.name, 'SELECT,INSERT,UPDATE,REFERENCES')
             OR pg_catalog.has_table_privilege(r.oid, protected.name, 'DELETE,TRUNCATE,TRIGGER'))
        AND NOT pg_catalog.has_function_privilege(r.oid, 'control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[])', 'EXECUTE')
        AND pg_catalog.has_schema_privilege(r.oid, pg_catalog.to_regnamespace('control'), 'USAGE')
        AND NOT pg_catalog.has_schema_privilege(r.oid, pg_catalog.to_regnamespace('control'), 'CREATE') AS dedicated
      FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname = pg_catalog.current_database()
      JOIN pg_catalog.pg_stat_activity a ON a.pid = pg_catalog.pg_backend_pid() AND a.usesysid = r.oid
      WHERE r.rolname = session_user`;
    if (login?.dedicated === true) return db;
  } catch { /* Keep driver diagnostics out of startup output. */ }
  await db?.$disconnect().catch(() => undefined);
  throw new Error('Invalid Control portal database identity');
}
