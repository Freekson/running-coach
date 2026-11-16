BEGIN;

-- completed_at remains the permanent first completion/history marker. The
-- additional fields pin comparison provenance and describe the current outcome.
ALTER TABLE planned_workouts
  ADD COLUMN completed_revision_id UUID,
  ADD COLUMN completion_at TIMESTAMPTZ(6),
  ADD COLUMN completion_from_activity BOOLEAN NOT NULL DEFAULT false;

-- Create every constraint before writes queue deferred owner-FK trigger events.
ALTER TABLE planned_workouts ADD CONSTRAINT planned_workouts_completed_revision_owner_fkey
  FOREIGN KEY (user_id, plan_id, completed_revision_id)
  REFERENCES plan_revisions(user_id, plan_id, id)
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE planned_workouts ADD CONSTRAINT planned_workouts_comparison_requires_activity
  CHECK (completed_revision_id IS NULL OR completed_activity_id IS NOT NULL);
ALTER TABLE planned_workouts ADD CONSTRAINT planned_workouts_completion_provenance_check
  CHECK (
    (completion_at IS NULL OR completed_at IS NOT NULL)
    AND (NOT completion_from_activity OR (completed_at IS NOT NULL AND locked_at IS NOT NULL))
    AND (NOT completion_from_activity OR completed_activity_id IS NULL OR completion_at IS NOT NULL)
  );

-- Existing links predate comparison provenance. Preserve their latest approved
-- membership; new links always pin the revision explicitly selected by the user.
UPDATE planned_workouts w SET completed_revision_id = (
  SELECT m.revision_id FROM plan_revision_workouts m
  JOIN plan_revisions r ON r.id = m.revision_id
  WHERE m.user_id = w.user_id AND m.plan_id = w.plan_id AND m.workout_id = w.id
  ORDER BY r.revision_number DESC LIMIT 1
) WHERE w.completed_activity_id IS NOT NULL;

UPDATE planned_workouts SET completion_at = completed_at;

-- Earlier links that recorded the activity start as their first completion are
-- matching-derived. Preserve differing/manual timestamps; previously unlinked
-- records have no provenance from which a derived outcome can safely be recovered.
UPDATE planned_workouts w SET completion_from_activity = true
FROM activities a
WHERE w.user_id = a.user_id AND w.completed_activity_id = a.id
  AND w.completed_revision_id IS NOT NULL AND w.completed_at = a.started_at;

COMMIT;
