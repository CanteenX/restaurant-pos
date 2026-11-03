-- Session revocation (#17): additive, default 0 so tokens issued before
-- rollout (no `tv` claim, read as 0) keep working.
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
