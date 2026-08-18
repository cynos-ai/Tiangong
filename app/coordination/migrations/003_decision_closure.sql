ALTER TABLE tiangong_coordination.task
  ADD COLUMN IF NOT EXISTS decision_json jsonb;

ALTER TABLE tiangong_coordination.work
  ADD COLUMN IF NOT EXISTS close_decision_json jsonb;

ALTER TABLE tiangong_coordination.task
  DROP CONSTRAINT IF EXISTS task_status_check;

ALTER TABLE tiangong_coordination.task
  ADD CONSTRAINT task_status_check
  CHECK (status IN ('assigned', 'reported', 'accepted', 'blocked', 'cancelled'));

CREATE INDEX IF NOT EXISTS decision_work_idx
  ON tiangong_coordination.task (work_id, updated_at, task_id)
  WHERE decision_json IS NOT NULL;

INSERT INTO tiangong_coordination.schema_migrations(version)
VALUES ('003_decision_closure')
ON CONFLICT (version) DO NOTHING;
