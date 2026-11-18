BEGIN;
DROP VIEW control.portal_outlet,control.portal_payment,control.portal_invoice;
DROP FUNCTION control.portal_business_snapshot();
COMMIT;
