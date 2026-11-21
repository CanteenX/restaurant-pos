BEGIN;
DROP FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[],text);
DROP FUNCTION control.redeem_staff_invite(bytea,text);
ALTER FUNCTION control.issue_staff_invite_internal_v1(uuid,text,uuid,uuid,bytea,text[],text[],text[],text) RENAME TO issue_staff_invite;
ALTER FUNCTION control.redeem_staff_invite_internal_v1(bytea,text) RENAME TO redeem_staff_invite;
GRANT EXECUTE ON FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[],text),
  control.redeem_staff_invite(bytea,text) TO control_runtime;
COMMIT;
