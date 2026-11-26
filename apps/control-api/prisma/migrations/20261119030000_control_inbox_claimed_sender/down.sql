BEGIN;
ALTER TABLE control.inbound_receipt DROP CONSTRAINT receipt_sender_evidence,
  DROP CONSTRAINT receipt_claimed_sender, DROP COLUMN claimed_sender;
COMMIT;
