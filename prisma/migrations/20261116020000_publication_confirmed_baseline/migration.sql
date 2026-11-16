-- Expand only: retain provider-confirmed state independently of mutable intent.
ALTER TABLE "workout_publications" ADD COLUMN "last_confirmed_payload" JSONB;

-- Only settled receipts prove their payload reached the provider. Earlier failed,
-- interrupted or superseded intents cannot reconstruct a confirmed baseline.
UPDATE "workout_publications"
SET "last_confirmed_payload" = "payload"
WHERE "status" IN ('PUBLISHED', 'CANCELLED')
  AND "pending_write" IS NULL
  AND "lease_token" IS NULL;
