BEGIN;
CREATE FUNCTION control.portal_business_snapshot() RETURNS TABLE(id uuid, display_name text, hosted_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  tenant uuid := NULLIF(current_setting('control.portal_business_id', true), '')::uuid;
  account uuid := NULLIF(current_setting('control.portal_account_id', true), '')::uuid;
BEGIN
  SELECT b.id,b.display_name INTO id,display_name FROM control.business b
    WHERE b.id=tenant AND NOT b.archived AND EXISTS (
      SELECT FROM control.portal_account a WHERE a.id=account AND a.business_id=b.id AND a.status='active')
    FOR SHARE OF b;
  IF NOT FOUND THEN RETURN; END IF;
  -- Observe a hosted change that committed while the business row lock was pending.
  SELECT COALESCE((SELECT h.status FROM control.hosted_access_event h WHERE h.business_id=tenant
    ORDER BY h.revision DESC LIMIT 1),'active') INTO hosted_status;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION control.portal_business_snapshot() FROM PUBLIC;

CREATE VIEW control.portal_invoice WITH (security_barrier=true) AS
  SELECT i.id,i.business_id,i.reference,i.description,i.amount_paise,i.due_on,i.created_at
  FROM control.portal_business_snapshot() b JOIN control.billing_invoice i ON i.business_id=b.id;
CREATE VIEW control.portal_payment WITH (security_barrier=true) AS
  SELECT p.id,p.business_id,p.invoice_id,p.reference,p.method,p.amount_paise,p.created_at
  FROM control.portal_business_snapshot() b JOIN control.billing_payment p ON p.business_id=b.id;
CREATE VIEW control.portal_outlet WITH (security_barrier=true) AS
  SELECT o.id,o.business_id,o.display_name,o.time_zone,plan.label,plan.starts_at,plan.ends_at
  FROM control.portal_business_snapshot() b JOIN control.outlet o ON o.business_id=b.id
  LEFT JOIN LATERAL (
    SELECT v.label,t.starts_at,t.ends_at FROM control.outlet_service_term t
    JOIN control.service_plan_version v ON (v.code,v.version)=(t.plan_code,t.plan_version)
    WHERE t.outlet_id=o.id AND t.business_id=o.business_id AND t.starts_at<=CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP<t.ends_at
      AND t.revision>COALESCE((SELECT max(c.revision) FROM control.outlet_service_term c
        WHERE c.outlet_id=o.id AND c.operation='cancel'),0)
    ORDER BY t.revision DESC LIMIT 1
  ) plan ON true WHERE b.hosted_status='active' AND NOT o.archived;
REVOKE ALL ON control.portal_invoice,control.portal_payment,control.portal_outlet FROM PUBLIC;
COMMIT;
