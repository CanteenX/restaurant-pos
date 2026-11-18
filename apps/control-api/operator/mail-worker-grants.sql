BEGIN;
-- Apply in the dedicated Control database after the DBA creates the NOLOGIN group.
GRANT USAGE ON SCHEMA control TO control_mail_worker;
GRANT SELECT, INSERT (mailbox, lease_token, lease_until), UPDATE (uid_validity, through_uid, lease_token, lease_until)
  ON control.mailbox_cursor TO control_mail_worker;
GRANT SELECT, INSERT ON control.inbound_receipt, control.mailbox_delivery TO control_mail_worker;
GRANT SELECT (id, business_id, updated_at), INSERT (id, subject), UPDATE (updated_at) ON control.ticket TO control_mail_worker;
GRANT SELECT (id, ticket_id, sequence), INSERT (id, ticket_id, sequence, direction, visibility, text)
  ON control.ticket_message TO control_mail_worker;
GRANT EXECUTE ON FUNCTION control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[]) TO control_mail_worker;
COMMIT;
