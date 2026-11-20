BEGIN;
CREATE TABLE control.staff_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9-]{1,47}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  grants text[] NOT NULL DEFAULT '{}' CHECK (cardinality(grants) <= 64 AND array_position(grants, NULL) IS NULL),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- Starting roles are ordinary data rows. Admin is the only locked system role.
INSERT INTO control.staff_role (key, name, description, grants, is_system) VALUES
  ('admin', 'Admin', 'Everything. Locked: cannot be edited or deleted.', ARRAY['cc.staff.read','cc.staff.manage','cc.role.manage',
    'cc.business.read','cc.business.manage','cc.plan.read','cc.plan.manage','cc.audit.read','cc.billing.read','cc.billing.manage',
    'cc.hosted.read','cc.hosted.manage','cc.portal.read','cc.portal.create','cc.portal.manage','cc.ticket.read','cc.ticket.manage','cc.ticket.reply'], true),
  ('manager', 'Manager', 'Everything except billing and payments.', ARRAY['cc.staff.read','cc.staff.manage','cc.role.manage',
    'cc.business.read','cc.business.manage','cc.plan.read','cc.plan.manage','cc.audit.read','cc.hosted.read','cc.hosted.manage',
    'cc.portal.read','cc.portal.create','cc.portal.manage','cc.ticket.read','cc.ticket.manage','cc.ticket.reply'], false),
  ('support', 'Support', 'Tickets, plus read-only business and plan details.',
    ARRAY['cc.business.read','cc.plan.read','cc.ticket.read','cc.ticket.manage','cc.ticket.reply'], false),
  ('marketing', 'Marketing', 'Add and edit businesses and outlets, create customer portal logins, read plans.',
    ARRAY['cc.business.read','cc.business.manage','cc.plan.read','cc.portal.read','cc.portal.create'], false);

ALTER TABLE control.staff
  ADD COLUMN role_id uuid REFERENCES control.staff_role(id) ON DELETE RESTRICT,
  ADD COLUMN extra_grants text[] NOT NULL DEFAULT '{}' CHECK (cardinality(extra_grants) <= 64 AND array_position(extra_grants, NULL) IS NULL),
  ADD COLUMN removed_grants text[] NOT NULL DEFAULT '{}' CHECK (cardinality(removed_grants) <= 64 AND array_position(removed_grants, NULL) IS NULL);
CREATE INDEX staff_role_id_idx ON control.staff (role_id);

-- Creating portal logins is now its own permission: everyone who held cc.portal.manage keeps it by also getting cc.portal.create.
UPDATE control.staff SET grants = array_append(grants, 'cc.portal.create')
  WHERE 'cc.portal.manage' = ANY(grants) AND NOT 'cc.portal.create' = ANY(grants);
-- Backfill without changing anyone's access. Identical grant sets join the matching seed role (Admin also matches the
-- former full catalog and gains only the new role-management permission). Everyone else keeps their stored grants
-- under a personal legacy role.
UPDATE control.staff s SET role_id = r.id, grants = r.grants FROM control.staff_role r
  WHERE r.key = 'admin' AND s.grants <@ r.grants AND s.grants @> array_remove(r.grants, 'cc.role.manage');
UPDATE control.staff s SET role_id = r.id FROM control.staff_role r
  WHERE s.role_id IS NULL AND r.key <> 'admin' AND s.grants <@ r.grants AND s.grants @> r.grants;
INSERT INTO control.staff_role (key, name, description, grants)
  SELECT 'legacy-' || id, 'Legacy access ' || left(id::text, 8), 'Grants stored before roles existed.', grants
  FROM control.staff WHERE role_id IS NULL;
UPDATE control.staff s SET role_id = r.id FROM control.staff_role r WHERE s.role_id IS NULL AND r.key = 'legacy-' || s.id;

-- Defence in depth: the runtime login cannot touch a system role even if the application check is bypassed.
CREATE FUNCTION control.guard_system_role() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF pg_has_role(current_user, 'control_runtime', 'MEMBER') AND
     (TG_OP = 'INSERT' AND NEW.is_system OR TG_OP <> 'INSERT' AND OLD.is_system) THEN
    RAISE EXCEPTION 'System roles are locked' USING ERRCODE = '42501';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
CREATE TRIGGER staff_role_system_lock BEFORE INSERT OR UPDATE OR DELETE ON control.staff_role
  FOR EACH ROW EXECUTE FUNCTION control.guard_system_role();

REVOKE ALL ON control.staff_role FROM PUBLIC, control_runtime;
GRANT SELECT, INSERT, DELETE ON control.staff_role TO control_runtime;
GRANT UPDATE (name, description, grants, updated_at, updated_by) ON control.staff_role TO control_runtime;
GRANT UPDATE (role_id, extra_grants, removed_grants) ON control.staff TO control_runtime;
COMMIT;
