BEGIN;
LOCK TABLE control.staff_invite IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM control.staff_invite WHERE expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'Outstanding staff invitations prevent rollback';
  END IF;
END $$;
DROP FUNCTION control.set_staff_enabled(uuid,boolean);
DROP FUNCTION control.redeem_staff_invite(bytea,text);
DROP FUNCTION control.issue_staff_invite(uuid,text,uuid,uuid,bytea,text[],text[],text[]);
DROP TABLE control.staff_invite;
COMMIT;
