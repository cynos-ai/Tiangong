#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly MANAGER_CONTAINER="${TIANGONG_MANAGER_CONTAINER:-agentteams-manager}"
readonly CONTROLLER_CONTAINER="${TIANGONG_CONTROLLER_CONTAINER:-agentteams-controller}"
readonly TEAM_NAME="tiangong-demo-team"
readonly LEADER_NAME="tiangong-demo-leader"
readonly WORKERS_FILE="${REPO_ROOT}/demo/fixtures/workers.yaml"
readonly TEAM_FILE="${REPO_ROOT}/demo/fixtures/team.yaml"
readonly MANAGER_WORKERS_FILE="/tmp/tiangong-demo-workers.yaml"
readonly MANAGER_TEAM_FILE="/tmp/tiangong-demo-team.yaml"
readonly DASHBOARD_URL="http://127.0.0.1:13000/"
readonly ELEMENT_URL="http://127.0.0.1:18088/#/login"
readonly WAIT_WORKER_ATTEMPTS="${TIANGONG_DEMO_WAIT_WORKER_ATTEMPTS:-120}"
readonly WAIT_TEAM_ATTEMPTS="${TIANGONG_DEMO_WAIT_TEAM_ATTEMPTS:-120}"
DEMO_PROVISIONING=0

log() { printf '[Tiangong Demo] %s\n' "$*"; }
die() { printf '[Tiangong Demo] ERROR: %s\n' "$*" >&2; exit 1; }

require_command() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
require_stack() {
  docker inspect "${MANAGER_CONTAINER}" >/dev/null 2>&1 || die "AgentTeams Manager is not running; run make up first.";
  docker inspect "${CONTROLLER_CONTAINER}" >/dev/null 2>&1 || die "AgentTeams controller is not running; run make up first.";
  curl --fail --silent --show-error --max-time 10 "${DASHBOARD_URL}" >/dev/null || die "Dashboard is not reachable at ${DASHBOARD_URL}";
}

docker_host_path() {
  local path="$1"
  if command -v wslpath >/dev/null 2>&1; then
    wslpath -w "${path}"
  else
    printf '%s\n' "${path}"
  fi
}

resource_exists() {
  local kind="$1" name="$2"
  docker exec "${MANAGER_CONTAINER}" agt get "${kind}" "${name}" -o json >/dev/null 2>&1
}

delete_worker_if_owned() {
  local name="$1"
  for _ in $(seq 1 20); do
    resource_exists workers "${name}" || return 0
    docker exec "${MANAGER_CONTAINER}" agt delete worker "${name}" >/dev/null 2>&1 || true
    sleep 1
  done
  resource_exists workers "${name}" && die "could not remove owned demo Worker ${name}"
}

stop_demo() {
  if resource_exists teams "${TEAM_NAME}"; then
    docker exec "${MANAGER_CONTAINER}" agt delete team "${TEAM_NAME}" >/dev/null || true
  fi
  # AgentTeams removes Team membership asynchronously; retry after the Team is gone.
  for _ in $(seq 1 20); do
    resource_exists teams "${TEAM_NAME}" || break
    sleep 1
  done
  local name
  for name in \
    tiangong-demo-leader \
    tiangong-demo-designer \
    tiangong-demo-implementor \
    tiangong-demo-assessor \
    tiangong-demo-operator; do
    delete_worker_if_owned "${name}"
  done
  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_WORKERS_FILE}" "${MANAGER_TEAM_FILE}" >/dev/null 2>&1 || true
}

wait_worker() {
  local name="$1" json
  for _ in $(seq 1 "${WAIT_WORKER_ATTEMPTS}"); do
    json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${name}" -o json 2>/dev/null || true)"
    if jq -e '.phase == "Running" and (.matrixUserID | type == "string" and length > 0) and (.roomID | type == "string" and length > 0)' <<<"${json}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_team() {
  local json
  for _ in $(seq 1 "${WAIT_TEAM_ATTEMPTS}"); do
    json="$(docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json 2>/dev/null || true)"
    if jq -e '.phase == "Active" and .leaderReady == true and .readyWorkers == 4 and .totalWorkers == 4' <<<"${json}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

cleanup_failed_start() {
  local status="$?"
  if ((status != 0 && DEMO_PROVISIONING == 1)); then
    DEMO_PROVISIONING=0
    stop_demo >/dev/null 2>&1 || true
  fi
  exit "${status}"
}

start_demo() {
  require_stack
  local name
  resource_exists teams "${TEAM_NAME}" && die "${TEAM_NAME} already exists; run '$0 stop' first."
  for name in \
    tiangong-demo-leader \
    tiangong-demo-designer \
    tiangong-demo-implementor \
    tiangong-demo-assessor \
    tiangong-demo-operator; do
    resource_exists workers "${name}" && die "${name} already exists; run '$0 stop' first."
  done

  DEMO_PROVISIONING=1
  docker cp "$(docker_host_path "${WORKERS_FILE}")" "${MANAGER_CONTAINER}:${MANAGER_WORKERS_FILE}" >/dev/null
  docker cp "$(docker_host_path "${TEAM_FILE}")" "${MANAGER_CONTAINER}:${MANAGER_TEAM_FILE}" >/dev/null
  docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_WORKERS_FILE}" >/dev/null
  for name in \
    tiangong-demo-leader \
    tiangong-demo-designer \
    tiangong-demo-implementor \
    tiangong-demo-assessor \
    tiangong-demo-operator; do
    log "waiting for ${name}"
    wait_worker "${name}" || die "${name} did not become Matrix-ready"
  done
  docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_TEAM_FILE}" >/dev/null
  log "waiting for ${TEAM_NAME}"
  wait_team || die "${TEAM_NAME} did not become Active"
  log "Demo is ready. Dashboard: ${DASHBOARD_URL}"
  log "Matrix client: ${ELEMENT_URL}"
  docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json
  DEMO_PROVISIONING=0
}

