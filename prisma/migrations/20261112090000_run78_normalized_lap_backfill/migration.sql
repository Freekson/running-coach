-- Additive RUN-78 migration. Existing normalized laps remain complete; no provider calls.
ALTER TABLE "activities"
  ADD COLUMN "fit_import_state" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "fit_import_error_code" VARCHAR(40),
  ADD COLUMN "fit_import_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fit_next_attempt_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "activities_fit_state_check" CHECK ("fit_import_state" IN ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'UNAVAILABLE')),
  ADD CONSTRAINT "activities_fit_attempts_check" CHECK ("fit_import_attempts" >= 0);
UPDATE "activities" SET "fit_import_state" = 'COMPLETE'
  WHERE "lap_import_status" IN ('IMPORTED', 'RETAINED');
CREATE INDEX "activities_fit_work_idx" ON "activities"
  ("user_id", "source_provider", "garmin_account_id", "fit_import_state", "started_at", "id");
ALTER TABLE "activity_laps"
  ADD COLUMN "ended_at" TIMESTAMPTZ(6),
  ADD COLUMN "timer_ms" BIGINT,
  ADD COLUMN "max_hr_bpm" INTEGER,
  ADD COLUMN "cadence_cycles_per_minute" DECIMAL(7,2),
  ADD COLUMN "avg_power_watts" DECIMAL(9,2),
  ADD COLUMN "max_power_watts" DECIMAL(9,2),
  ADD COLUMN "max_speed_mps" DECIMAL(12,6),
  ADD COLUMN "elevation_gain_meters" DECIMAL(9,2),
  ADD COLUMN "elevation_loss_meters" DECIMAL(9,2),
  ADD CONSTRAINT "activity_laps_fit_metrics_check" CHECK (
    ("ended_at" IS NULL OR "started_at" IS NULL OR "ended_at" >= "started_at") AND
    ("timer_ms" IS NULL OR "timer_ms" >= 0) AND
    ("max_hr_bpm" IS NULL OR "max_hr_bpm" >= 0) AND
    ("cadence_cycles_per_minute" IS NULL OR "cadence_cycles_per_minute" >= 0) AND
    ("avg_power_watts" IS NULL OR "avg_power_watts" >= 0) AND
    ("max_power_watts" IS NULL OR "max_power_watts" >= 0) AND
    ("max_speed_mps" IS NULL OR "max_speed_mps" >= 0) AND
    ("elevation_gain_meters" IS NULL OR "elevation_gain_meters" >= 0) AND
    ("elevation_loss_meters" IS NULL OR "elevation_loss_meters" >= 0));
