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
readonly TURN_CONTAINER="${TIANGONG_MATRIX_SENDER_CONTAINER:-${MANAGER_CONTAINER}}"
readonly WORKERS_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/leader-smoke-workers.yaml"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/leader-smoke-team.yaml"
readonly TURN_HELPER="${SCRIPT_DIR}/leader-coordination-turn.sh"
readonly FOLLOWUP_HELPER="${SCRIPT_DIR}/leader-followup-turn.sh"
readonly REPORT_HELPER="${SCRIPT_DIR}/requester-report-check.sh"
readonly BUILD_SCRIPT="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly MANAGER_WORKERS_MANIFEST="/tmp/tiangong-leader-smoke-workers.yaml"
readonly MANAGER_MANIFEST="/tmp/tiangong-leader-smoke-team.yaml"
readonly MANAGER_TURN="/tmp/tiangong-leader-coordination-turn.sh"
readonly MANAGER_FOLLOWUP="/tmp/tiangong-leader-followup-turn.sh"
readonly MANAGER_REPORT_CHECK="/tmp/tiangong-requester-report-check.sh"
SMOKE_MODEL="${TIANGONG_SMOKE_MODEL:-deepseek-chat}"
PROJECT_ID="leader-smoke-$(head -c 8 /proc/sys/kernel/random/uuid)"
TASK_ID="${PROJECT_ID}-design-0"
owned=0
manager_restart_required=0
controller_api_token=''
declare -A cleanup_room_ids=()

log() { printf '[Tiangong] %s\n' "$*"; }
die() { printf '[Tiangong] ERROR: %s\n' "$*" >&2; exit 1; }
container_exists() { docker inspect "$1" >/dev/null 2>&1; }
team_exists() { docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json >/dev/null 2>&1; }
worker_exists() { docker exec "${MANAGER_CONTAINER}" agt get workers "$1" -o json >/dev/null 2>&1; }
project_task_ids() {
  local task_kind=${1:-}
  docker exec -i "${CONTROLLER_CONTAINER}" sh -s -- "${PROJECT_ID}" "${task_kind}" <<'SH'
set -eu
project_id=$1
task_kind=$2
mc find agentteams/agentteams-storage/shared/tasks --name task-binding.json </dev/null 2>/dev/null |
while IFS= read -r binding_path; do
  mc cat "${binding_path}" </dev/null | jq -r --arg project_id "${project_id}" --arg task_kind "${task_kind}" '
    if .projectId == $project_id and ($task_kind == "" or .taskKind == $task_kind)
    then .taskId
    else empty
    end
  '
done
SH
}
requester_report_evidence_ready() {
  docker exec -i "agentteams-worker-${LEADER_NAME}" node --input-type=module - "${PROJECT_ID}" <<'JS'
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceRecorder } from "/opt/tiangong-worker/agent/evidence/recorder.mjs";

const projectId = process.argv[2];
const root = `/root/agentteams-fs/agents/${process.env.AGENTTEAMS_WORKER_NAME}/.tiangong/runtime/evidence`;
let sessions;
try {
  sessions = await readdir(root, { withFileTypes: true });
} catch (error) {
  if (error?.code === "ENOENT") process.exit(1);
  throw error;
}
const matches = [];
for (const session of sessions) {
  if (!session.isDirectory()) continue;
  const recorder = new EvidenceRecorder({ filePath: join(root, session.name, "events.jsonl") });
  for (const event of await recorder.readAll()) {
    if (event.type === "team.requester.report.delivered" && event.projectId === projectId) matches.push(event);
  }
}
if (matches.length !== 1 || matches[0].disposition !== "RECOVERY_REQUIRED" || matches[0].delivered !== true) {
  process.exit(1);
}
JS
}

