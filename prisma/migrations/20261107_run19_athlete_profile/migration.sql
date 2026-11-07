ALTER TABLE "athlete_profiles" ADD COLUMN "sex" VARCHAR(32);
-- Existing profiles need an explicit choice from their owner. Enforce the two
-- values on new and updated rows without assigning a value to existing rows.
ALTER TABLE "athlete_profiles" ADD CONSTRAINT "athlete_profiles_sex_required" CHECK ("sex" IN ('MALE', 'FEMALE')) NOT VALID;

CREATE TABLE "body_measurements" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "measurement_type" VARCHAR(32) NOT NULL,
    "value" DECIMAL(9,2) NOT NULL,
    "unit" VARCHAR(16) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "source_external_id" TEXT,
    CONSTRAINT "body_measurements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "body_measurements_user_id_source_source_external_id_key" ON "body_measurements"("user_id", "source", "source_external_id");
CREATE INDEX "body_measurements_user_id_measurement_type_measured_at_idx" ON "body_measurements"("user_id", "measurement_type", "measured_at" DESC);
ALTER TABLE "body_measurements" ADD CONSTRAINT "body_measurements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
