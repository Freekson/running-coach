-- CreateTable
CREATE TABLE "workout_publications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL DEFAULT 'INTERVALS',
    "local_workout_id" UUID NOT NULL,
    "approved_revision_id" UUID NOT NULL,
    "publish_revision" INTEGER NOT NULL,
    "operation" VARCHAR(16) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
    "external_id" VARCHAR(128) NOT NULL,
    "remote_event_id" INTEGER,
    "remote_athlete_id" VARCHAR(64),
    "payload_hash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(48),
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workout_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_publication_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "publish_revision" INTEGER NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "error_code" VARCHAR(48),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "workout_publication_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workout_publications_user_id_status_updated_at_idx" ON "workout_publications"("user_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "workout_publications_user_id_provider_local_workout_id_key" ON "workout_publications"("user_id", "provider", "local_workout_id");

-- CreateIndex
CREATE UNIQUE INDEX "workout_publications_user_id_id_key" ON "workout_publications"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workout_publications_user_id_provider_external_id_key" ON "workout_publications"("user_id", "provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "workout_publications_user_id_provider_remote_athlete_id_rem_key" ON "workout_publications"("user_id", "provider", "remote_athlete_id", "remote_event_id");

-- CreateIndex
CREATE INDEX "workout_publication_attempts_user_id_publication_id_started_idx" ON "workout_publication_attempts"("user_id", "publication_id", "started_at");

-- AddForeignKey
ALTER TABLE "workout_publications" ADD CONSTRAINT "workout_publications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_publication_attempts" ADD CONSTRAINT "workout_publication_attempts_user_id_publication_id_fkey" FOREIGN KEY ("user_id", "publication_id") REFERENCES "workout_publications"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fail closed on unsupported providers/states and inconsistent leases.
ALTER TABLE "workout_publications" ADD CONSTRAINT "workout_publication_bounds_check" CHECK (
  "provider" = 'INTERVALS'
  AND "publish_revision" > 0 AND "attempt_count" >= 0
  AND "operation" IN ('CREATE', 'UPDATE', 'RESCHEDULE', 'CANCEL')
  AND "status" IN ('QUEUED', 'RUNNING', 'PUBLISHED', 'CANCELLED', 'FAILED', 'UNCERTAIN', 'SUPERSEDED')
  AND "payload_hash" ~ '^[0-9a-f]{64}$'
  AND ("remote_event_id" IS NULL OR "remote_event_id" > 0)
  AND (("lease_token" IS NULL AND "lease_expires_at" IS NULL AND "status" <> 'RUNNING')
    OR ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "status" = 'RUNNING'))
);
ALTER TABLE "workout_publication_attempts" ADD CONSTRAINT "workout_publication_attempt_bounds_check" CHECK (
  "publish_revision" > 0 AND "payload_hash" ~ '^[0-9a-f]{64}$'
  AND "status" IN ('RUNNING', 'PUBLISHED', 'CANCELLED', 'FAILED', 'UNCERTAIN', 'INTERRUPTED', 'SUPERSEDED')
  AND (("status" = 'RUNNING' AND "finished_at" IS NULL) OR ("status" <> 'RUNNING' AND "finished_at" IS NOT NULL))
);
