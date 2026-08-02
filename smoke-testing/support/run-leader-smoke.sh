#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly TEAM_NAME="tiangong-leader-smoke"
readonly LEADER_NAME="tiangong-leader-smoke-leader"
readonly DESIGNER_NAME="tiangong-leader-smoke-designer"
readonly IMPLEMENTOR_NAME="tiangong-leader-smoke-implementor"
readonly ASSESSOR_NAME="tiangong-leader-smoke-assessor"
readonly OPERATOR_NAME="tiangong-leader-smoke-operator"
readonly MEMBERS=("${LEADER_NAME}" "${DESIGNER_NAME}" "${IMPLEMENTOR_NAME}" "${ASSESSOR_NAME}" "${OPERATOR_NAME}")
readonly MANAGER_CONTAINER="agentteams-manager"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly WORKERS_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/leader-smoke-workers.yaml"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/leader-smoke-team.yaml"
readonly TURN_HELPER="${SCRIPT_DIR}/leader-coordination-turn.sh"
readonly BUILD_SCRIPT="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly MANAGER_WORKERS_MANIFEST="/tmp/tiangong-leader-smoke-workers.yaml"
readonly MANAGER_MANIFEST="/tmp/tiangong-leader-smoke-team.yaml"
readonly MANAGER_TURN="/tmp/tiangong-leader-coordination-turn.sh"
PROJECT_ID="leader-smoke-$(head -c 8 /proc/sys/kernel/random/uuid)"
TASK_ID="${PROJECT_ID}-design-0"
owned=0

log() { printf '[Tiangong] %s\n' "$*"; }
die() { printf '[Tiangong] ERROR: %s\n' "$*" >&2; exit 1; }
container_exists() { docker inspect "$1" >/dev/null 2>&1; }
team_exists() { docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json >/dev/null 2>&1; }
worker_exists() { docker exec "${MANAGER_CONTAINER}" agt get workers "$1" -o json >/dev/null 2>&1; }
team_roster_ready() {
  local room_id=$1
  docker exec "agentteams-worker-${LEADER_NAME}" sh -s -- "${room_id}" "${MEMBERS[@]}" <<'SH'
set -eu
room_id=$1
shift
base=${AGENTTEAMS_MATRIX_URL%/}
auth="Authorization: Bearer ${AGENTTEAMS_WORKER_MATRIX_TOKEN}"
joined_rooms=$(curl --fail --silent --show-error --max-time 10 \
  -H "${auth}" "${base}/_matrix/client/v3/joined_rooms" | jq -r '.joined_rooms[]')
printf '%s\n' "${joined_rooms}" | grep -Fxq "${AGENTTEAMS_WORKER_ROOM_ID}"
printf '%s\n' "${joined_rooms}" | grep -Fxq "${room_id}"
candidates=0
for joined_room in ${joined_rooms}; do
  [ "${joined_room}" = "${AGENTTEAMS_WORKER_ROOM_ID}" ] && continue
  room_path=$(printf '%s' "${joined_room}" | jq -sRr @uri)
  members=$(curl --fail --silent --show-error --max-time 10 -H "${auth}" \
    "${base}/_matrix/client/v3/rooms/${room_path}/joined_members" | jq -r '.joined | keys[]')
  roster_match=1
  printf '%s\n' "${members}" | grep -Fxq "@${AGENTTEAMS_WORKER_NAME}:${AGENTTEAMS_MATRIX_DOMAIN}" || roster_match=0
  for worker_name in "$@"; do
    printf '%s\n' "${members}" | grep -Fxq "@${worker_name}:${AGENTTEAMS_MATRIX_DOMAIN}" || roster_match=0
  done
  [ "${roster_match}" -eq 1 ] && candidates=$((candidates + 1))
done
[ "${candidates}" -eq 1 ]
SH
}

