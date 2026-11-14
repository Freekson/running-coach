-- CreateTable
CREATE TABLE "goals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" VARCHAR(24) NOT NULL,
    "distance_meters" DECIMAL(12,3),
    "target_time_seconds" INTEGER,
    "target_count" INTEGER,
    "measurement_window" VARCHAR(16),
    "target_date" DATE,
    "surface" VARCHAR(16) NOT NULL,
    "elevation_gain_m" INTEGER,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_drafts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "sessions_per_week" SMALLINT NOT NULL,
    "available_weekdays" INTEGER[] NOT NULL,
    "max_session_minutes" INTEGER,
    "start_date" DATE,
    "timezone" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goals_user_id_archived_created_at_id_idx" ON "goals"("user_id", "archived", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "goals_user_id_id_key" ON "goals"("user_id", "id");

-- CreateIndex
CREATE INDEX "plan_drafts_user_id_updated_at_idx" ON "plan_drafts"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "plan_drafts_user_id_goal_id_idx" ON "plan_drafts"("user_id", "goal_id");

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_user_id_goal_id_fkey" FOREIGN KEY ("user_id", "goal_id") REFERENCES "goals"("user_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Runtime schemas remain authoritative for semantic validation; these guard stored bounds.
ALTER TABLE "goals" ADD CONSTRAINT "goals_target_bounds_check" CHECK (
  length(trim("name")) > 0
  AND "type" IN ('PERFORMANCE', 'COMPLETION', 'VOLUME', 'CONSISTENCY')
  AND "surface" IN ('ANY', 'ROAD', 'TRACK', 'TRAIL', 'TREADMILL')
  AND ("distance_meters" IS NULL OR "distance_meters" > 0)
  AND ("target_time_seconds" IS NULL OR "target_time_seconds" > 0)
  AND ("target_count" IS NULL OR "target_count" > 0)
  AND ("elevation_gain_m" IS NULL OR "elevation_gain_m" >= 0)
);
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_schedule_check" CHECK (
  "sessions_per_week" BETWEEN 1 AND 7
  AND cardinality("available_weekdays") BETWEEN "sessions_per_week" AND 7
  AND "available_weekdays" <@ ARRAY[0,1,2,3,4,5,6]
  AND array_position("available_weekdays", NULL) IS NULL
  AND ("max_session_minutes" IS NULL OR "max_session_minutes" BETWEEN 5 AND 1440)
);
