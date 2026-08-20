CREATE SCHEMA IF NOT EXISTS tiangong_coordination;

CREATE TABLE IF NOT EXISTS tiangong_coordination.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tiangong_coordination.work (
  work_id text PRIMARY KEY,
  team_id text NOT NULL,
  route_id text NOT NULL,
  room_id text NOT NULL,
  actor_id text NOT NULL,
  source_event_id text NOT NULL,
  control_profile_id text NOT NULL,
  leader_session_id text NOT NULL,
  title text NOT NULL,
  work_json jsonb NOT NULL,
  team_json jsonb NOT NULL,
  route_json jsonb NOT NULL,
  profile_json jsonb NOT NULL,
  current_work_spec jsonb,
  current_plan_ref jsonb,
  status text NOT NULL CHECK (status IN ('open', 'completed', 'stopped')),
  epoch integer NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (room_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS tiangong_coordination.work_timeline (
  work_id text NOT NULL REFERENCES tiangong_coordination.work(work_id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  epoch integer NOT NULL CHECK (epoch >= 0),
  request_id text,
  payload jsonb NOT NULL,
  PRIMARY KEY (work_id, sequence)
);

CREATE TABLE IF NOT EXISTS tiangong_coordination.matrix_message_admission (
  room_id text NOT NULL,
  event_id text NOT NULL,
  team_id text NOT NULL,
  route_id text NOT NULL,
  actor_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'routed')),
  work_id text REFERENCES tiangong_coordination.work(work_id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  lease_owner text,
  lease_until timestamptz,
  received_at timestamptz NOT NULL,
  routed_at timestamptz,
  PRIMARY KEY (room_id, event_id)
);

CREATE INDEX IF NOT EXISTS matrix_message_admission_pending_idx
  ON tiangong_coordination.matrix_message_admission (room_id, status, received_at, event_id);

CREATE TABLE IF NOT EXISTS tiangong_coordination.matrix_message_binding (
  room_id text NOT NULL,
  event_id text NOT NULL,
  work_id text NOT NULL REFERENCES tiangong_coordination.work(work_id),
  actor_id text NOT NULL,
  associated_by text NOT NULL,
  associated_at timestamptz NOT NULL,
  corrected_at timestamptz,
  PRIMARY KEY (room_id, event_id)
);

CREATE TABLE IF NOT EXISTS tiangong_coordination.request_replay (
  request_id text PRIMARY KEY,
  scope text NOT NULL,
  request_hash text NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tiangong_coordination.wake (
  wake_id text PRIMARY KEY,
  work_id text REFERENCES tiangong_coordination.work(work_id),
  task_id text,
  kind text NOT NULL CHECK (kind IN ('leader-resume', 'human-reply', 'task-assignment', 'result-notification')),
  target_member_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'claimed', 'acked')),
  consumer_id text,
  receipt_id text,
  created_at timestamptz NOT NULL,
  claimed_at timestamptz,
  acked_at timestamptz
);

CREATE INDEX IF NOT EXISTS wake_pending_idx
  ON tiangong_coordination.wake (status, created_at);

INSERT INTO tiangong_coordination.schema_migrations(version)
VALUES ('001_coordination')
ON CONFLICT (version) DO NOTHING;
