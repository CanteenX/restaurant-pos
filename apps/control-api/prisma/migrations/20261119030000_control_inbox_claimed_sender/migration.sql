BEGIN;
ALTER TABLE control.inbound_receipt
  ADD COLUMN claimed_sender varchar(254),
  ADD CONSTRAINT receipt_claimed_sender CHECK (claimed_sender IS NULL OR
    (outcome = 'accept' AND claimed_sender ~ '^[^@,;<>[:space:][:cntrl:]]+@[a-z0-9.-]+$')),
  -- Historical receipts have no original From claim. New evidence must match the retained claim.
  ADD CONSTRAINT receipt_sender_evidence CHECK (verified_sender IS NULL OR
    (claimed_sender IS NOT NULL AND verified_sender = claimed_sender)) NOT VALID;
COMMIT;
