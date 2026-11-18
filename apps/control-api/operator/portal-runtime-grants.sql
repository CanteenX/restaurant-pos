BEGIN;
-- Apply in the dedicated Control database after the DBA creates the NOLOGIN group.
GRANT USAGE ON SCHEMA control TO control_portal_runtime;
GRANT SELECT (id,business_id,email,status,password_hash,activation_digest,activation_expires_at),
  UPDATE (status,password_hash,activation_digest,activation_expires_at)
  ON control.portal_account TO control_portal_runtime;
GRANT SELECT, INSERT (digest,account_id,expires_at), DELETE ON control.portal_session TO control_portal_runtime;
GRANT SELECT, INSERT (bucket,attempts,expires_at), UPDATE (attempts,expires_at), DELETE
  ON control.portal_auth_limit TO control_portal_runtime;
COMMIT;
