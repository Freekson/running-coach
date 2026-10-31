-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETING');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('GARMIN', 'INTERVALS');

-- CreateEnum
CREATE TYPE "IntegrationAuthMethod" AS ENUM ('OAUTH', 'API_KEY', 'FILE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('PENDING', 'CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActivitySource" AS ENUM ('GARMIN', 'INTERVALS', 'MANUAL', 'FILE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "auth_subject" TEXT NOT NULL,
    "email" VARCHAR(320),
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "athlete_profiles" (
    "user_id" UUID NOT NULL,
    "display_name" TEXT,
    "birth_date" DATE,
    "height_cm" DECIMAL(5,2),
    "experience_level" TEXT,
    "preferred_timezone" TEXT,
    "distance_unit" TEXT,
    "weight_unit" TEXT,
    "default_training_days_per_week" SMALLINT,
    "default_available_weekdays" JSONB,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "athlete_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "external_account_id" TEXT,
    "auth_method" "IntegrationAuthMethod" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "granted_scopes" JSONB,
    "credentials_expires_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_credentials" (
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "encryption_key_version" INTEGER NOT NULL,
    "rotated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "data_type" TEXT NOT NULL,
    "cursor_or_checkpoint" JSONB NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "job_type" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "records_seen" INTEGER NOT NULL DEFAULT 0,
    "records_written" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "checkpoint_summary" JSONB,
    "error_code" TEXT,
    "error_safe_message" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_provider" "ActivitySource" NOT NULL,
    "external_activity_id" TEXT,
    "sport_type" TEXT NOT NULL,
    "surface_type" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "source_timezone" TEXT,
    "distance_meters" INTEGER,
    "elapsed_ms" BIGINT,
    "moving_ms" BIGINT,
    "avg_hr_bpm" INTEGER,
    "max_hr_bpm" INTEGER,
    "cadence" DECIMAL(7,2),
    "elevation_gain_meters" DECIMAL(9,2),
    "elevation_loss_meters" DECIMAL(9,2),
    "calories" INTEGER,
    "activity_title" TEXT,
    "raw_object_ref" TEXT,
    "external_modified_at" TIMESTAMPTZ(6),
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_health_metrics" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_provider" "ActivitySource" NOT NULL,
    "local_date" DATE NOT NULL,
    "source_timezone" TEXT NOT NULL,
    "resting_hr_bpm" INTEGER,
    "hrv_ms" DECIMAL(9,2),
    "sleep_duration_ms" BIGINT,
    "sleep_score" INTEGER,
    "steps" INTEGER,
    "stress" INTEGER,
    "body_battery" INTEGER,
    "raw_metadata" JSONB,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "daily_health_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "integration_connections_user_id_provider_status_idx" ON "integration_connections"("user_id", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_user_id_id_key" ON "integration_connections"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_user_id_provider_external_account_i_key" ON "integration_connections"("user_id", "provider", "external_account_id");

-- CreateIndex
CREATE INDEX "integration_credentials_user_id_idx" ON "integration_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credentials_user_id_connection_id_key" ON "integration_credentials"("user_id", "connection_id");

-- CreateIndex
CREATE INDEX "sync_cursors_user_id_connection_id_idx" ON "sync_cursors"("user_id", "connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_cursors_connection_id_data_type_key" ON "sync_cursors"("connection_id", "data_type");

-- CreateIndex
CREATE INDEX "sync_runs_connection_id_started_at_idx" ON "sync_runs"("connection_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sync_runs_status_started_at_idx" ON "sync_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "sync_runs_user_id_started_at_idx" ON "sync_runs"("user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "activities_user_id_started_at_idx" ON "activities"("user_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "activities_user_id_source_provider_external_activity_id_key" ON "activities"("user_id", "source_provider", "external_activity_id");

-- CreateIndex
CREATE INDEX "daily_health_metrics_user_id_local_date_idx" ON "daily_health_metrics"("user_id", "local_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "daily_health_metrics_user_id_source_provider_local_date_key" ON "daily_health_metrics"("user_id", "source_provider", "local_date");

-- AddForeignKey
ALTER TABLE "athlete_profiles" ADD CONSTRAINT "athlete_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_user_id_connection_id_fkey" FOREIGN KEY ("user_id", "connection_id") REFERENCES "integration_connections"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_user_id_connection_id_fkey" FOREIGN KEY ("user_id", "connection_id") REFERENCES "integration_connections"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_user_id_connection_id_fkey" FOREIGN KEY ("user_id", "connection_id") REFERENCES "integration_connections"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_health_metrics" ADD CONSTRAINT "daily_health_metrics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma does not model CHECK constraints. Keep invalid numeric measurements
-- out of canonical data even when a future importer misses validation.
ALTER TABLE "athlete_profiles" ADD CONSTRAINT "athlete_profiles_training_days_range" CHECK ("default_training_days_per_week" BETWEEN 1 AND 7);
ALTER TABLE "activities" ADD CONSTRAINT "activities_nonnegative_measurements" CHECK (
    "distance_meters" >= 0 AND "elapsed_ms" >= 0 AND "moving_ms" >= 0 AND
    "avg_hr_bpm" >= 0 AND "max_hr_bpm" >= 0 AND "cadence" >= 0 AND
    "elevation_gain_meters" >= 0 AND "elevation_loss_meters" >= 0 AND "calories" >= 0
);
ALTER TABLE "daily_health_metrics" ADD CONSTRAINT "daily_health_metrics_nonnegative_measurements" CHECK (
    "resting_hr_bpm" >= 0 AND "hrv_ms" >= 0 AND "sleep_duration_ms" >= 0 AND
    "sleep_score" >= 0 AND "steps" >= 0 AND "stress" >= 0 AND "body_battery" >= 0
);
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_nonnegative_counts" CHECK (
    "records_seen" >= 0 AND "records_written" >= 0 AND "retry_count" >= 0
);

-- NULL external IDs are permitted while an account is being connected, but
-- only one pending connection per provider and owner may exist at a time.
CREATE UNIQUE INDEX "integration_connections_one_pending_per_provider"
    ON "integration_connections"("user_id", "provider") WHERE "status" = 'PENDING';
