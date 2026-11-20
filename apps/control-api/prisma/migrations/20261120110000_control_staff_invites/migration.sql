BEGIN;
CREATE TABLE control.staff_invite (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(btrim(email))),
  -- Role deletion invalidates outstanding invitations without retaining otherwise unused roles.
  role_id uuid NOT NULL,
  issuer_id uuid NOT NULL REFERENCES control.staff(id) ON DELETE CASCADE,
  role_grants text[] NOT NULL,
  extra_grants text[] NOT NULL,
  removed_grants text[] NOT NULL,
  digest bytea NOT NULL UNIQUE CHECK (octet_length(digest) = 32),
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON control.staff_invite FROM PUBLIC, control_runtime;

CREATE FUNCTION control.issue_staff_invite(target uuid, address text, role uuid, issuer uuid,
    proof bytea, base text[], extra text[], removed text[]) RETURNS timestamptz
LANGUAGE sql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
  INSERT INTO control.staff_invite AS i
    (id, email, role_id, issuer_id, digest, role_grants, extra_grants, removed_grants, expires_at)
  SELECT target, address, role, issuer, proof, base, extra, removed, clock_timestamp() + interval '72 hours'
  WHERE NOT EXISTS (SELECT FROM control.staff WHERE email = address)
  ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id, role_id = EXCLUDED.role_id, issuer_id = EXCLUDED.issuer_id,
    digest = EXCLUDED.digest, role_grants = EXCLUDED.role_grants, extra_grants = EXCLUDED.extra_grants,
    removed_grants = EXCLUDED.removed_grants, expires_at = EXCLUDED.expires_at
  WHERE i.expires_at <= clock_timestamp()
  RETURNING expires_at;
$function$;

CREATE FUNCTION control.redeem_staff_invite(proof bytea, verifier text) RETURNS uuid
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE
  pending record;
  accepted uuid;
BEGIN
  IF octet_length(proof) <> 32 OR verifier !~ '^[$]2b[$]12[$][./A-Za-z0-9]{53}$' THEN RETURN NULL; END IF;
  SELECT i.*, s.grants AS issuer_grants, r.grants AS live_grants, r.is_system
    INTO pending
  FROM control.staff_invite i JOIN control.staff s ON s.id = i.issuer_id
    JOIN control.staff_role r ON r.id = i.role_id
  WHERE i.digest = proof AND i.expires_at > clock_timestamp()
    AND s.enabled AND 'cc.staff.manage' = ANY(s.grants)
  FOR UPDATE OF s, i FOR SHARE OF r;
  IF NOT FOUND OR pending.expires_at <= clock_timestamp()
    OR NOT pending.live_grants <@ pending.role_grants
    OR NOT (pending.live_grants || pending.extra_grants || pending.removed_grants) <@ pending.issuer_grants
    OR (pending.is_system AND cardinality(pending.extra_grants || pending.removed_grants) <> 0)
    THEN RETURN NULL;
  END IF;
  INSERT INTO control.staff (id, email, password_hash, role_id, grants, extra_grants, removed_grants)
  VALUES (pending.id, pending.email, verifier, pending.role_id, ARRAY(SELECT DISTINCT permission
    FROM unnest(pending.live_grants || pending.extra_grants) AS permission
    WHERE NOT permission = ANY(pending.removed_grants)), pending.extra_grants, pending.removed_grants)
  ON CONFLICT (email) DO NOTHING RETURNING id INTO accepted;
  IF accepted IS NOT NULL THEN DELETE FROM control.staff_invite WHERE id = accepted; END IF;
  RETURN accepted;
END;
$function$;

CREATE FUNCTION control.set_staff_enabled(target uuid, active boolean) RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('control.staff_roles'));
  UPDATE control.staff s SET enabled = active WHERE s.id = target AND s.enabled IS DISTINCT FROM active AND (
    active OR NOT EXISTS (SELECT FROM control.staff_role r WHERE r.id = s.role_id AND r.is_system)
    OR EXISTS (SELECT FROM control.staff a JOIN control.staff_role r ON r.id = a.role_id
      WHERE a.id <> target AND a.enabled AND a.encrypted_seed IS NOT NULL AND r.is_system)
  );
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[]),
  control.redeem_staff_invite(bytea,text), control.set_staff_enabled(uuid,boolean) FROM PUBLIC, control_runtime;
GRANT EXECUTE ON FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[]),
  control.redeem_staff_invite(bytea,text), control.set_staff_enabled(uuid,boolean) TO control_runtime;
COMMIT;
