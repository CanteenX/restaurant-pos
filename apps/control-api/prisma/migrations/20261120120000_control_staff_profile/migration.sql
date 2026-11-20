BEGIN;
ALTER TABLE control.staff ADD COLUMN name varchar(120), ADD COLUMN last_sign_in_at timestamptz;
GRANT UPDATE (name, last_sign_in_at) ON control.staff TO control_runtime;
COMMIT;