capture_failure_markers() {
  local evidence_dir="${TIANGONG_SMOKE_EVIDENCE_DIR:-}" member container
  [[ -n "${evidence_dir}" ]] || return 0
  mkdir -p "${evidence_dir}" 2>/dev/null || return 0
  for member in "${MEMBERS[@]}"; do
    container="agentteams-worker-${member}"
    if docker inspect "${container}" >/dev/null 2>&1; then
      # Keep evidence machine-oriented and redact token-like values before
      # writing it to the ignored local smoke state directory.
      docker logs --since 20m "${container}" 2>&1 |
        grep -E 'tiangong_|codex_|embedded run (start|end)|embedded run tool (start|end)|tool.*(error|Error)|reported ready' |
        sed -E 's/[A-Za-z0-9_./:-]{32,}/[redacted]/g' |
        tail -n 120 >"${evidence_dir}/worker-${member}-markers.log" || true
    fi
  done
}

team_roster_ready() {
  local room_id=$1
  docker exec -i "agentteams-worker-${LEADER_NAME}" sh -s -- "${room_id}" "${MEMBERS[@]}" <<'SH'
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
team_peer_policy_ready() {
  local member
  for member in "${MEMBERS[@]}"; do
    docker exec -i "agentteams-worker-${member}" sh -s -- "${MEMBERS[@]}" <<'SH'
set -eu
config="/root/agentteams-fs/agents/${AGENTTEAMS_WORKER_NAME}/openclaw.json"
[ "$(jq -r '.channels.matrix.groupPolicy' "${config}")" = allowlist ]
[ "$(jq -r '.channels.matrix.dm.policy' "${config}")" = allowlist ]
allowed=$(jq -r '.channels.matrix.groupAllowFrom[]' "${config}")
for peer_name in "$@"; do
  [ "${peer_name}" = "${AGENTTEAMS_WORKER_NAME}" ] && continue
  printf '%s\n' "${allowed}" | grep -Fxq "@${peer_name}:${AGENTTEAMS_MATRIX_DOMAIN}"
done
SH
  done
}
refresh_team_worker_policy() {
  local member
  # AgentTeams v1.2.2 materializes the Team peer allowlist when an existing
  # Worker is started again. Exercise that supported lifecycle boundary before
  # treating the Team policy as ready; this does not edit OpenClaw config.
  for member in "${MEMBERS[@]}"; do
    docker exec "${MANAGER_CONTAINER}" agt update worker --name "${member}" --state Sleeping >/dev/null
    for _ in $(seq 1 60); do
      phase="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${member}" -o json 2>/dev/null | jq -r '.phase // empty' 2>/dev/null || true)"
      [[ "${phase}" == Sleeping ]] && break
      sleep 1
    done
    [[ "${phase}" == Sleeping ]] || die "Worker did not enter Sleeping state for Team policy refresh: ${member}"
    docker exec "${MANAGER_CONTAINER}" agt update worker --name "${member}" --state Running >/dev/null
    for _ in $(seq 1 120); do
      phase="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${member}" -o json 2>/dev/null | jq -r '.phase // empty' 2>/dev/null || true)"
      [[ "${phase}" == Running ]] && break
      sleep 1
    done
    [[ "${phase}" == Running ]] || die "Worker did not return to Running state after Team policy refresh: ${member}"
  done
}
team_peer_policy_loaded() {
  local since=$1 member logs
  for member in "${MEMBERS[@]}"; do
    logs="$(docker logs --since "${since}" "agentteams-worker-${member}" 2>&1 || true)"
    grep -Fq 'group allowlist resolved' <<<"${logs}"
  done
}

capture_manager_cleanup_state() {
  local member resource
  controller_api_token="$(docker exec "${MANAGER_CONTAINER}" printenv AGENTTEAMS_AUTH_TOKEN 2>/dev/null || true)"
  [[ -n "${controller_api_token}" ]] || return 1
  for member in "${MEMBERS[@]}"; do
    resource="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${member}" -o json 2>/dev/null || true)"
    cleanup_room_ids["${member}"]="$(jq -r '.roomID // empty' <<<"${resource}" 2>/dev/null || true)"
  done
  if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
    docker stop "${MANAGER_CONTAINER}" >/dev/null || return 1
    manager_restart_required=1
  fi
}

