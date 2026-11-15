BEGIN;

-- AlterTable
ALTER TABLE "plan_drafts" ADD COLUMN     "base_revision_id" UUID,
ADD COLUMN     "content" JSONB,
ADD COLUMN     "plan_id" UUID,
ADD COLUMN     "state" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "validated_goal_updated_at" TIMESTAMPTZ(6),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "training_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "current_revision_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "training_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_revisions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "source_draft_id" UUID NOT NULL,
    "parent_revision_id" UUID,
    "revision_number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planned_workouts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),

    CONSTRAINT "planned_workouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_revision_workouts" (
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "workout_id" UUID NOT NULL,
    "scheduled_date" DATE NOT NULL,
    "timezone" VARCHAR(100) NOT NULL,
    "definition" JSONB NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "plan_revision_workouts_pkey" PRIMARY KEY ("revision_id","workout_id")
);

-- CreateIndex
CREATE INDEX "training_plans_user_id_updated_at_idx" ON "training_plans"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "training_plans_user_id_goal_id_id_key" ON "training_plans"("user_id", "goal_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "training_plans_user_id_id_key" ON "training_plans"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_revisions_source_draft_id_key" ON "plan_revisions"("source_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_revisions_user_id_plan_id_id_key" ON "plan_revisions"("user_id", "plan_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_revisions_user_id_plan_id_source_draft_id_key" ON "plan_revisions"("user_id", "plan_id", "source_draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_revisions_plan_id_revision_number_key" ON "plan_revisions"("plan_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "planned_workouts_user_id_plan_id_id_key" ON "planned_workouts"("user_id", "plan_id", "id");

-- CreateIndex
CREATE INDEX "plan_revision_workouts_user_id_plan_id_workout_id_idx" ON "plan_revision_workouts"("user_id", "plan_id", "workout_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_drafts_user_id_plan_id_id_key" ON "plan_drafts"("user_id", "plan_id", "id");

-- AddForeignKey
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_user_id_goal_id_plan_id_fkey" FOREIGN KEY ("user_id", "goal_id", "plan_id") REFERENCES "training_plans"("user_id", "goal_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_user_id_plan_id_base_revision_id_fkey" FOREIGN KEY ("user_id", "plan_id", "base_revision_id") REFERENCES "plan_revisions"("user_id", "plan_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_goal_id_fkey" FOREIGN KEY ("user_id", "goal_id") REFERENCES "goals"("user_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_id_current_revision_id_fkey" FOREIGN KEY ("user_id", "id", "current_revision_id") REFERENCES "plan_revisions"("user_id", "plan_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_user_id_goal_id_plan_id_fkey" FOREIGN KEY ("user_id", "goal_id", "plan_id") REFERENCES "training_plans"("user_id", "goal_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_user_id_plan_id_source_draft_id_fkey" FOREIGN KEY ("user_id", "plan_id", "source_draft_id") REFERENCES "plan_drafts"("user_id", "plan_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_user_id_plan_id_parent_revision_id_fkey" FOREIGN KEY ("user_id", "plan_id", "parent_revision_id") REFERENCES "plan_revisions"("user_id", "plan_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_user_id_plan_id_fkey" FOREIGN KEY ("user_id", "plan_id") REFERENCES "training_plans"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_revision_workouts" ADD CONSTRAINT "plan_revision_workouts_user_id_plan_id_revision_id_fkey" FOREIGN KEY ("user_id", "plan_id", "revision_id") REFERENCES "plan_revisions"("user_id", "plan_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_revision_workouts" ADD CONSTRAINT "plan_revision_workouts_user_id_plan_id_workout_id_fkey" FOREIGN KEY ("user_id", "plan_id", "workout_id") REFERENCES "planned_workouts"("user_id", "plan_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE plan_drafts ADD CONSTRAINT plan_drafts_lifecycle_check CHECK (
  version >= 0 AND state IN ('DRAFT', 'GENERATED', 'VALIDATED', 'APPROVED')
  AND (state = 'DRAFT' OR content IS NOT NULL)
  AND (state NOT IN ('VALIDATED', 'APPROVED') OR validated_goal_updated_at IS NOT NULL)
  AND (base_revision_id IS NULL OR plan_id IS NOT NULL)
);
ALTER TABLE plan_revisions ADD CONSTRAINT plan_revisions_number_check CHECK (revision_number > 0);
ALTER TABLE plan_revisions ADD CONSTRAINT plan_revisions_snapshot_check CHECK (
  jsonb_typeof(snapshot) = 'object' AND snapshot->>'schemaVersion' = '1'
);
ALTER TABLE plan_revision_workouts ADD CONSTRAINT plan_revision_workouts_definition_check CHECK (
  jsonb_typeof(definition) = 'object' AND definition->>'schemaVersion' = '1'
);

-- Block mutation even for a table-owning application connection. Deletion through
-- the account cascade is allowed once that account no longer exists.
CREATE FUNCTION protect_approved_plan_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    RAISE EXCEPTION 'approved plan snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER plan_revisions_immutable BEFORE UPDATE OR DELETE ON plan_revisions
FOR EACH ROW EXECUTE FUNCTION protect_approved_plan_snapshot();
CREATE TRIGGER plan_revision_workouts_immutable BEFORE UPDATE OR DELETE ON plan_revision_workouts
FOR EACH ROW EXECUTE FUNCTION protect_approved_plan_snapshot();

-- Membership can only be appended in the transaction that creates the revision.
-- This closes the late INSERT path as well as UPDATE/DELETE.
CREATE FUNCTION protect_plan_revision_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_revisions r WHERE r.id = NEW.revision_id
    AND r.xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'approved revision membership is sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_revision_membership_sealed BEFORE INSERT ON plan_revision_workouts
FOR EACH ROW EXECUTE FUNCTION protect_plan_revision_membership();

CREATE FUNCTION protect_approved_plan_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'APPROVED' AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    RAISE EXCEPTION 'approved drafts are read only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_drafts_approved_read_only BEFORE UPDATE ON plan_drafts
FOR EACH ROW EXECUTE FUNCTION protect_approved_plan_draft();

CREATE FUNCTION protect_workout_identity_and_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.plan_id) IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.plan_id)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.locked_at IS NOT NULL AND NEW.locked_at IS DISTINCT FROM OLD.locked_at) THEN
    RAISE EXCEPTION 'workout identity and history locks are permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER planned_workouts_identity_lock BEFORE UPDATE ON planned_workouts
FOR EACH ROW EXECUTE FUNCTION protect_workout_identity_and_lock();

COMMIT;
