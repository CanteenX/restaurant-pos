BEGIN;
DROP TRIGGER staff_credentials_changed ON control.staff;
DROP FUNCTION control.invalidate_staff_credentials();
ALTER TABLE control.staff DROP COLUMN grants, DROP COLUMN credential_version;
COMMIT;