leave_manager_from_worker_room() {
  local member="$1" room_id="${cleanup_room_ids[$1]:-}"
  [[ -n "${room_id}" ]] || return 0
  docker exec -i "${CONTROLLER_CONTAINER}" sh -s -- "${room_id}" <<'SH'
set -eu
room_id="$1"
config=/root/agentteams-fs/agents/manager/openclaw.json
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${config}")"
access_token="$(jq -r '.channels.matrix.accessToken // empty' "${config}")"
[ -n "${homeserver}" ] && [ -n "${access_token}" ]
room_path="$(printf '%s' "${room_id}" | jq -sRr @uri)"
response="$(printf 'header = "Authorization: Bearer %s"\n' "${access_token}" | curl --silent --show-error --max-time 30 -K - -X POST -w '\n%{http_code}' "${homeserver%/}/_matrix/client/v3/rooms/${room_path}/leave")"
status="$(printf '%s\n' "${response}" | tail -n 1)"
body="$(printf '%s\n' "${response}" | sed '$d')"
if [ "${status}" = 200 ]; then exit 0; fi
if [ "${status}" = 403 ] && printf '%s' "${body}" | jq -e '.error == "M_FORBIDDEN: Auth check failed: cannot leave if not joined, invited or knocked"' >/dev/null 2>&1; then exit 0; fi
exit 1
SH
}

controller_team_status() {
  printf 'header = "Authorization: Bearer %s"\n' "${controller_api_token}" | \
    docker exec -i "${CONTROLLER_CONTAINER}" curl --silent --show-error --max-time 5 \
      -K - -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:8090/api/v1/teams/${TEAM_NAME}"
}

controller_delete_team() {
  local status
  status="$(printf 'header = "Authorization: Bearer %s"\n' "${controller_api_token}" | \
    docker exec -i "${CONTROLLER_CONTAINER}" curl --silent --show-error --max-time 5 \
      -K - -o /dev/null -w '%{http_code}' -X DELETE \
      "http://127.0.0.1:8090/api/v1/teams/${TEAM_NAME}")"
  [[ "${status}" == 204 || "${status}" == 404 ]]
}

wait_for_team_absent() {
  for _ in $(seq 1 360); do
    [[ "$(controller_team_status)" == 404 ]] && return 0
    sleep 1
  done
  return 1
}

