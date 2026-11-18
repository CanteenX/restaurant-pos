BEGIN;
-- Apply as the Control migration owner after the DBA creates the dedicated NOLOGIN group.
GRANT USAGE ON SCHEMA control TO control_staff_operator;
CREATE FUNCTION control.provision_staff(op text, address text, verifier text, initial_grants text[], proof_digest bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target uuid;
  audit_action text;
BEGIN
  IF address IS NULL OR length(address) NOT BETWEEN 3 AND 254 OR address <> lower(btrim(address))
    OR proof_digest IS NULL OR octet_length(proof_digest) <> 32 THEN
    RAISE EXCEPTION 'Invalid provisioning request';
  END IF;
  IF op = 'create' THEN
    IF verifier IS NULL OR verifier !~ '^\$2b\$12\$[./A-Za-z0-9]{53}$'
      OR initial_grants IS NULL OR cardinality(initial_grants) NOT BETWEEN 1 AND 64 THEN
      RAISE EXCEPTION 'Invalid provisioning request';
    END IF;
    target := gen_random_uuid();
    INSERT INTO control.staff (id, email, password_hash, grants) VALUES (target, address, verifier, initial_grants);
    audit_action := 'staff.provision';
  ELSIF op = 'rotate' AND verifier IS NULL AND initial_grants IS NULL THEN
    -- The credential-version trigger retires pending challenges, old proofs and sessions.
    SELECT id INTO STRICT target FROM control.staff
      WHERE email = address AND enabled AND encrypted_seed IS NULL FOR UPDATE;
    IF EXISTS (SELECT FROM control.staff_enrollment_proof WHERE staff_id = target AND digest = proof_digest) THEN
      RAISE EXCEPTION 'Replacement proof must be fresh';
    END IF;
    UPDATE control.staff SET credential_version = credential_version + 1 WHERE id = target;
    audit_action := 'staff.issueProof';
  ELSE
    RAISE EXCEPTION 'Invalid provisioning request';
  END IF;
  INSERT INTO control.staff_enrollment_proof (staff_id, digest, expires_at)
    VALUES (target, proof_digest, clock_timestamp() + interval '10 minutes');
  PERFORM control.append_audit_event('system', '00000000-0000-4000-8000-000000000295', NULL, audit_action,
    'staff', target, gen_random_uuid(), 'succeeded', ARRAY[]::text[]);
END;
$$;
REVOKE ALL ON FUNCTION control.provision_staff(text,text,text,text[],bytea) FROM PUBLIC, control_runtime;
GRANT EXECUTE ON FUNCTION control.provision_staff(text,text,text,text[],bytea) TO control_staff_operator;
COMMIT;
