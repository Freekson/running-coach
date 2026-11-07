-- Existing rows must be reconciled by their owners before enforcing one connection
-- per provider. This migration deliberately fails rather than discarding secrets.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM integration_connections
    GROUP BY user_id, provider
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate owner/provider connections require manual reconciliation';
  END IF;
END $$;

ALTER TYPE "IntegrationProvider" ADD VALUE 'OPENAI';
CREATE UNIQUE INDEX "integration_connections_user_id_provider_key"
  ON "integration_connections"("user_id", "provider");
