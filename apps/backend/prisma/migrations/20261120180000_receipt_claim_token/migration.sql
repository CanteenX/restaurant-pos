-- Nullable so existing receipt rows remain recoverable by the stale-send claim.
ALTER TABLE "receipt_emails" ADD COLUMN "claimToken" TEXT;
