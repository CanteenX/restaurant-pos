BEGIN;
CREATE TABLE control.portal_account (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES control.business(id) ON DELETE RESTRICT,
  email varchar(254) NOT NULL UNIQUE CHECK (email <> '' AND email = lower(btrim(email))),
  status varchar(7) NOT NULL,
  password_hash text,
  activation_digest text UNIQUE CHECK (activation_digest ~ '^[0-9a-f]{64}$'),
  activation_expires_at timestamptz(3),
  CHECK ((status = 'pending' AND password_hash IS NULL AND activation_digest IS NOT NULL AND activation_expires_at IS NOT NULL)
      OR (status = 'active' AND password_hash IS NOT NULL AND activation_digest IS NULL AND activation_expires_at IS NULL)
      OR (status = 'revoked' AND password_hash IS NULL AND activation_digest IS NULL AND activation_expires_at IS NULL))
);
CREATE INDEX portal_account_business ON control.portal_account(business_id,id);
CREATE TABLE control.portal_session (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES control.portal_account(id) ON DELETE CASCADE,
  expires_at timestamptz(3) NOT NULL
);
CREATE INDEX portal_session_account ON control.portal_session(account_id);
CREATE INDEX portal_session_expiry ON control.portal_session(expires_at);
CREATE TABLE control.portal_auth_limit (
  bucket text PRIMARY KEY CHECK (bucket ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 24),
  expires_at timestamptz(3) NOT NULL
);
CREATE INDEX portal_limit_expiry ON control.portal_auth_limit(expires_at);

CREATE FUNCTION control.clear_portal_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
BEGIN
  DELETE FROM control.portal_session WHERE account_id = OLD.id;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION control.clear_portal_sessions() FROM PUBLIC,control_runtime;
CREATE TRIGGER portal_credentials_changed AFTER UPDATE OF status,password_hash,activation_digest ON control.portal_account
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
  OR OLD.activation_digest IS DISTINCT FROM NEW.activation_digest) EXECUTE FUNCTION control.clear_portal_sessions();

REVOKE ALL ON control.portal_account,control.portal_session,control.portal_auth_limit FROM PUBLIC,control_runtime;
GRANT SELECT (id,business_id,email,status,activation_expires_at),
  INSERT (id,business_id,email,status,activation_digest,activation_expires_at),
  UPDATE (status,password_hash,activation_digest,activation_expires_at) ON control.portal_account TO control_runtime;

-- Preserve full-access staff with the exact previous permission set.
WITH prior(grants) AS (VALUES (ARRAY['cc.staff.read','cc.staff.manage','cc.business.read','cc.business.manage',
  'cc.plan.read','cc.plan.manage','cc.audit.read','cc.ticket.read','cc.ticket.manage','cc.ticket.reply',
  'cc.billing.read','cc.billing.manage','cc.hosted.read','cc.hosted.manage']))
UPDATE control.staff s SET grants = s.grants || ARRAY['cc.portal.read','cc.portal.manage'] FROM prior
WHERE s.grants @> prior.grants AND cardinality(s.grants) = cardinality(prior.grants);
COMMIT;
