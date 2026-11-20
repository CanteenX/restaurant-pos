BEGIN;
LOCK TABLE control.staff, control.staff_role IN ACCESS EXCLUSIVE MODE;
-- The previous release treats an unknown permission as "deny everything", so remove the new ones first.
UPDATE control.staff SET grants = array_remove(array_remove(grants, 'cc.role.manage'), 'cc.portal.create')
  WHERE 'cc.role.manage' = ANY(grants) OR 'cc.portal.create' = ANY(grants);
DROP TRIGGER staff_role_system_lock ON control.staff_role;
DROP FUNCTION control.guard_system_role();
ALTER TABLE control.staff DROP COLUMN role_id, DROP COLUMN extra_grants, DROP COLUMN removed_grants;
DROP TABLE control.staff_role;
COMMIT;
