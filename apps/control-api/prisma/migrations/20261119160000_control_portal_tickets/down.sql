BEGIN;
LOCK TABLE control.portal_ticket,control.audit_event IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM control.portal_ticket) OR EXISTS (SELECT FROM control.audit_event WHERE actor_type='customer') THEN
    RAISE EXCEPTION 'Portal ticket history prevents rollback';
  END IF;
END $$;
DROP VIEW control.portal_ticket_conversation,control.portal_ticket_header;
DROP FUNCTION control.portal_owns_ticket(uuid),control.portal_open_ticket(uuid,uuid,text,text),
  control.publish_portal_ticket_reply(uuid,uuid,uuid,text);
DROP TABLE control.portal_ticket;
ALTER TABLE control.ticket DROP CONSTRAINT ticket_portal_scope_key;
ALTER TABLE control.portal_account DROP CONSTRAINT portal_account_ticket_scope_key;
DO $$
DECLARE mail_access boolean := false;
BEGIN
  IF to_regrole('control_mail_worker') IS NOT NULL THEN
    mail_access := has_function_privilege('control_mail_worker','control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[])','EXECUTE');
  END IF;
  DROP FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]);
  ALTER FUNCTION control.append_audit_event_core(text,uuid,uuid,text,text,uuid,uuid,text,text[]) RENAME TO append_audit_event;
  GRANT EXECUTE ON FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) TO control_runtime;
  IF mail_access THEN
    GRANT EXECUTE ON FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) TO control_mail_worker;
  END IF;
END $$;
ALTER TABLE control.audit_event DROP CONSTRAINT audit_event_actor_type_check,
  ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('staff','service','system'));
COMMIT;
