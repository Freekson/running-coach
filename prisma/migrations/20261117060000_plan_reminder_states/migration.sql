-- CreateTable
CREATE TABLE "plan_reminder_states" (
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "dismissed_at" TIMESTAMPTZ(6),
    "snoozed_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_reminder_states_pkey" PRIMARY KEY ("user_id","plan_id","fingerprint")
);

-- AddForeignKey
ALTER TABLE "plan_reminder_states" ADD CONSTRAINT "plan_reminder_states_user_id_plan_id_fkey" FOREIGN KEY ("user_id", "plan_id") REFERENCES "training_plans"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
