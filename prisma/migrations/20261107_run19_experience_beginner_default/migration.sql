UPDATE "athlete_profiles"
SET "experience_level" = 'BEGINNER'
WHERE "experience_level" IS NULL;

ALTER TABLE "athlete_profiles"
ALTER COLUMN "experience_level" SET DEFAULT 'BEGINNER',
ALTER COLUMN "experience_level" SET NOT NULL;
