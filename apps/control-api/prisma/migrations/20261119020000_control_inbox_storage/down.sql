BEGIN;
LOCK TABLE control.mailbox_cursor, control.ticket_message IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM control.mailbox_cursor) OR EXISTS (SELECT FROM control.ticket_message WHERE direction = 'inbound') THEN
    RAISE EXCEPTION 'Archive and remove inbound records before reverting inbox storage';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'control_mail_worker') THEN
    REVOKE ALL ON control.ticket, control.ticket_message FROM control_mail_worker;
    REVOKE EXECUTE ON FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) FROM control_mail_worker;
    REVOKE USAGE ON SCHEMA control FROM control_mail_worker;
  END IF;
END $$;
DROP TABLE control.mailbox_delivery, control.inbound_receipt, control.mailbox_cursor;
ALTER TABLE control.ticket_message DROP CONSTRAINT message_kind, DROP CONSTRAINT ticket_message_id_direction_key,
  ALTER COLUMN visibility TYPE varchar(5), ALTER COLUMN text TYPE varchar(4000), ALTER COLUMN author_id SET NOT NULL, ALTER COLUMN request_key SET NOT NULL,
  ADD CONSTRAINT ticket_message_direction_check CHECK (direction = 'internal'),
  ADD CONSTRAINT ticket_message_visibility_check CHECK (visibility = 'staff');
COMMIT;
