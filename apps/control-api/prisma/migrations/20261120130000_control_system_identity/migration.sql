BEGIN;
-- Preserve the reviewed lifecycle implementation behind narrow, non-callable entry points.
ALTER FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[],text) RENAME TO issue_staff_invite_internal_v1;
ALTER FUNCTION control.redeem_staff_invite(bytea,text) RENAME TO redeem_staff_invite_internal_v1;
REVOKE ALL ON FUNCTION control.issue_staff_invite_internal_v1(uuid,text,uuid,uuid,bytea,text[],text[],text[],text),
  control.redeem_staff_invite_internal_v1(bytea,text) FROM PUBLIC, control_runtime;

CREATE FUNCTION control.issue_staff_invite(target uuid, address text, role uuid, issuer uuid,
  proof bytea, base text[], extra text[], removed text[], session_proof text) RETURNS timestamptz
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('control.staff_roles'));
  IF EXISTS (SELECT FROM control.staff_role WHERE id = role AND is_system)
    AND NOT EXISTS (SELECT FROM control.staff s JOIN control.staff_role r ON r.id = s.role_id
      WHERE s.id = issuer AND r.is_system) THEN RETURN NULL; END IF;
  RETURN control.issue_staff_invite_internal_v1(target, address, role, issuer, proof, base, extra, removed, session_proof);
END;
$function$;

CREATE FUNCTION control.redeem_staff_invite(proof bytea, verifier text) RETURNS uuid
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('control.staff_roles'));
  IF EXISTS (SELECT FROM control.staff_invite i JOIN control.staff_role r ON r.id = i.role_id
      WHERE i.digest = sha256(proof) AND r.is_system
        AND NOT EXISTS (SELECT FROM control.staff s JOIN control.staff_role issuer_role ON issuer_role.id = s.role_id
          WHERE s.id = i.issuer_id AND issuer_role.is_system)) THEN RETURN NULL; END IF;
  RETURN control.redeem_staff_invite_internal_v1(proof, verifier);
END;
$function$;
REVOKE ALL ON FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[],text),
  control.redeem_staff_invite(bytea,text) FROM PUBLIC, control_runtime;
GRANT EXECUTE ON FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[],text),
  control.redeem_staff_invite(bytea,text) TO control_runtime;
COMMIT;
