BEGIN;
DROP FUNCTION control.append_audit_event(text, uuid, uuid, text, text, uuid, uuid, text, text[]);
DROP TABLE control.audit_event;
COMMIT;
