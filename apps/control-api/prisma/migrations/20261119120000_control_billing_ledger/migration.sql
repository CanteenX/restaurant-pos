BEGIN;
CREATE TABLE control.billing_invoice (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES control.business(id),
  request_key uuid NOT NULL, created_by uuid NOT NULL REFERENCES control.staff(id),
  reference varchar(120) NOT NULL CHECK (btrim(reference) <> ''), description varchar(1000) NOT NULL CHECK (btrim(description) <> ''),
  amount_paise bigint NOT NULL CHECK (amount_paise BETWEEN 1 AND 9007199254740991), due_on date NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,id), UNIQUE (business_id,request_key)
);
CREATE INDEX billing_invoice_due_idx ON control.billing_invoice(due_on,id);
CREATE TABLE control.billing_payment (
  id uuid PRIMARY KEY, business_id uuid NOT NULL, invoice_id uuid NOT NULL,
  request_key uuid NOT NULL, created_by uuid NOT NULL REFERENCES control.staff(id),
  reference varchar(120) NOT NULL CHECK (reference=btrim(reference) AND reference <> ''),
  method varchar(13) NOT NULL CHECK (method IN ('bank_transfer','upi')),
  amount_paise bigint NOT NULL CHECK (amount_paise BETWEEN 1 AND 9007199254740991),
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal > 0), created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (business_id,invoice_id) REFERENCES control.billing_invoice(business_id,id),
  UNIQUE (invoice_id,request_key), UNIQUE (invoice_id,method,reference), UNIQUE (invoice_id,ordinal)
);
CREATE FUNCTION control.lock_billing_payments(target uuid) RETURNS void LANGUAGE sql
SET search_path=pg_catalog,pg_temp AS $$ SELECT pg_advisory_xact_lock(1314276190,hashtext(target::text)) $$;
CREATE FUNCTION control.check_billing_payment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE total bigint; paid numeric;
BEGIN
  PERFORM control.lock_billing_payments(NEW.invoice_id);
  SELECT amount_paise INTO STRICT total FROM control.billing_invoice WHERE id=NEW.invoice_id AND business_id=NEW.business_id;
  SELECT coalesce(sum(amount_paise),0),coalesce(max(ordinal),0)+1 INTO paid,NEW.ordinal
    FROM control.billing_payment WHERE invoice_id=NEW.invoice_id;
  IF NEW.amount_paise > total-paid THEN RAISE EXCEPTION 'Payment exceeds balance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_payment_balance BEFORE INSERT ON control.billing_payment FOR EACH ROW EXECUTE FUNCTION control.check_billing_payment();
REVOKE ALL ON control.billing_invoice,control.billing_payment FROM PUBLIC,control_runtime;
GRANT SELECT,INSERT (id,business_id,request_key,created_by,reference,description,amount_paise,due_on) ON control.billing_invoice TO control_runtime;
GRANT SELECT,INSERT (id,business_id,invoice_id,request_key,created_by,reference,method,amount_paise) ON control.billing_payment TO control_runtime;
REVOKE ALL ON FUNCTION control.lock_billing_payments(uuid),control.check_billing_payment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.lock_billing_payments(uuid) TO control_runtime;
-- Any successful ledger insert, including a direct runtime-role insert, appends minimal audit metadata.
CREATE FUNCTION control.audit_billing_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $audit$
DECLARE invoice boolean := TG_TABLE_NAME='billing_invoice';
BEGIN
  PERFORM control.append_audit_event('staff',NEW.created_by,NEW.business_id,
    CASE WHEN invoice THEN 'billing.invoice.create' ELSE 'billing.payment.record' END,
    CASE WHEN invoice THEN 'invoice' ELSE 'payment' END,NEW.id,NEW.request_key,'succeeded',
    CASE WHEN invoice THEN ARRAY['reference','description','dueOn','amountPaise'] ELSE ARRAY['invoiceId','reference','method','amountPaise'] END);
  RETURN NULL;
END $audit$;
CREATE TRIGGER audit_invoice AFTER INSERT ON control.billing_invoice FOR EACH ROW EXECUTE FUNCTION control.audit_billing_entry();
CREATE TRIGGER audit_payment AFTER INSERT ON control.billing_payment FOR EACH ROW EXECUTE FUNCTION control.audit_billing_entry();
REVOKE ALL ON FUNCTION control.audit_billing_entry() FROM PUBLIC;
WITH prior(grants) AS (VALUES (ARRAY['cc.staff.read','cc.staff.manage','cc.business.read','cc.business.manage',
  'cc.plan.read','cc.plan.manage','cc.audit.read','cc.ticket.read','cc.ticket.manage','cc.ticket.reply']))
UPDATE control.staff s SET grants=s.grants||ARRAY['cc.billing.read','cc.billing.manage'] FROM prior
WHERE s.grants @> prior.grants AND cardinality(s.grants)=cardinality(prior.grants);
COMMIT;
