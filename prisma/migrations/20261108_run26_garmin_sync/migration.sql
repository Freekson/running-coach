ALTER TABLE "sync_cursors"
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "garmin_import_rate_limits"
  ADD COLUMN "provider_retry_at" TIMESTAMPTZ(6);

ALTER TABLE "activities"
  ADD COLUMN "fit_checked_at" TIMESTAMPTZ(6);