restart_manager_after_cleanup() {
  ((manager_restart_required == 1)) || return 0
  docker start "${MANAGER_CONTAINER}" >/dev/null || return 1
  for _ in $(seq 1 60); do
    docker exec "${MANAGER_CONTAINER}" agt get workers -o json >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

remove_storage_prefix() {
  local prefix="$1"
  if docker exec "${CONTROLLER_CONTAINER}" mc find "${prefix}" 2>/dev/null | grep -q .; then
    docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force "${prefix}" >/dev/null 2>&1
  fi
}

storage_prefix_absent() {
  local prefix="$1"
  ! docker exec "${CONTROLLER_CONTAINER}" mc find "${prefix}" 2>/dev/null | grep -q .
}

cleanup() {
  local status=$? failed=0 member container task_id discovered_id gone
  local -a project_tasks=("${TASK_ID}")
  trap - EXIT INT TERM
  set +e
  ((status == 0)) || capture_failure_markers
  while IFS= read -r discovered_id; do
    [[ "${discovered_id}" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || continue
    [[ " ${project_tasks[*]} " == *" ${discovered_id} "* ]] || project_tasks+=("${discovered_id}")
  done < <(project_task_ids 2>/dev/null)
  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_WORKERS_MANIFEST}" "${MANAGER_MANIFEST}" \
    "${MANAGER_TURN}" "${MANAGER_REPORT_CHECK}" >/dev/null 2>&1 || failed=1
  if ((owned == 1)); then
    # AgentTeams v1.2 releases a Team only after the Manager leaves the
    # personal Worker rooms. Stop it, use its exact room facts through the
    # Controller-side config, delete only this Team through the Controller API,
    # and restart it only after the Team is absent.
    if capture_manager_cleanup_state; then
      for member in "${MEMBERS[@]}"; do
        leave_manager_from_worker_room "${member}" || failed=1
      done
      controller_delete_team || failed=1
      wait_for_team_absent || failed=1
      restart_manager_after_cleanup || failed=1
    else
      failed=1
    fi

    if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
      for member in "${MEMBERS[@]}"; do
        if docker exec "${MANAGER_CONTAINER}" agt get workers "${member}" -o json >/dev/null 2>&1; then
          docker exec "${MANAGER_CONTAINER}" agt delete worker "${member}" >/dev/null 2>&1 || true
        fi
        container="agentteams-worker-${member}"
        if container_exists "${container}"; then
          docker rm --force "${container}" >/dev/null 2>&1 || true
        fi
      done
      # The Controller delete can release the containers while the Manager's
      # cached Team object remains. Reconcile that exact Team record now that
      # all owned members are gone.
      if team_exists; then
        docker exec "${MANAGER_CONTAINER}" agt delete team "${TEAM_NAME}" >/dev/null 2>&1 || true
      fi
      for _ in $(seq 1 120); do
        team_exists || break
        sleep 1
      done
    else
      failed=1
    fi

    gone=1
    team_exists && gone=0
    if [[ "$(controller_team_status 2>/dev/null || true)" != 404 ]]; then gone=0; fi
    for member in "${MEMBERS[@]}"; do
      worker_exists "${member}" && gone=0
      container_exists "agentteams-worker-${member}" && gone=0
    done
    if ((gone == 0)); then
      printf '[Tiangong] ERROR: AgentTeams did not release the owned Team members; preserving their storage for diagnosis.\n' >&2
      failed=1
    fi

    for member in "${MEMBERS[@]}"; do
      remove_storage_prefix \
        "agentteams/agentteams-storage/agents/${member}/" || failed=1
      docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "/root/agentteams-fs/agents/${member}" >/dev/null 2>&1 || failed=1
      if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
        docker exec "${MANAGER_CONTAINER}" rm -rf -- "/root/agentteams-fs/agents/${member}" >/dev/null 2>&1 || failed=1
      else
        failed=1
      fi
    done
    remove_storage_prefix \
      "agentteams/agentteams-storage/teams/${TEAM_NAME}/" || failed=1
    remove_storage_prefix \
      "agentteams/agentteams-storage/shared/projects/${PROJECT_ID}/" || failed=1
    for task_id in "${project_tasks[@]}"; do
      remove_storage_prefix \
        "agentteams/agentteams-storage/shared/tasks/${task_id}/" || failed=1
    done
    for member in "${MEMBERS[@]}"; do
      storage_prefix_absent "agentteams/agentteams-storage/agents/${member}/" || failed=1
    done
    storage_prefix_absent "agentteams/agentteams-storage/teams/${TEAM_NAME}/" || failed=1
    storage_prefix_absent "agentteams/agentteams-storage/shared/projects/${PROJECT_ID}/" || failed=1
    for task_id in "${project_tasks[@]}"; do
      storage_prefix_absent "agentteams/agentteams-storage/shared/tasks/${task_id}/" || failed=1
    done
    docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "/root/agentteams-fs/teams/${TEAM_NAME}" \
      "/root/agentteams-fs/shared/projects/${PROJECT_ID}" >/dev/null 2>&1 || failed=1
    docker exec "${CONTROLLER_CONTAINER}" test ! -e "/root/agentteams-fs/shared/projects/${PROJECT_ID}" || failed=1
    if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
      docker exec "${MANAGER_CONTAINER}" rm -rf -- "/root/agentteams-fs/teams/${TEAM_NAME}" \
        "/root/agentteams-fs/shared/projects/${PROJECT_ID}" >/dev/null 2>&1 || failed=1
      docker exec "${MANAGER_CONTAINER}" test ! -e "/root/agentteams-fs/shared/projects/${PROJECT_ID}" || failed=1
      for task_id in "${project_tasks[@]}"; do
        docker exec "${MANAGER_CONTAINER}" rm -rf -- "/root/agentteams-fs/shared/tasks/${task_id}" >/dev/null 2>&1 || failed=1
        docker exec "${MANAGER_CONTAINER}" test ! -e "/root/agentteams-fs/shared/tasks/${task_id}" || failed=1
      done
    else
      failed=1
    fi
    # Intermediate leave/delete calls may race AgentTeams reconciliation. The
    # authoritative cleanup gate is the final absence proof: no Team/Worker,
    # no owned containers, no exact MinIO prefixes, and a restored Manager.
    final_clean=1
    [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]] || final_clean=0
    team_exists && final_clean=0
    [[ "$(controller_team_status 2>/dev/null || true)" == 404 ]] || final_clean=0
    for member in "${MEMBERS[@]}"; do
      worker_exists "${member}" && final_clean=0
      container_exists "agentteams-worker-${member}" && final_clean=0
      storage_prefix_absent "agentteams/agentteams-storage/agents/${member}/" || final_clean=0
    done
    storage_prefix_absent "agentteams/agentteams-storage/teams/${TEAM_NAME}/" || final_clean=0
    storage_prefix_absent "agentteams/agentteams-storage/shared/projects/${PROJECT_ID}/" || final_clean=0
    for task_id in "${project_tasks[@]}"; do
      storage_prefix_absent "agentteams/agentteams-storage/shared/tasks/${task_id}/" || final_clean=0
    done
    ((final_clean == 1)) && failed=0
    if ((failed == 0)); then
      printf 'leader_smoke_cleanup=pass\n'
    else
      printf 'leader_smoke_cleanup=fail\n' >&2
    fi
  fi
  ((failed == 0)) || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for cmd in awk docker jq grep sha256sum; do command -v "${cmd}" >/dev/null 2>&1 || die "Missing command: ${cmd}"; done
[[ "${SMOKE_MODEL}" =~ ^[A-Za-z0-9._:/-]{1,128}$ ]] || die "Invalid TIANGONG_SMOKE_MODEL"
for path in "${WORKERS_MANIFEST}" "${MANIFEST}" "${TURN_HELPER}" "${FOLLOWUP_HELPER}" "${REPORT_HELPER}" "${BUILD_SCRIPT}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || die "Missing or symlinked smoke asset: ${path}"
done
for host in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}" "${TURN_CONTAINER}"; do
  # A Worker sender is created by this smoke itself; validate it after the
  # disposable Worker readiness loop instead of before creation.
  if [[ "${host}" == "${TURN_CONTAINER}" && "${host}" != "${MANAGER_CONTAINER}" && "${host}" != "${CONTROLLER_CONTAINER}" ]]; then
    continue
  fi
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
! docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive \
  "agentteams/agentteams-storage/shared/projects/${PROJECT_ID}/" 2>/dev/null | grep -q . || \
  die "Reserved Project storage is not empty: ${PROJECT_ID}"
! docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive \
  "agentteams/agentteams-storage/shared/tasks/${TASK_ID}/" 2>/dev/null | grep -q . || \
  die "Reserved Task storage is not empty: ${TASK_ID}"

"${BUILD_SCRIPT}"
docker cp "${WORKERS_MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_WORKERS_MANIFEST}"
# Keep the committed fixture pinned to the AgentTeams-supported DeepSeek Chat
# smoke while
# allowing an explicitly isolated provider/model canary.  The manifest is
# rendered inside the Manager container, so Docker Desktop path handling is
# identical for the default and canary lanes.
docker exec -i "${MANAGER_CONTAINER}" sh -s -- "${SMOKE_MODEL}" "${MANAGER_WORKERS_MANIFEST}" <<'SH'
set -eu
model="$1"
manifest="$2"
sed -E -i "s#^  model: .*#  model: ${model}#" "${manifest}"
grep -Fqx "  model: ${model}" "${manifest}"
SH
printf 'leader_smoke_model=%s\n' "${SMOKE_MODEL}"
docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
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
container_exists "${TURN_CONTAINER}" || die "Matrix sender container does not exist after Worker readiness"
[[ "$(docker inspect "${TURN_CONTAINER}" --format '{{.State.Running}}')" == true ]] || die "Matrix sender container is not running"
docker cp "${TURN_HELPER}" "${TURN_CONTAINER}:${MANAGER_TURN}"
docker cp "${FOLLOWUP_HELPER}" "${TURN_CONTAINER}:${MANAGER_FOLLOWUP}"
docker cp "${REPORT_HELPER}" "${TURN_CONTAINER}:${MANAGER_REPORT_CHECK}"
sleep 5
log "Binding the ready Workers into disposable AgentTeams Team ${TEAM_NAME}"
team_binding_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
refresh_team_worker_policy
stable_roster_checks=0
for _ in $(seq 1 120); do
  if team_roster_ready "${team_room}" >/dev/null 2>&1; then
    stable_roster_checks=$((stable_roster_checks + 1))
    ((stable_roster_checks >= 3)) && break
  else
    stable_roster_checks=0
  fi
  sleep 2
done
((stable_roster_checks >= 3)) || die "Matrix Team roster did not become stably ready"
stable_peer_policy_checks=0
for _ in $(seq 1 180); do
  if team_peer_policy_ready >/dev/null 2>&1; then
    stable_peer_policy_checks=$((stable_peer_policy_checks + 1))
    ((stable_peer_policy_checks >= 3)) && break
  else
    stable_peer_policy_checks=0
  fi
  sleep 2
done
((stable_peer_policy_checks >= 3)) || die "OpenClaw Team peer policy did not become stably ready"
for _ in $(seq 1 180); do
  team_peer_policy_loaded "${team_binding_started_at}" && break
  sleep 2
done
team_peer_policy_loaded "${team_binding_started_at}" || die "OpenClaw did not load the Team peer policy"

leader_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${LEADER_NAME}" -o json)"
leader_uid="$(jq -r '.matrixUserID // empty' <<<"${leader_json}")"
[[ "$(jq -r '.role' <<<"${leader_json}")" == team_leader ]] || die "Product Leader is not the Team Leader"
designer_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${DESIGNER_NAME}" -o json)"
designer_room="$(jq -r '.roomID // empty' <<<"${designer_json}")"
[[ "$(jq -r '.role' <<<"${designer_json}")" == worker ]] || die "Designer is not an ordinary Team Worker"
[[ "$(jq -r '.team' <<<"${leader_json}")" == "${TEAM_NAME}" ]] || die "Leader Team identity is wrong"
[[ "$(jq -r '.team' <<<"${designer_json}")" == "${TEAM_NAME}" ]] || die "Designer Team identity is wrong"
[[ -n "${designer_room}" ]] || die "Designer requester room is unavailable"
printf 'leader_smoke_real_team=pass\n'

nonce="$(cat /proc/sys/kernel/random/uuid)"
turn_output="$(docker exec "${TURN_CONTAINER}" "${MANAGER_TURN}" \
  "${team_room}" "${leader_uid}" "${nonce}" "${PROJECT_ID}" "${TASK_ID}" \
  "${DESIGNER_NAME}" "${IMPLEMENTOR_NAME}" "${ASSESSOR_NAME}" "${OPERATOR_NAME}")"
printf '%s\n' "${turn_output}"
grep -Fq LEADER_DONE <<<"${turn_output}" || die "Leader did not complete create + dispatch"

prefix="agentteams/agentteams-storage/shared/tasks/${TASK_ID}"
implement_task_id="${PROJECT_ID}-implement-0"
design_result=""
for _ in $(seq 1 120); do
  design_result="$(docker exec "${CONTROLLER_CONTAINER}" mc cat "${prefix}/tiangong/result-envelope.json" 2>/dev/null || true)"
  if [[ -n "${design_result}" ]]; then
    followup_nonce="$(cat /proc/sys/kernel/random/uuid)"
    docker exec "${TURN_CONTAINER}" "${MANAGER_FOLLOWUP}" \
      "${team_room}" "${leader_uid}" "${followup_nonce}" design "${PROJECT_ID}" "${TASK_ID}" \
      "${implement_task_id}" "${IMPLEMENTOR_NAME}"
    break
  fi
  sleep 3
done
[[ -n "${design_result}" ]] || die "No design ResultEnvelope arrived from the Worker result mention"
decision=""
for _ in $(seq 1 120); do
  decision="$(docker exec "${CONTROLLER_CONTAINER}" sh -lc \
    'f=$(mc find "'"${prefix}"'/tiangong/decisions/" --name "*.json" 2>/dev/null | head -n1); [ -n "$f" ] && mc cat "$f"' 2>/dev/null || true)"
  [[ -n "${decision}" ]] && break
  sleep 3
done
[[ -n "${decision}" ]] || die "No Leader decision arrived after the native Leader resume"
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

for _ in $(seq 1 120); do
  mapfile -t implement_ids < <(project_task_ids implement 2>/dev/null)
  if ((${#implement_ids[@]} > 1)); then
    die "Project created more than one implement Task"
  fi
  if ((${#implement_ids[@]} == 1)); then
    implement_task_id="${implement_ids[0]}"
    break
  fi
  sleep 3
done
[[ "${implement_task_id}" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || die "No valid Implementor Task arrived"
implement_prefix="agentteams/agentteams-storage/shared/tasks/${implement_task_id}"
implement_result=""
for _ in $(seq 1 120); do
  implement_result="$(docker exec "${CONTROLLER_CONTAINER}" mc cat "${implement_prefix}/tiangong/result-envelope.json" 2>/dev/null || true)"
  [[ -n "${implement_result}" ]] && break
  sleep 3
done
followup_nonce="$(cat /proc/sys/kernel/random/uuid)"
docker exec "${TURN_CONTAINER}" "${MANAGER_FOLLOWUP}" \
  "${team_room}" "${leader_uid}" "${followup_nonce}" implement "${PROJECT_ID}" "${TASK_ID}" \
  "${implement_task_id}" "${IMPLEMENTOR_NAME}"
implement_decision=""
for _ in $(seq 1 120); do
  implement_decision="$(docker exec "${CONTROLLER_CONTAINER}" sh -lc \
    'f=$(mc find "'"${implement_prefix}"'/tiangong/decisions/" --name "*.json" 2>/dev/null | head -n1); [ -n "$f" ] && mc cat "$f"' 2>/dev/null || true)"
  [[ -n "${implement_decision}" ]] && break
  sleep 3
done
[[ -n "${implement_decision}" ]] || die "No Leader decision arrived for the Implementor result"
implement_result="$(docker exec "${CONTROLLER_CONTAINER}" mc cat "${implement_prefix}/tiangong/result-envelope.json" 2>/dev/null || true)"
implement_task="$(docker exec "${CONTROLLER_CONTAINER}" mc cat "${implement_prefix}/tiangong/task-binding.json")"
[[ "$(jq -r '.decision' <<<"${implement_decision}")" == blocked ]] || die "Implementor blocker was not decided as blocked"
[[ "$(jq -r '.decidedBy' <<<"${implement_decision}")" == "${LEADER_NAME}" ]] || die "Implementor decision identity is not the authenticated Leader"
if [[ -n "${implement_result}" ]]; then
  [[ "$(jq -r '.producer' <<<"${implement_result}")" == "${IMPLEMENTOR_NAME}" ]] || die "Implementor result producer is wrong"
  [[ "$(jq -r '.sourceRole' <<<"${implement_result}")" == implementor ]] || die "Implementor result role is wrong"
  [[ -n "$(jq -r '.blocker // empty' <<<"${implement_result}")" ]] || die "Implementor result did not fail closed with a blocker"
  [[ "$(jq -r '.sourceProfileDigest' <<<"${implement_result}")" == "$(jq -r '.sourceProfileDigest' <<<"${implement_task}")" ]] || die "Implementor result profile is not bound to the Task"
  [[ "$(jq -r '.skillDigest' <<<"${implement_result}")" == "$(jq -r '.sourceSkillDigest' <<<"${implement_task}")" ]] || die "Implementor Result Skill is not bound to the Task"
  [[ "$(jq -r '.resultDigest' <<<"${implement_decision}")" == "$(jq -r '.contentDigest' <<<"${implement_result}")" ]] || die "Blocked decision does not bind the Implementor result"
  printf 'leader_smoke_implementor_blocker_result=pass\n'
else
  # A blocked decision may be the fail-closed response to an external
  # prerequisite before a Worker can materialize a ResultEnvelope. In that
  # branch the immutable decision must not claim a result digest; the terminal
  # RECOVERY_REQUIRED report remains the authoritative outcome.
  [[ -z "$(jq -r '.resultDigest // empty' <<<"${implement_decision}")" ]] || die "Missing Implementor Result conflicts with a decision digest"
  printf 'leader_smoke_implementor_blocker_without_result=pass\n'
fi
printf 'leader_smoke_implementor_blocker=pass\n'

report_path="agentteams/agentteams-storage/shared/projects/${PROJECT_ID}/tiangong/terminal-report.json"
report=""
for _ in $(seq 1 120); do
  report="$(docker exec "${CONTROLLER_CONTAINER}" mc cat "${report_path}" 2>/dev/null || true)"
  [[ -n "${report}" ]] && break
  sleep 3
done
[[ -n "${report}" ]] || die "Leader did not create the requester terminal report"
project="$(docker exec "${CONTROLLER_CONTAINER}" mc cat \
  "agentteams/agentteams-storage/shared/projects/${PROJECT_ID}/tiangong/project-binding.json")"
[[ "$(jq -r '.disposition' <<<"${report}")" == RECOVERY_REQUIRED ]] || die "Blocker report disposition is not RECOVERY_REQUIRED"
[[ "$(jq -r '.reportedBy' <<<"${report}")" == "${LEADER_NAME}" ]] || die "Terminal report identity is not the authenticated Leader"
[[ "$(jq -r '.requester' <<<"${report}")" == "$(jq -r '.requester' <<<"${project}")" ]] || die "Terminal report is not bound to the authenticated requester"
report_unsigned="$(jq -cS 'del(.contentDigest)' <<<"${report}")"
report_digest="$(printf '%s' "${report_unsigned}" | sha256sum | awk '{print $1}')"
[[ "${report_digest}" == "$(jq -r '.contentDigest' <<<"${report}")" ]] || die "Terminal report digest is invalid"

# AgentTeams v1.2.2 exposes one authenticated Team room to the recreated
# Workers; the per-Worker room metadata is not a stable requester ingress
# across Manager reconciliation. The durable report still binds the original
# requester identity, so verify its Matrix projection in that canonical Team
# room rather than following a stale personal-room id.
docker exec "${TURN_CONTAINER}" "${MANAGER_REPORT_CHECK}" \
  "${team_room}" "${leader_uid}" "${PROJECT_ID}" RECOVERY_REQUIRED
requester_report_evidence_ready || die "Durable requester-report Evidence is missing or invalid"
mapfile -t assess_ids < <(project_task_ids assess 2>/dev/null)
((${#assess_ids[@]} == 0)) || die "A blocked Project incorrectly created an Assess Task"
printf 'leader_smoke_requester_report=pass\n'
printf 'leader_smoke_gate3=partial_blocked_terminal_only\n'
