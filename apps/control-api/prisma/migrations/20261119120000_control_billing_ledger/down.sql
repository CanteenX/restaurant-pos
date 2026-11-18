BEGIN;
LOCK TABLE control.billing_invoice,control.billing_payment IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM control.billing_invoice) THEN
    RAISE EXCEPTION 'Archive and remove billing records before reverting the ledger';
  END IF;
END $$;
DROP TABLE control.billing_payment,control.billing_invoice;
DROP FUNCTION control.audit_billing_entry(),control.check_billing_payment(),control.lock_billing_payments(uuid);
UPDATE control.staff SET grants=array_remove(array_remove(grants,'cc.billing.read'),'cc.billing.manage')
WHERE grants && ARRAY['cc.billing.read','cc.billing.manage'];
COMMIT;
