-- RUN-25 health retrieval provenance, sleep stages, and verified Garmin ownership.
ALTER TABLE "daily_health_metrics"
  ADD COLUMN "sleep_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "sleep_source_timezone" TEXT,
  ADD COLUMN "summary_fetched_at" TIMESTAMPTZ(6),
  ADD COLUMN "sleep_fetched_at" TIMESTAMPTZ(6),
  ADD COLUMN "summary_attempt_sequence" BIGINT,
  ADD COLUMN "sleep_attempt_sequence" BIGINT,
  ADD COLUMN "credential_nonce" BYTEA,
  ADD COLUMN "source_timezone_basis" TEXT,
  ADD COLUMN "sleep_timezone_basis" TEXT,
  ADD COLUMN "sleep_ended_at" TIMESTAMPTZ(6),
  ADD COLUMN "sleep_light_ms" BIGINT,
  ADD COLUMN "sleep_deep_ms" BIGINT,
  ADD COLUMN "sleep_rem_ms" BIGINT,
  ADD COLUMN "sleep_awake_ms" BIGINT,
  ADD COLUMN "garmin_account_id" TEXT;

ALTER TABLE "garmin_import_rate_limits"
  ADD COLUMN "health_attempt_sequence" BIGINT NOT NULL DEFAULT 0;

-- An old credential nonce remains a write guard. Verified ownership uses the
-- account ID, so key rotation can preserve imported history.
DROP INDEX "daily_health_metrics_user_id_source_provider_local_date_key";
CREATE UNIQUE INDEX "daily_health_metrics_owner_provider_date_nonce_key"
  ON "daily_health_metrics"("user_id", "source_provider", "local_date", "credential_nonce");
CREATE UNIQUE INDEX "daily_health_metrics_owner_provider_date_account_key"
  ON "daily_health_metrics"("user_id", "source_provider", "local_date", "garmin_account_id");

-- Existing activity imports have no account proof. Keep them in a distinct
-- legacy scope so verified account imports cannot overwrite them.
ALTER TABLE "activities"
  ADD COLUMN "garmin_account_id" TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED';

DROP INDEX "activities_user_id_source_provider_external_activity_id_key";
CREATE UNIQUE INDEX "activities_owner_provider_external_account_key"
  ON "activities"("user_id", "source_provider", "external_activity_id", "garmin_account_id");

-- A verified Garmin profile may be linked to only one Running Coach user.
CREATE UNIQUE INDEX "integration_connections_garmin_account_unique"
  ON "integration_connections"("external_account_id")
  WHERE "provider" = 'GARMIN' AND "external_account_id" IS NOT NULL;
