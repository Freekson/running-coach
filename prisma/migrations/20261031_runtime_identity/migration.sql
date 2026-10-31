-- CreateEnum
CREATE TYPE "DatabaseTier" AS ENUM ('NON_PRODUCTION', 'PRODUCTION');

-- CreateTable
CREATE TABLE "database_identity" (
    "id" SMALLINT NOT NULL,
    "tier" "DatabaseTier" NOT NULL,

    CONSTRAINT "database_identity_pkey" PRIMARY KEY ("id")
);

-- A single row identifies the database independently of Vercel variables.
-- Do not seed it in a migration: production and development need distinct values.
ALTER TABLE "database_identity" ADD CONSTRAINT "database_identity_singleton" CHECK ("id" = 1);