cleanup() {
  local status=$? failed=0 member container
  trap - EXIT INT TERM
  set +e
  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_WORKERS_MANIFEST}" "${MANAGER_MANIFEST}" "${MANAGER_TURN}" >/dev/null 2>&1 || failed=1
  if ((owned == 1)); then
    if team_exists; then
      docker exec "${MANAGER_CONTAINER}" agt delete team "${TEAM_NAME}" >/dev/null 2>&1 || failed=1
    else
      for member in "${MEMBERS[@]}"; do
        docker exec "${MANAGER_CONTAINER}" agt delete worker "${member}" >/dev/null 2>&1 || true
      done
    fi
    for _ in $(seq 1 120); do
      gone=1
      team_exists && gone=0
      for member in "${MEMBERS[@]}"; do
        worker_exists "${member}" && gone=0
        container="agentteams-worker-${member}"
        container_exists "${container}" && gone=0
      done
      ((gone == 1)) && break
      sleep 1
    done
    if ((gone == 0)); then
      printf '[Tiangong] ERROR: AgentTeams did not release the owned Team members; preserving their storage for diagnosis.\n' >&2
      failed=1
    else
      for member in "${MEMBERS[@]}"; do
        docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
          "agentteams/agentteams-storage/agents/${member}/" >/dev/null 2>&1 || failed=1
        docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "/root/agentteams-fs/agents/${member}" >/dev/null 2>&1 || failed=1
        docker exec "${MANAGER_CONTAINER}" rm -rf -- "/root/agentteams-fs/agents/${member}" >/dev/null 2>&1 || failed=1
      done
      docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
        "agentteams/agentteams-storage/teams/${TEAM_NAME}/" >/dev/null 2>&1 || failed=1
      docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
        "agentteams/agentteams-storage/shared/projects/${PROJECT_ID}/" >/dev/null 2>&1 || failed=1
      docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
        "agentteams/agentteams-storage/shared/tasks/${TASK_ID}/" >/dev/null 2>&1 || failed=1
      for host in "${CONTROLLER_CONTAINER}" "${MANAGER_CONTAINER}"; do
        docker exec "${host}" rm -rf -- "/root/agentteams-fs/teams/${TEAM_NAME}" \
          "/root/agentteams-fs/shared/projects/${PROJECT_ID}" "/root/agentteams-fs/shared/tasks/${TASK_ID}" >/dev/null 2>&1 || failed=1
        docker exec "${host}" test ! -e "/root/agentteams-fs/shared/projects/${PROJECT_ID}" || failed=1
        docker exec "${host}" test ! -e "/root/agentteams-fs/shared/tasks/${TASK_ID}" || failed=1
      done
    fi
    if ((failed == 0)); then printf 'leader_smoke_cleanup=pass\n'; fi
  fi
  ((failed == 0)) || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for cmd in docker jq grep sha256sum; do command -v "${cmd}" >/dev/null 2>&1 || die "Missing command: ${cmd}"; done
for path in "${WORKERS_MANIFEST}" "${MANIFEST}" "${TURN_HELPER}" "${BUILD_SCRIPT}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || die "Missing or symlinked smoke asset: ${path}"
done
for host in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}"; do
  container_exists "${host}" || die "${host} does not exist"
  [[ "$(docker inspect "${host}" --format '{{.State.Running}}')" == true ]] || die "${host} is not running"
done
! team_exists || die "Reserved Team already exists: ${TEAM_NAME}"
for member in "${MEMBERS[@]}"; do
  ! worker_exists "${member}" || die "Reserved Worker already exists: ${member}"
  ! container_exists "agentteams-worker-${member}" || die "Reserved container already exists: ${member}"
  ! docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive \
    "agentteams/agentteams-storage/agents/${member}/" 2>/dev/null | grep -q . || \
    die "Reserved Worker storage is not empty: ${member}"
done
! docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive \
  "agentteams/agentteams-storage/teams/${TEAM_NAME}/" 2>/dev/null | grep -q . || \
  die "Reserved Team storage is not empty: ${TEAM_NAME}"

"${BUILD_SCRIPT}"
docker cp "${WORKERS_MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_WORKERS_MANIFEST}"
docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
docker cp "${TURN_HELPER}" "${MANAGER_CONTAINER}:${MANAGER_TURN}"
owned=1
log "Creating disposable Workers before binding the Team"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_WORKERS_MANIFEST}" >/dev/null
for _ in $(seq 1 120); do
  ready=1
  for member in "${MEMBERS[@]}"; do
    resource="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${member}" -o json 2>/dev/null || true)"
    [[ "$(jq -r '.phase // empty' <<<"${resource}" 2>/dev/null)" == Running ]] || ready=0
    [[ -n "$(jq -r '.matrixUserID // empty' <<<"${resource}" 2>/dev/null)" ]] || ready=0
    [[ -n "$(jq -r '.roomID // empty' <<<"${resource}" 2>/dev/null)" ]] || ready=0
  done
  ((ready == 1)) && break
  sleep 2
done
((ready == 1)) || die "Standalone Worker credentials did not become ready"
sleep 5
log "Binding the ready Workers into disposable AgentTeams Team ${TEAM_NAME}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_MANIFEST}" >/dev/null
phase=""
for _ in $(seq 1 120); do
  team_json="$(docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json 2>/dev/null || true)"
  phase="$(jq -r '.phase // empty' <<<"${team_json}" 2>/dev/null || true)"
  [[ "${phase}" == Active ]] && break
  [[ "${phase}" == Failed ]] && die "Team entered Failed phase"
  sleep 3
