BEGIN;
-- Apply as the Control migration owner after the DBA creates the dedicated NOLOGIN group.
GRANT USAGE ON SCHEMA control TO control_staff_operator;
-- Keep issued digests even after consumption, factor reset, or removal of the command.
CREATE TABLE IF NOT EXISTS control.staff_proof_issuance (
  staff_id uuid NOT NULL,
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  PRIMARY KEY (staff_id, digest)
);
REVOKE ALL ON control.staff_proof_issuance FROM PUBLIC, control_runtime, control_staff_operator;
LOCK TABLE control.staff_enrollment_proof IN SHARE MODE;
INSERT INTO control.staff_proof_issuance (staff_id, digest)
  SELECT staff_id, digest FROM control.staff_enrollment_proof ON CONFLICT DO NOTHING;
DROP FUNCTION IF EXISTS control.provision_staff(text,text,text,text[],bytea);
CREATE OR REPLACE FUNCTION control.provision_staff(op text, address text, verifier text, role_key text, proof_digest bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target uuid;
  audit_action text;
  chosen control.staff_role%ROWTYPE;
BEGIN
  IF address IS NULL OR length(address) NOT BETWEEN 3 AND 254 OR address <> lower(btrim(address))
    OR proof_digest IS NULL OR octet_length(proof_digest) <> 32 THEN
    RAISE EXCEPTION 'Invalid provisioning request';
  END IF;
  IF op = 'create' THEN
    IF verifier IS NULL OR verifier !~ '^\$2b\$12\$[./A-Za-z0-9]{53}$'
      OR role_key IS NULL THEN
      RAISE EXCEPTION 'Invalid provisioning request';
    END IF;
    target := gen_random_uuid();
    SELECT * INTO STRICT chosen FROM control.staff_role WHERE key = role_key;
    INSERT INTO control.staff (id, email, password_hash, grants, role_id) VALUES (target, address, verifier, chosen.grants, chosen.id);
    audit_action := 'staff.provision';
  ELSIF op = 'rotate' AND verifier IS NULL AND role_key IS NULL THEN
    SELECT id INTO STRICT target FROM control.staff
      WHERE email = address AND enabled AND encrypted_seed IS NULL FOR UPDATE;
    audit_action := 'staff.issueProof';
  ELSE
    RAISE EXCEPTION 'Invalid provisioning request';
  END IF;
  INSERT INTO control.staff_proof_issuance (staff_id, digest) VALUES (target, proof_digest) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof has already been issued';
  END IF;
  IF op = 'rotate' THEN
    -- The credential-version trigger retires pending challenges, old proofs and sessions.
    UPDATE control.staff SET credential_version = credential_version + 1 WHERE id = target;
  END IF;
  INSERT INTO control.staff_enrollment_proof (staff_id, digest, expires_at)
    VALUES (target, proof_digest, clock_timestamp() + interval '10 minutes');
  PERFORM control.append_audit_event('system', '00000000-0000-4000-8000-000000000295', NULL, audit_action,
    'staff', target, gen_random_uuid(), 'succeeded', ARRAY[]::text[]);
END;
$$;
REVOKE ALL ON FUNCTION control.provision_staff(text,text,text,text,bytea) FROM PUBLIC, control_runtime;
GRANT EXECUTE ON FUNCTION control.provision_staff(text,text,text,text,bytea) TO control_staff_operator;
COMMIT;
