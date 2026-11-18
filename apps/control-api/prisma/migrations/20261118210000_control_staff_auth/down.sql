BEGIN;
DROP FUNCTION control.consume_staff_enrollment(uuid, bytea);
DROP TABLE control.auth_limit;
DROP TABLE control.staff_session;
DROP TABLE control.staff_enrollment_proof;
DROP TABLE control.staff;
COMMIT;
