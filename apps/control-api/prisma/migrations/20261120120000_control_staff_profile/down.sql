BEGIN;
ALTER TABLE control.staff DROP COLUMN last_sign_in_at, DROP COLUMN name;
COMMIT;
