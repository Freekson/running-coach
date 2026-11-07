ALTER TABLE "athlete_profiles"
  ADD COLUMN "measurement_system" VARCHAR(16) NOT NULL DEFAULT 'METRIC';

-- A distance choice takes precedence if legacy preferences disagree.
UPDATE "athlete_profiles"
SET "measurement_system" = CASE
  WHEN "distance_unit" = 'MI' THEN 'IMPERIAL'
  WHEN "distance_unit" = 'KM' THEN 'METRIC'
  WHEN "weight_unit" = 'LB' THEN 'IMPERIAL'
  ELSE 'METRIC'
END;

ALTER TABLE "athlete_profiles"
  ADD CONSTRAINT "athlete_profiles_measurement_system_check"
  CHECK ("measurement_system" IN ('METRIC', 'IMPERIAL'));
