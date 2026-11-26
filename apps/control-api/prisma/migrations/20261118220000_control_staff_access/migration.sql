BEGIN;
ALTER TABLE control.staff
  ADD COLUMN grants text[] NOT NULL DEFAULT '{}' CHECK (cardinality(grants) <= 64 AND array_position(grants, NULL) IS NULL),
  ADD COLUMN credential_version bigint NOT NULL DEFAULT 0;
GRANT UPDATE (grants, credential_version) ON control.staff TO control_runtime;

-- Covered by the caller transaction, including direct operator account changes.
CREATE FUNCTION control.invalidate_staff_credentials() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.credential_version := OLD.credential_version + 1;
  NEW.challenge_digest := NULL;
  NEW.challenge_expires_at := NULL;
  NEW.pending_seed := NULL;
  DELETE FROM control.staff_session WHERE staff_id = OLD.id;
  DELETE FROM control.staff_enrollment_proof WHERE staff_id = OLD.id;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION control.invalidate_staff_credentials() FROM PUBLIC, control_runtime;
CREATE TRIGGER staff_credentials_changed BEFORE UPDATE OF enabled, password_hash, credential_version
ON control.staff FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled
  OR OLD.password_hash IS DISTINCT FROM NEW.password_hash OR OLD.credential_version IS DISTINCT FROM NEW.credential_version)
EXECUTE FUNCTION control.invalidate_staff_credentials();
COMMIT;
