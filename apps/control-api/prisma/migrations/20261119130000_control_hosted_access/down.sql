BEGIN;
LOCK TABLE control.hosted_access_event IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM control.hosted_access_event) THEN
    RAISE EXCEPTION 'Archive and remove hosted access history before reverting';
  END IF;
END $$;
DROP TABLE control.hosted_access_event;
UPDATE control.staff SET grants = array_remove(array_remove(grants, 'cc.hosted.read'), 'cc.hosted.manage')
WHERE grants && ARRAY['cc.hosted.read', 'cc.hosted.manage'];
COMMIT;
