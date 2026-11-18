BEGIN;
CREATE TABLE control.staff (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email <> '' AND email = lower(btrim(email))),
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  encrypted_seed text,
  last_step integer,
  recovery_digests text[] NOT NULL DEFAULT '{}',
  challenge_digest text UNIQUE CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  challenge_expires_at timestamptz,
  pending_seed text,
  CHECK ((challenge_digest IS NULL) = (challenge_expires_at IS NULL)),
  CHECK (pending_seed IS NULL OR challenge_digest IS NOT NULL)
);
CREATE TABLE control.staff_enrollment_proof (
  staff_id uuid PRIMARY KEY REFERENCES control.staff(id) ON DELETE CASCADE,
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  expires_at timestamptz NOT NULL
);
CREATE TABLE control.staff_session (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  staff_id uuid NOT NULL REFERENCES control.staff(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > verified_at)
);
CREATE INDEX staff_session_expiry ON control.staff_session(expires_at);
CREATE INDEX staff_session_staff ON control.staff_session(staff_id);
CREATE TABLE control.auth_limit (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_limit_expiry ON control.auth_limit(expires_at);

-- Operator provisions SHA-256 of 32 random bytes delivered out of band.
-- Consume in the same transaction that establishes the enrollment challenge.
CREATE FUNCTION control.consume_staff_enrollment(target uuid, proof bytea)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH eligible AS (
    SELECT id FROM control.staff WHERE id = target AND enabled AND encrypted_seed IS NULL FOR UPDATE
  ), consumed AS (
    DELETE FROM control.staff_enrollment_proof p USING eligible
    WHERE p.staff_id = eligible.id AND p.expires_at > clock_timestamp()
      AND octet_length(proof) = 32 AND p.digest = sha256(proof)
    RETURNING p.staff_id
  ) SELECT EXISTS (SELECT FROM consumed);
$function$;

REVOKE ALL ON control.staff, control.staff_session, control.auth_limit, control.staff_enrollment_proof
  FROM PUBLIC, control_runtime;
GRANT SELECT, UPDATE (encrypted_seed, last_step, recovery_digests, challenge_digest, challenge_expires_at, pending_seed)
  ON control.staff TO control_runtime;
GRANT SELECT, INSERT, DELETE ON control.staff_session TO control_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON control.auth_limit TO control_runtime;
REVOKE ALL ON FUNCTION control.consume_staff_enrollment(uuid, bytea) FROM PUBLIC, control_runtime;
GRANT EXECUTE ON FUNCTION control.consume_staff_enrollment(uuid, bytea) TO control_runtime;
COMMIT;