send_to_leader() {
  require_stack
  local message="${*:-请介绍这支 Tiangong 团队的五个角色，并提出一个只读的 design Task。不要执行写操作。}"
  local team_json leader_uid leader_room
  team_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${LEADER_NAME}" -o json)"
  leader_uid="$(jq -er '.matrixUserID' <<<"${team_json}")"
  leader_room="$(jq -er '.roomID' <<<"${team_json}")"
  docker exec -i "${MANAGER_CONTAINER}" sh -s -- "${leader_uid}" "${leader_room}" "${message}" <<'SH'
set -Eeuo pipefail
leader_uid="$1"
room_id="$2"
message="$3"
config="${HOME}/openclaw.json"
homeserver="$(jq -er '.channels.matrix.homeserver' "${config}")"
token="$(jq -er '.channels.matrix.accessToken' "${config}")"
room_path="$(printf '%s' "${room_id}" | jq -sRr @uri)"
localpart="${leader_uid%%:*}"
body="$(jq -cn --arg worker "${leader_uid}" --arg message "${message}" \
  '{msgtype:"m.text",body:(($worker|split(":")[0])+" "+$message),format:"org.matrix.custom.html",formatted_body:("<a href=\"https://matrix.to/#/"+$worker+"\">"+(($worker|split(":")[0])|@html)+"</a> "+($message|@html)),"m.mentions":{user_ids:[$worker]}}')"
transaction="tiangong-demo-$(date +%s)-$$"
printf 'header = "Authorization: Bearer %s"\n' "${token}" | \
  curl --config - --fail --silent --show-error --max-time 30 \
    -X PUT -H 'Content-Type: application/json' --data-binary "${body}" \
    "${homeserver%/}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/${transaction}" >/dev/null
printf 'demo_message_sent=true target=%s\n' "${localpart}"
SH
}

status_demo() {
  require_stack
  docker exec "${MANAGER_CONTAINER}" agt get teams -o json
  docker exec "${MANAGER_CONTAINER}" agt get workers -o json
  log "Dashboard: ${DASHBOARD_URL}"
  log "Matrix client: ${ELEMENT_URL}"
}

show_team_messages() {
  require_stack
  local leader_json room_id
  leader_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${LEADER_NAME}" -o json)"
  room_id="$(jq -er '.roomID' <<<"${leader_json}")"
  docker exec -i "${MANAGER_CONTAINER}" sh -s -- "${room_id}" <<'SH'
set -Eeuo pipefail
room_id="$1"
config="${HOME}/openclaw.json"
homeserver="$(jq -er '.channels.matrix.homeserver' "${config}")"
token="$(jq -er '.channels.matrix.accessToken' "${config}")"
room_path="$(printf '%s' "${room_id}" | jq -sRr @uri)"
printf 'header = "Authorization: Bearer %s"\n' "${token}" | \
  curl --config - --fail --silent --show-error --max-time 20 \
    "${homeserver%/}/_matrix/client/v3/rooms/${room_path}/messages?dir=b&limit=30" | \
  jq -r '.chunk[]? | select(.type == "m.room.message") | [.sender, (.content.body // "")] | @tsv'
SH
}

usage() {
  cat <<'EOF'
Usage: scripts/tiangong-demo.sh <start|run|send|show|status|stop>

  start              create the five-role demo Team and leave it running
  run [message]      start, then send a read-only prompt to the Leader
  send [message]     send a formatted Matrix mention to the Leader
  show               print the latest bounded messages in the Team room
  status             show Team/Worker state and browser URLs
  stop               delete only the tiangong-demo-* resources

The demo uses the existing local DeepSeek default route and prebuilt Worker images.
It does not modify provider configuration or persist credentials.
EOF
}

require_command docker
require_command jq
require_command curl
trap cleanup_failed_start EXIT

command="${1:-}"
shift || true
case "${command}" in
  start) start_demo ;;
  run) start_demo; send_to_leader "$@" ;;
  send) send_to_leader "$@" ;;
  show) show_team_messages ;;
  status) status_demo ;;
  stop) require_stack; stop_demo; status_demo ;;
  help|--help|-h) usage ;;
  *) usage; exit 2 ;;
esac
