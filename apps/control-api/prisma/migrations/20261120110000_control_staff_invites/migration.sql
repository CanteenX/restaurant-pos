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

-- The runtime remains a trusted auth principal. These checks defend accidental helper bypasses;
-- the application independently verifies the two-factor session before invoking this function.
CREATE FUNCTION control.issue_staff_invite(target uuid, address text, role uuid, issuer uuid,
    proof bytea, base text[], extra text[], removed text[], session_proof text) RETURNS timestamptz
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE actor record; selected record; expiry timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('control.staff_roles'));
  SELECT s.id, s.grants INTO actor FROM control.staff s JOIN control.staff_session ss ON ss.staff_id = s.id
    WHERE ss.digest = session_proof AND s.id = issuer AND s.enabled AND ss.expires_at > clock_timestamp()
      AND ss.verified_at BETWEEN clock_timestamp() - interval '10 minutes' AND clock_timestamp()
      AND 'cc.staff.manage' = ANY(s.grants) FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT r.grants, r.is_system INTO selected FROM control.staff_role r WHERE r.id = role FOR SHARE;
  IF NOT FOUND OR NOT selected.grants <@ base OR NOT base <@ selected.grants
    OR NOT (base || extra || removed) <@ actor.grants
    OR (selected.is_system AND cardinality(extra || removed) <> 0) THEN RETURN NULL; END IF;
  INSERT INTO control.staff_invite AS i
    (id, email, role_id, issuer_id, digest, role_grants, extra_grants, removed_grants, expires_at)
  SELECT target, address, role, issuer, proof, base, extra, removed, clock_timestamp() + interval '72 hours'
  WHERE NOT EXISTS (SELECT FROM control.staff WHERE email = address)
  ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id, role_id = EXCLUDED.role_id, issuer_id = EXCLUDED.issuer_id,
    digest = EXCLUDED.digest, role_grants = EXCLUDED.role_grants, extra_grants = EXCLUDED.extra_grants,
    removed_grants = EXCLUDED.removed_grants, expires_at = EXCLUDED.expires_at
  WHERE i.expires_at <= clock_timestamp() RETURNING expires_at INTO expiry;
  IF expiry IS NOT NULL THEN
    PERFORM control.append_audit_event('staff', actor.id, NULL, 'staff.invite.issue', 'staff', target,
      gen_random_uuid(), 'succeeded', ARRAY['roleId']);
  END IF;
  RETURN expiry;
END;
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
  WHERE i.digest = sha256(proof) AND i.expires_at > clock_timestamp()
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

CREATE FUNCTION control.set_staff_enabled(target uuid, active boolean, session_proof text) RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE actor record; subject record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('control.staff_roles'));
  -- Match the application's ordering before looking up the live session again.
  PERFORM s.id FROM control.staff s WHERE s.id = target OR s.id IN
    (SELECT staff_id FROM control.staff_session WHERE digest = session_proof) ORDER BY s.id FOR UPDATE;
  SELECT s.id, s.grants INTO actor FROM control.staff s JOIN control.staff_session ss ON ss.staff_id = s.id
    WHERE ss.digest = session_proof AND s.enabled AND ss.expires_at > clock_timestamp()
      AND ss.verified_at BETWEEN clock_timestamp() - interval '10 minutes' AND clock_timestamp()
      AND 'cc.staff.manage' = ANY(s.grants);
  IF NOT FOUND OR actor.id = target THEN RETURN false; END IF;
  SELECT s.grants, s.enabled, r.is_system INTO subject FROM control.staff s
    LEFT JOIN control.staff_role r ON r.id = s.role_id WHERE s.id = target;
  IF NOT FOUND OR subject.enabled = active OR NOT subject.grants <@ actor.grants
    OR actor.grants <@ subject.grants OR subject.is_system THEN RETURN false; END IF;
  UPDATE control.staff s SET enabled = active WHERE s.id = target AND (
    active OR NOT EXISTS (SELECT FROM control.staff_role r WHERE r.id = s.role_id AND r.is_system)
    OR EXISTS (SELECT FROM control.staff a JOIN control.staff_role r ON r.id = a.role_id
      WHERE a.id <> target AND a.enabled AND a.encrypted_seed IS NOT NULL AND r.is_system)
  );
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM control.append_audit_event('staff', actor.id, NULL,
    CASE WHEN active THEN 'staff.reactivate' ELSE 'staff.deactivate' END, 'staff', target,
    gen_random_uuid(), 'succeeded', ARRAY['enabled']);
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[],text),
  control.redeem_staff_invite(bytea,text), control.set_staff_enabled(uuid,boolean,text) FROM PUBLIC, control_runtime;
GRANT EXECUTE ON FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[],text),
  control.redeem_staff_invite(bytea,text), control.set_staff_enabled(uuid,boolean,text) TO control_runtime;
COMMIT;
