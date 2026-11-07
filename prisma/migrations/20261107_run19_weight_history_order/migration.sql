-- Existing readings receive the migration time. Their UUID provides a stable
-- final tie-breaker until new readings have individual creation timestamps.
ALTER TABLE "body_measurements" ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "body_measurements_owner_weight_order_idx" ON "body_measurements"("user_id", "measurement_type", "measured_at" DESC, "created_at" DESC, "id" DESC);
DROP INDEX "body_measurements_user_id_measurement_type_measured_at_idx";
