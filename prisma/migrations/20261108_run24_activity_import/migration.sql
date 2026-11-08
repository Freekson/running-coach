-- Expand the existing activity row without changing existing source identities.
ALTER TABLE "activities"
  ADD COLUMN "external_activity_uuid" TEXT,
  ADD COLUMN "source_record_type" TEXT NOT NULL DEFAULT 'API_ACTIVITY',
  ADD COLUMN "source_sport_type" TEXT,
  ADD COLUMN "total_ms" BIGINT,
  ADD COLUMN "avg_speed_mps" DECIMAL(12,6),
  ADD COLUMN "gps_asset_ref" TEXT,
  ADD COLUMN "lap_import_status" VARCHAR(24) NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN "source_observed_at" TIMESTAMPTZ(6),
  ADD COLUMN "list_started_at" TIMESTAMPTZ(6);

ALTER TABLE "activities"
  ALTER COLUMN "distance_meters" TYPE DECIMAL(12,3) USING "distance_meters"::DECIMAL(12,3);
-- Preserve the initial activity chronology across later provider corrections.
UPDATE "activities" SET "list_started_at" = "started_at";
ALTER TABLE "activities" ALTER COLUMN "list_started_at" SET NOT NULL;
ALTER TABLE "activities" ADD CONSTRAINT "activities_run24_nonnegative"
  CHECK ("total_ms" >= 0 AND "avg_speed_mps" >= 0);
ALTER TABLE "activities" ADD CONSTRAINT "activities_lap_import_status_check"
  CHECK ("lap_import_status" IN ('IMPORTED', 'RETAINED', 'UNAVAILABLE'));
CREATE UNIQUE INDEX "activities_user_id_id_key" ON "activities"("user_id", "id");
DROP INDEX "activities_user_id_started_at_idx";
CREATE INDEX "activities_user_id_list_started_at_id_idx"
  ON "activities"("user_id", "list_started_at" DESC, "id" DESC);

CREATE TABLE "activity_laps" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "activity_id" UUID NOT NULL,
  "lap_index" INTEGER NOT NULL,
  "source_record_type" VARCHAR(32) NOT NULL,
  "started_at" TIMESTAMPTZ(6),
  "distance_meters" DECIMAL(12,3),
  "elapsed_ms" BIGINT,
  "moving_ms" BIGINT,
  "avg_hr_bpm" INTEGER,
  "avg_speed_mps" DECIMAL(12,6),
  "cadence_steps_per_minute" DECIMAL(7,2),
  CONSTRAINT "activity_laps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_laps_nonnegative" CHECK (
    "lap_index" >= 0 AND "distance_meters" >= 0 AND "elapsed_ms" >= 0 AND
    "moving_ms" >= 0 AND "avg_hr_bpm" >= 0 AND "avg_speed_mps" >= 0 AND
    "cadence_steps_per_minute" >= 0
  )
);
CREATE UNIQUE INDEX "activity_laps_activity_id_lap_index_key"
  ON "activity_laps"("activity_id", "lap_index");
CREATE INDEX "activity_laps_user_id_activity_id_idx"
  ON "activity_laps"("user_id", "activity_id");
ALTER TABLE "activity_laps" ADD CONSTRAINT "activity_laps_user_id_activity_id_fkey"
  FOREIGN KEY ("user_id", "activity_id") REFERENCES "activities"("user_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "activity_duplicate_candidates" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "first_activity_id" UUID NOT NULL,
  "second_activity_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_duplicate_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_duplicate_candidates_order_check"
    CHECK ("first_activity_id" < "second_activity_id")
);
CREATE UNIQUE INDEX "activity_duplicate_candidates_pair_key"
  ON "activity_duplicate_candidates"("first_activity_id", "second_activity_id");
CREATE INDEX "activity_duplicate_candidates_user_id_second_activity_id_idx"
  ON "activity_duplicate_candidates"("user_id", "second_activity_id");
ALTER TABLE "activity_duplicate_candidates"
  ADD CONSTRAINT "activity_duplicate_candidates_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activity_duplicate_candidates"
  ADD CONSTRAINT "activity_duplicate_candidates_user_id_first_activity_id_fkey"
  FOREIGN KEY ("user_id", "first_activity_id") REFERENCES "activities"("user_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "activity_duplicate_candidates"
  ADD CONSTRAINT "activity_duplicate_candidates_user_id_second_activity_id_fkey"
  FOREIGN KEY ("user_id", "second_activity_id") REFERENCES "activities"("user_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Store import limits with the user so account deletion removes the counter.
CREATE TABLE "garmin_import_rate_limits" (
  "user_id" UUID NOT NULL,
  "count" INTEGER NOT NULL,
  "window_started_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "garmin_import_rate_limits_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "garmin_import_rate_limits_count_check" CHECK ("count" BETWEEN 1 AND 4)
);
ALTER TABLE "garmin_import_rate_limits"
  ADD CONSTRAINT "garmin_import_rate_limits_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Clear owner-keyed import counters from earlier local development builds.
DELETE FROM "auth_rate_limits" WHERE "key" LIKE 'running-coach:garmin-import:user:%';
