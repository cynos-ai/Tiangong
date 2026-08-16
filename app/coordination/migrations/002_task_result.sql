CREATE TABLE IF NOT EXISTS tiangong_coordination.task (
  task_id text PRIMARY KEY,
  work_id text NOT NULL REFERENCES tiangong_coordination.work(work_id) ON DELETE CASCADE,
  assignee_member_id text NOT NULL,
  spec_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('assigned', 'reported', 'cancelled')),
  result_id text,
  cancellation_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS task_work_idx
  ON tiangong_coordination.task (work_id, created_at, task_id);

CREATE TABLE IF NOT EXISTS tiangong_coordination.result (
  result_id text PRIMARY KEY,
  work_id text NOT NULL REFERENCES tiangong_coordination.work(work_id) ON DELETE CASCADE,
  task_id text NOT NULL UNIQUE REFERENCES tiangong_coordination.task(task_id) ON DELETE CASCADE,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS result_work_idx
  ON tiangong_coordination.result (work_id, created_at, result_id);

INSERT INTO tiangong_coordination.schema_migrations(version)
VALUES ('002_task_result')
ON CONFLICT (version) DO NOTHING;
