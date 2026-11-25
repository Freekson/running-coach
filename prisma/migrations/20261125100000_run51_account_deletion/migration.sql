BEGIN;

CREATE TABLE "account_deletion_receipts" (
  "user_id" UUID NOT NULL PRIMARY KEY,
  "auth_subject_hash" CHAR(64) NOT NULL,
  "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "account_deletion_receipts_hash_check" CHECK (auth_subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "account_deletion_receipts_retention_check" CHECK (expires_at > deleted_at)
);
CREATE INDEX "account_deletion_receipts_expires_at_idx" ON "account_deletion_receipts"("expires_at");

COMMIT;
