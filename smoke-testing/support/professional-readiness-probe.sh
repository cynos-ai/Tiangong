#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only lower-layer probe for a reserved professional smoke Team.
# Usage: TEAM LEADER DESIGNER IMPLEMENTOR ASSESSOR OPERATOR

readonly MANAGER_CONTAINER="${TIANGONG_AGENTTEAMS_MANAGER_CONTAINER:-agentteams-manager}"
readonly ID_PATTERN='^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
readonly MATRIX_ID_PATTERN='^@[A-Za-z0-9._=/-]+:[A-Za-z0-9.-]+(:[0-9]{1,5})?$'

fail() {
  printf 'professional_readiness=fail code=%s\n' "$1" >&2
  exit 1
}

(($# == 6)) || fail ARGUMENTS_INVALID
for value in "$@"; do
  [[ "$value" =~ $ID_PATTERN ]] || fail IDENTIFIER_INVALID
done

TEAM_NAME="$1"
LEADER_NAME="$2"
readonly TEAM_NAME LEADER_NAME
readonly WORKER_NAMES=("$3" "$4" "$5" "$6")
readonly ALL_NAMES=("$LEADER_NAME" "${WORKER_NAMES[@]}")

command -v docker >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE
command -v jq >/dev/null 2>&1 || fail JQ_UNAVAILABLE
docker inspect "$MANAGER_CONTAINER" >/dev/null 2>&1 || fail MANAGER_CONTAINER_MISSING
[[ "$(docker inspect "$MANAGER_CONTAINER" --format '{{.State.Running}}')" == "true" ]] || fail MANAGER_NOT_RUNNING

team_json="$(docker exec "$MANAGER_CONTAINER" agt get teams -o json)" || fail TEAM_QUERY_FAILED
team_count="$(jq -r --arg name "$TEAM_NAME" '[.teams[]? | select(.name == $name)] | length' <<<"$team_json")"
[[ "$team_count" == 1 ]] || fail TEAM_NOT_UNIQUE
team="$(jq -c --arg name "$TEAM_NAME" '.teams[] | select(.name == $name)' <<<"$team_json")"
[[ "$(jq -r '.phase' <<<"$team")" == "Active" ]] || fail TEAM_NOT_ACTIVE
[[ "$(jq -r '.leaderName' <<<"$team")" == "$LEADER_NAME" ]] || fail TEAM_LEADER_MISMATCH
[[ "$(jq -r '.leaderReady' <<<"$team")" == "true" ]] || fail TEAM_LEADER_NOT_READY
[[ "$(jq -r '.readyWorkers' <<<"$team")" == "4" && "$(jq -r '.totalWorkers' <<<"$team")" == "4" ]] || fail TEAM_WORKERS_NOT_READY
team_room="$(jq -r '.teamRoomID // empty' <<<"$team")"
[[ "$team_room" =~ ^![^[:space:]]+$ ]] || fail TEAM_ROOM_INVALID

expected_users='[]'
for index in "${!ALL_NAMES[@]}"; do
  name="${ALL_NAMES[$index]}"
  expected_role="worker"
  [[ "$index" == 0 ]] && expected_role="team_leader"
  worker_json="$(docker exec "$MANAGER_CONTAINER" agt get workers "$name" -o json)" || fail WORKER_QUERY_FAILED
  [[ "$(jq -r '.name' <<<"$worker_json")" == "$name" ]] || fail WORKER_NAME_MISMATCH
  [[ "$(jq -r '.team' <<<"$worker_json")" == "$TEAM_NAME" ]] || fail WORKER_TEAM_MISMATCH
  [[ "$(jq -r '.role' <<<"$worker_json")" == "$expected_role" ]] || fail WORKER_ROLE_MISMATCH
  [[ "$(jq -r '.phase' <<<"$worker_json")" == "Running" ]] || fail WORKER_NOT_RUNNING
  matrix_user="$(jq -r '.matrixUserID // empty' <<<"$worker_json")"
  room_id="$(jq -r '.roomID // empty' <<<"$worker_json")"
  [[ "$matrix_user" =~ $MATRIX_ID_PATTERN ]] || fail WORKER_MATRIX_ID_INVALID
  [[ "$room_id" =~ ^![^[:space:]]+$ ]] || fail WORKER_ROOM_INVALID
  expected_users="$(jq -c --arg user "$matrix_user" '. + [$user]' <<<"$expected_users")"

  container="agentteams-worker-${name}"
  docker inspect "$container" >/dev/null 2>&1 || fail WORKER_CONTAINER_MISSING
  [[ "$(docker inspect "$container" --format '{{.State.Running}}')" == "true" ]] || fail WORKER_CONTAINER_NOT_RUNNING
  docker exec "$container" openclaw health >/dev/null 2>&1 || fail OPENCLAW_NOT_HEALTHY
  actual_room="$(docker exec "$container" printenv AGENTTEAMS_WORKER_ROOM_ID)" || fail WORKER_ROOM_ENV_MISSING
  [[ "$actual_room" == "$room_id" ]] || fail WORKER_ROOM_MISMATCH

  # Use the Worker runtime to query Matrix so the bearer token never enters
  # this host shell, a command argument, or probe output.
  if ! docker exec -i -e "TEAM_ROOM_ID=$team_room" -e "EXPECTED_USERS=$expected_users" "$container" \
    node --input-type=module - <<'NODE'
try {
  const roomId = process.env.TEAM_ROOM_ID;
  const expected = JSON.parse(process.env.EXPECTED_USERS);
  const base = process.env.AGENTTEAMS_MATRIX_URL;
  const token = process.env.AGENTTEAMS_WORKER_MATRIX_TOKEN;
  if (typeof roomId !== "string" || typeof base !== "string" || typeof token !== "string") process.exit(10);
  const response = await fetch(`${base.replace(/\/$/u, "")}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) process.exit(11);
  const value = await response.json();
  const joined = value && value.joined && typeof value.joined === "object" ? Object.keys(value.joined) : [];
  if (expected.some((user) => !joined.includes(user))) process.exit(12);
} catch {
  process.exit(13);
}
NODE
  then
    fail MATRIX_TEAM_MEMBERSHIP_NOT_READY
  fi
done

printf 'professional_readiness=pass team=%s workers=5 matrix_members=5\n' "$TEAM_NAME"