done
[[ "${phase}" == Active ]] || die "Team did not become Active"
[[ "$(jq -r '.readyWorkers' <<<"${team_json}")" == 4 ]] || die "Not all professional Workers are ready"
[[ "$(jq -r '.leaderReady' <<<"${team_json}")" == true ]] || die "Leader is not ready"
team_room="$(jq -r '.teamRoomID // empty' <<<"${team_json}")"
[[ -n "${team_room}" ]] || die "Team room is unavailable"
for _ in $(seq 1 120); do
  team_roster_ready "${team_room}" >/dev/null 2>&1 && break
  sleep 2
done
team_roster_ready "${team_room}" >/dev/null 2>&1 || die "Matrix Team roster did not become ready"

leader_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${LEADER_NAME}" -o json)"
leader_uid="$(jq -r '.matrixUserID // empty' <<<"${leader_json}")"
leader_room="$(jq -r '.roomID // empty' <<<"${leader_json}")"
[[ "$(jq -r '.role' <<<"${leader_json}")" == team_leader ]] || die "Product Leader is not the Team Leader"
designer_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${DESIGNER_NAME}" -o json)"
[[ "$(jq -r '.role' <<<"${designer_json}")" == worker ]] || die "Designer is not an ordinary Team Worker"
[[ "$(jq -r '.team' <<<"${leader_json}")" == "${TEAM_NAME}" ]] || die "Leader Team identity is wrong"
[[ "$(jq -r '.team' <<<"${designer_json}")" == "${TEAM_NAME}" ]] || die "Designer Team identity is wrong"
printf 'leader_smoke_real_team=pass\n'

nonce="$(cat /proc/sys/kernel/random/uuid)"
turn_output="$(docker exec "${MANAGER_CONTAINER}" "${MANAGER_TURN}" \
  "${leader_room}" "${leader_uid}" "${nonce}" "${PROJECT_ID}" "${TASK_ID}" \
  "${DESIGNER_NAME}" "${IMPLEMENTOR_NAME}" "${ASSESSOR_NAME}" "${OPERATOR_NAME}")"
printf '%s\n' "${turn_output}"
grep -Fq LEADER_DONE <<<"${turn_output}" || die "Leader did not complete create + dispatch"

prefix="agentteams/agentteams-storage/shared/tasks/${TASK_ID}"
decision=""
for _ in $(seq 1 120); do
  decision="$(docker exec "${CONTROLLER_CONTAINER}" sh -lc \
    'f=$(mc find "'"${prefix}"'/tiangong/decisions/" --name "*.json" 2>/dev/null | head -n1); [ -n "$f" ] && mc cat "$f"' 2>/dev/null || true)"
  [[ -n "${decision}" ]] && break
  sleep 3
done
[[ -n "${decision}" ]] || die "No Leader decision arrived from the Worker result mention"
[[ "$(jq -r '.decision' <<<"${decision}")" == accept ]] || die "Design result was not accepted"
[[ "$(jq -r '.decidedBy' <<<"${decision}")" == "${LEADER_NAME}" ]] || die "Decision identity is not the authenticated Leader"
result="$(docker exec "${CONTROLLER_CONTAINER}" mc cat "${prefix}/tiangong/result-envelope.json")"
task="$(docker exec "${CONTROLLER_CONTAINER}" mc cat "${prefix}/tiangong/task-binding.json")"
[[ "$(jq -r '.producer' <<<"${result}")" == "${DESIGNER_NAME}" ]] || die "Result producer is not the authenticated Designer"
[[ "$(jq -r '.sourceRole' <<<"${result}")" == designer ]] || die "Result role is not designer"
[[ "$(jq -r '.sourceProfileDigest' <<<"${result}")" == "$(jq -r '.sourceProfileDigest' <<<"${task}")" ]] || die "Result profile is not bound to the Task"
[[ "$(jq -r '.skillDigest' <<<"${result}")" == "$(jq -r '.sourceSkillDigest' <<<"${task}")" ]] || die "Result Skill is not bound to the Task"
[[ "$(jq -r '.resultDigest' <<<"${decision}")" == "$(jq -r '.contentDigest' <<<"${result}")" ]] || die "Decision does not bind the current result"
printf 'leader_smoke_design_roundtrip=pass\n'
printf 'leader_smoke_matrix_handoff=pass\n'
printf 'leader_smoke_gate3=partial_requester_report_not_proven\n'
