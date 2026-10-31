-- Run with DIRECT_URL after migrations, using a distinct migration role.
-- Create a non-owner, non-superuser role named running_coach_runtime first.
BEGIN;

GRANT USAGE ON SCHEMA public TO running_coach_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.users,
    public.athlete_profiles,
    public.integration_connections,
    public.integration_credentials,
    public.sync_cursors,
    public.sync_runs,
    public.activities,
    public.daily_health_metrics
TO running_coach_runtime;

REVOKE ALL ON TABLE public.database_identity FROM running_coach_runtime;
GRANT SELECT ON TABLE public.database_identity TO running_coach_runtime;

-- Detect inherited owner/superuser privileges that REVOKE cannot remove.
DO $$
BEGIN
    IF has_table_privilege('running_coach_runtime', 'public.database_identity', 'INSERT')
        OR has_table_privilege('running_coach_runtime', 'public.database_identity', 'UPDATE')
        OR has_table_privilege('running_coach_runtime', 'public.database_identity', 'DELETE')
        OR has_table_privilege('running_coach_runtime', 'public.database_identity', 'TRUNCATE')
    THEN
        RAISE EXCEPTION 'runtime role must not write database_identity';
    END IF;
END $$;

COMMIT;
