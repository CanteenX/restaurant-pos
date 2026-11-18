BEGIN;
CREATE TABLE control.staff (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  encrypted_seed text,
  last_step integer,
  recovery_digests text[] NOT NULL DEFAULT '{}',
  challenge_digest text UNIQUE,
  challenge_expires_at timestamptz,
  pending_seed text
);
CREATE TABLE control.staff_session (
  digest text PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES control.staff(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX staff_session_expiry ON control.staff_session(expires_at);
CREATE INDEX staff_session_staff ON control.staff_session(staff_id);
CREATE TABLE control.auth_limit (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_limit_expiry ON control.auth_limit(expires_at);
GRANT SELECT, UPDATE (encrypted_seed, last_step, recovery_digests, challenge_digest, challenge_expires_at, pending_seed)
  ON control.staff TO control_runtime;
GRANT SELECT, INSERT, DELETE ON control.staff_session TO control_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.auth_limit TO control_runtime;
COMMIT;
