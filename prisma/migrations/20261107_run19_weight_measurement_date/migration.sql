-- A manually selected calendar date must remain stable when the athlete
-- changes browser timezone. Existing timestamps do not retain the timezone
-- used when entered, so leave legacy rows null rather than guessing a date.
ALTER TABLE "body_measurements" ADD COLUMN "measured_on" DATE;
