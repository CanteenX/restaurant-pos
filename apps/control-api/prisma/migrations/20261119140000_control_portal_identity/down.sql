BEGIN;
LOCK TABLE control.portal_account, control.portal_session, control.portal_auth_limit IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM control.portal_account) THEN
    RAISE EXCEPTION 'Archive and remove portal accounts before reverting portal identity';
  END IF;
END $$;
DROP TRIGGER portal_credentials_changed ON control.portal_account;
DROP FUNCTION control.clear_portal_sessions();
DROP TABLE control.portal_session, control.portal_account, control.portal_auth_limit;
UPDATE control.staff SET grants = array_remove(array_remove(grants,'cc.portal.read'),'cc.portal.manage')
WHERE grants && ARRAY['cc.portal.read','cc.portal.manage'];
COMMIT;
