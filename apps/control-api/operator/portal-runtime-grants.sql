BEGIN;
-- Apply in the dedicated Control database after the DBA creates the NOLOGIN group.
GRANT USAGE ON SCHEMA control TO control_portal_runtime;
GRANT EXECUTE ON FUNCTION control.portal_activate(text,text,text),control.portal_login_verifier(text),
  control.portal_open_session(uuid,text,text),control.portal_lock_session(text),control.portal_logout(text)
  TO control_portal_runtime;
GRANT SELECT, INSERT (bucket,attempts,expires_at), UPDATE (attempts,expires_at), DELETE
  ON control.portal_auth_limit TO control_portal_runtime;
GRANT EXECUTE ON FUNCTION control.portal_business_snapshot() TO control_portal_runtime;
GRANT SELECT ON control.portal_invoice,control.portal_payment,control.portal_outlet TO control_portal_runtime;
GRANT SELECT ON control.portal_ticket_header,control.portal_ticket_conversation TO control_portal_runtime;
GRANT EXECUTE ON FUNCTION control.portal_owns_ticket(uuid),control.portal_open_ticket(uuid,uuid,text,text) TO control_portal_runtime;
COMMIT;
