CREATE TABLE IF NOT EXISTS tiangong_coordination.task (
  task_id text PRIMARY KEY,
  work_id text NOT NULL REFERENCES tiangong_coordination.work(work_id) ON DELETE CASCADE,
  assignee_member_id text NOT NULL,
  session_ref text NOT NULL,
  spec_json jsonb NOT NULL,
  cancellation_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS task_work_idx
  ON tiangong_coordination.task (work_id, created_at, task_id);

CREATE TABLE IF NOT EXISTS tiangong_coordination.result (
  task_id text PRIMARY KEY REFERENCES tiangong_coordination.task(task_id) ON DELETE CASCADE,
  work_id text NOT NULL REFERENCES tiangong_coordination.work(work_id) ON DELETE CASCADE,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS result_work_idx
  ON tiangong_coordination.result (work_id, created_at, task_id);

INSERT INTO tiangong_coordination.schema_migrations(version)
VALUES ('002_task_result')
ON CONFLICT (version) DO NOTHING;
