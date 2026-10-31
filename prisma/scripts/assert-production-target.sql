-- Read-only preflight for the trusted main-branch production migration job.
-- This does not apply migrations or change the database identity.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.database_identity
        WHERE id = 1 AND tier = 'PRODUCTION'
    ) THEN
        RAISE EXCEPTION 'Production migration target is not marked PRODUCTION';
    END IF;
END $$;
