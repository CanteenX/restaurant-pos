BEGIN;
-- Preserve issuance history so reinstalling cannot reauthorize a consumed proof.
DROP FUNCTION control.provision_staff(text,text,text,text,bytea);
REVOKE USAGE ON SCHEMA control FROM control_staff_operator;
COMMIT;
