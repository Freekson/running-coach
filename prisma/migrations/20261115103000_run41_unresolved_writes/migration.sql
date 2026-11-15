-- Additive durable intent, independent of expiring dispatch leases.
ALTER TABLE "workout_publications" ADD COLUMN "pending_write" JSONB;

-- Older interrupted/uncertain calls have no per-write marker. Never infer their
-- completion from absence or from a changed approved revision.
UPDATE "workout_publications"
SET "pending_write" = '{"kind":"LEGACY"}'::jsonb
WHERE "status" IN ('RUNNING', 'UNCERTAIN');

ALTER TABLE "workout_publications" ADD CONSTRAINT "workout_publication_pending_write_check"
CHECK ("pending_write" IS NULL OR
  (jsonb_typeof("pending_write") = 'object' AND
    "pending_write" ? 'kind' AND
    "pending_write"->>'kind' IN ('UPSERT', 'CANCEL', 'LEGACY')));
