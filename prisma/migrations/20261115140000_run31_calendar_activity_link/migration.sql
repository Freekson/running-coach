BEGIN;

ALTER TABLE planned_workouts ADD COLUMN completed_activity_id UUID;
CREATE UNIQUE INDEX planned_workouts_user_id_completed_activity_id_key
  ON planned_workouts(user_id, completed_activity_id);
ALTER TABLE planned_workouts ADD CONSTRAINT planned_workouts_completed_activity_owner_fkey
  FOREIGN KEY (user_id, completed_activity_id) REFERENCES activities(user_id, id)
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE planned_workouts ADD CONSTRAINT planned_workouts_link_requires_completion
  CHECK (completed_activity_id IS NULL OR (completed_at IS NOT NULL AND locked_at IS NOT NULL));

COMMIT;
