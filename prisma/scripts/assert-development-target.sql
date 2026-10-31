-- Read-only preflight for the post-merge development migration job.
-- A new database must be provisioned and marked NON_PRODUCTION manually first.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.database_identity
        WHERE id = 1 AND tier = 'NON_PRODUCTION'
    ) THEN
        RAISE EXCEPTION 'Development migration target is not marked NON_PRODUCTION';
    END IF;
END $$;
