#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker:dev"
readonly MODEL="qwen3.5-plus"
readonly TEAM_NAME="tiangong-team-smoke"
readonly LEADER_NAME="tiangong-team-smoke-leader"
readonly WORKER_NAME="tiangong-team-smoke-engineer"
readonly LEADER_CONTAINER="agentteams-worker-${LEADER_NAME}"
readonly WORKER_CONTAINER="agentteams-worker-${WORKER_NAME}"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/pi-smoke-team.yaml"
readonly BUILD_WORKER_IMAGE="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly MATRIX_ROUNDTRIP="${SCRIPT_DIR}/matrix-roundtrip.sh"
readonly MATRIX_ROOM_MEMBERS="${SCRIPT_DIR}/matrix-room-members.sh"
readonly MATRIX_ALIAS_CLEANUP="${SCRIPT_DIR}/matrix-clean-team-smoke-aliases.sh"
readonly MANAGER_MANIFEST="/tmp/tiangong-pi-smoke-team.yaml"
readonly MANAGER_MATRIX_ROUNDTRIP="/tmp/tiangong-team-matrix-roundtrip.sh"
readonly CONTROLLER_MATRIX_ALIAS_CLEANUP="/tmp/tiangong-team-matrix-alias-cleanup.sh"
readonly LEADER_MATRIX_ROUNDTRIP="/tmp/tiangong-team-matrix-roundtrip.sh"
readonly LEADER_MATRIX_ROOM_MEMBERS="/tmp/tiangong-team-matrix-room-members.sh"
created=0

log() {
  printf '[Tiangong] %s\n' "$*"
}

die() {
  printf '[Tiangong] ERROR: %s\n' "$*" >&2
  exit 1
}

team_json() {
  docker exec "${MANAGER_CONTAINER}" hiclaw get teams "${TEAM_NAME}" -o json 2>/dev/null
}

member_json() {
  local member_name="$1"
  docker exec "${MANAGER_CONTAINER}" hiclaw get workers "${member_name}" -o json 2>/dev/null
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

remote_prefix_has_objects() {
  local prefix="$1"
  docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive \
    "agentteams/agentteams-storage/${prefix}/" 2>/dev/null | grep -q .
}

purge_reserved_storage() {
  local prefix mirror_root
  local prefixes=(
    "agents/${LEADER_NAME}"
    "agents/${WORKER_NAME}"
    "teams/${TEAM_NAME}"
  )
  for prefix in "${prefixes[@]}"; do
    docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
      "agentteams/agentteams-storage/${prefix}/" >/dev/null 2>&1 || true
  done
  for mirror_root in \
    "/root/hiclaw-fs/agents/${LEADER_NAME}" \
    "/root/hiclaw-fs/agents/${WORKER_NAME}" \
    "/root/hiclaw-fs/teams/${TEAM_NAME}"; do
    docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "${mirror_root}" >/dev/null 2>&1 || true
    docker exec "${MANAGER_CONTAINER}" rm -rf -- "${mirror_root}" >/dev/null 2>&1 || true
  done
}

reserved_storage_absent() {
  local prefix mirror_root
  for prefix in \
    "agents/${LEADER_NAME}" \
    "agents/${WORKER_NAME}" \
    "teams/${TEAM_NAME}"; do
    if remote_prefix_has_objects "${prefix}"; then
      return 1
    fi
  done
  for mirror_root in \
    "/root/hiclaw-fs/agents/${LEADER_NAME}" \
    "/root/hiclaw-fs/agents/${WORKER_NAME}" \
    "/root/hiclaw-fs/teams/${TEAM_NAME}"; do
    if docker exec "${CONTROLLER_CONTAINER}" test -e "${mirror_root}" || \
        docker exec "${MANAGER_CONTAINER}" test -e "${mirror_root}"; then
      return 1
    fi
  done
}

wait_for_member_channel() {
  local container="$1" member="$2" since="$3"
  shift 3
  local room_id member_logs all_rooms
  for _ in $(seq 1 90); do
    member_logs="$(docker logs --since "${since}" "${container}" 2>&1 || true)"
    all_rooms=1
    for room_id in "$@"; do
      if ! grep -Fq "[matrix] joined room ${room_id}" <<<"${member_logs}"; then
        all_rooms=0
        break
      fi
    done
    if [[ "$(docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null)" == "true" ]] && \
        docker exec "${container}" openclaw health >/dev/null 2>&1 && \
        ((all_rooms == 1)) && \
        grep -Fq "worker/${member} reported ready" <<<"${member_logs}"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

assert_member_runtime() {
  local name="$1" role="$2" container="$3" resource actual
  resource="$(member_json "${name}")" || die "Member ${name} is not observable."
  [[ "$(jq -r '.phase // empty' <<<"${resource}")" == "Running" ]] || \
    die "Member ${name} is not Running."
  if [[ "${role}" == "team_leader" ]]; then
    # AgentTeams v1.2.0-beta.1 synthesizes legacy Team Leader API responses
    # with runtime=copaw and without image even when the Team spec and actual
    # container use explicit values. Record that upstream projection as a
    # compatibility observation; prove the runtime from the container and the
    # real Tiangong Harness below instead of treating the lossy view as truth.
    printf 'team_leader_api_runtime_projection=%s\n' \
      "$(jq -r '.runtime // "missing"' <<<"${resource}")"
    printf 'team_leader_api_image_projection=%s\n' \
      "$(jq -r '.image // "missing"' <<<"${resource}")"
  else
    [[ "$(jq -r '.runtime // empty' <<<"${resource}")" == "openclaw" ]] || \
      die "Member ${name} did not retain runtime=openclaw."
    [[ "$(jq -r '.image // empty' <<<"${resource}")" == "${IMAGE}" ]] || \
      die "Member ${name} did not retain the explicit image."
  fi
  [[ "$(jq -r '.role // empty' <<<"${resource}")" == "${role}" ]] || \
    die "Member ${name} has the wrong synthesized role."
  [[ "$(jq -r '.team // empty' <<<"${resource}")" == "${TEAM_NAME}" ]] || \
    die "Member ${name} has the wrong team identity."
  [[ "$(docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null)" == "true" ]] || \
    die "Container ${container} is not running."
  actual="$(docker inspect "${container}" --format '{{.Config.Image}}')"
  [[ "${actual}" == "${IMAGE}" ]] || die "Expected image ${IMAGE}, got ${actual} for ${name}."
  [[ "$(docker exec "${container}" printenv AGENTTEAMS_WORKER_ROLE)" == "${role}" ]] || \
    die "Trusted role environment fact is wrong for ${name}."
  [[ "$(docker exec "${container}" printenv AGENTTEAMS_WORKER_NAME)" == "${name}" ]] || \
    die "Worker identity environment fact is wrong for ${name}."
  [[ "$(docker exec "${container}" printenv HOME)" == "/root/hiclaw-fs/agents/${name}" ]] || \
    die "Worker HOME is wrong for ${name}."
  [[ "$(docker exec "${container}" printenv OPENCLAW_AGENT_RUNTIME)" == "tiangong-pi" ]] || \
    die "Tiangong OpenClaw Agent runtime is not selected for ${name}."
  docker exec "${container}" openclaw health >/dev/null 2>&1 || \
    die "OpenClaw runtime health failed for ${name}."
  docker exec "${container}" test -d "/root/hiclaw-fs/agents/${name}" || \
    die "Worker HOME does not exist for ${name}."
  printf 'member_%s_runtime=pass\n' "${role}"
}

assert_read_evidence() {
  local container="$1" member="$2" target="$3"
  local agent_root evidence_files evidence_file turn_id execution_count
  agent_root="/root/hiclaw-fs/agents/${member}"
  evidence_files="$(docker exec "${container}" grep -RlF --include=events.jsonl \
    "\"target\":\"${target}\"" \
    "${agent_root}/.tiangong/runtime/sessions" || true)"
  [[ "$(grep -c . <<<"${evidence_files}")" == "1" ]] || \
    die "Expected exactly one Evidence chain for ${member}/${target}."
  evidence_file="${evidence_files}"
  turn_id="$(docker exec "${container}" jq -r --arg target "${target}" '
    select(.type == "gate.decided" and .toolName == "read" and .operation.target == $target)
    | .turnId
  ' "${evidence_file}")"
  [[ -n "${turn_id}" ]] || die "Read Gate evidence is missing for ${member}."
  execution_count="$(docker exec "${container}" jq -s --arg turn "${turn_id}" '
    [.[] | select(
      .type == "tool.execution.completed" and
      .toolName == "read" and
      .turnId == $turn and
      .status == "success"
    )] | length
  ' "${evidence_file}")"
  [[ "${execution_count}" == "1" ]] || \
    die "Read tool did not complete exactly once for ${member}."
  docker exec "${container}" jq -r 'select(.hash != null) | .hash' \
    "${evidence_file}" | tail -n 1
}

assert_harness() {
  local container="$1" member="$2" harness_evidence
  harness_evidence="$(docker exec "${container}" cat /tmp/tiangong-pi-harness.last-run)"
  grep -Fqx 'harness=tiangong-pi' <<<"${harness_evidence}" || \
    die "Tiangong pi harness was not selected for ${member}."
  grep -Fqx 'provider=agentteams-gateway' <<<"${harness_evidence}" || \
    die "Unexpected harness provider for ${member}."
  grep -Fqx "model=${MODEL}" <<<"${harness_evidence}" || \
    die "Unexpected harness model for ${member}."
  grep -Fqx 'status=pass' <<<"${harness_evidence}" || \
    die "Pi harness did not pass for ${member}."
}

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT INT TERM
  set +e

  docker exec "${MANAGER_CONTAINER}" rm -f \
    "${MANAGER_MANIFEST}" "${MANAGER_MATRIX_ROUNDTRIP}" >/dev/null 2>&1
  if container_exists "${LEADER_CONTAINER}"; then
    docker exec "${LEADER_CONTAINER}" rm -f \
      "${LEADER_MATRIX_ROUNDTRIP}" "${LEADER_MATRIX_ROOM_MEMBERS}" >/dev/null 2>&1
  fi

  if ((created == 1)); then
    log "Deleting temporary Team ${TEAM_NAME}"
    docker exec "${MANAGER_CONTAINER}" hiclaw delete team "${TEAM_NAME}" >/dev/null 2>&1 || cleanup_failed=1
    for _ in $(seq 1 120); do
      if ! team_json >/dev/null 2>&1 && \
          ! container_exists "${LEADER_CONTAINER}" && \
          ! container_exists "${WORKER_CONTAINER}"; then
        break
      fi
      sleep 1
    done
    if team_json >/dev/null 2>&1 || \
        container_exists "${LEADER_CONTAINER}" || \
        container_exists "${WORKER_CONTAINER}"; then
      printf '[Tiangong] ERROR: temporary Team cleanup did not finish.\n' >&2
      cleanup_failed=1
    else
      docker exec "${CONTROLLER_CONTAINER}" \
        "${CONTROLLER_MATRIX_ALIAS_CLEANUP}" || cleanup_failed=1
      purge_reserved_storage
      reserved_storage_absent || cleanup_failed=1
    fi
  fi
  docker exec "${CONTROLLER_CONTAINER}" rm -f \
    "${CONTROLLER_MATRIX_ALIAS_CLEANUP}" >/dev/null 2>&1 || cleanup_failed=1

  ((cleanup_failed == 0)) || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in docker jq grep awk; do
  command -v "${command}" >/dev/null 2>&1 || die "Missing required command: ${command}"
done
[[ -f "${MANIFEST}" ]] || die "Missing Team manifest: ${MANIFEST}"
[[ -x "${MATRIX_ROUNDTRIP}" ]] || die "Missing Matrix round-trip helper: ${MATRIX_ROUNDTRIP}"
[[ -x "${MATRIX_ROOM_MEMBERS}" ]] || die "Missing Matrix topology helper: ${MATRIX_ROOM_MEMBERS}"
[[ -x "${MATRIX_ALIAS_CLEANUP}" ]] || die "Missing Matrix alias cleanup helper: ${MATRIX_ALIAS_CLEANUP}"
docker info >/dev/null 2>&1 || die "The Docker daemon is unavailable."
for container in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}"; do
  docker inspect "${container}" >/dev/null 2>&1 || die "${container} does not exist."
  [[ "$(docker inspect "${container}" --format '{{.State.Running}}')" == "true" ]] || \
    die "${container} is not running."
done

if team_json >/dev/null 2>&1 || \
    member_json "${LEADER_NAME}" >/dev/null 2>&1 || \
    member_json "${WORKER_NAME}" >/dev/null 2>&1 || \
    container_exists "${LEADER_CONTAINER}" || \
    container_exists "${WORKER_CONTAINER}"; then
  die "Reserved Team smoke resources already exist; refusing to replace them."
fi
docker cp "${MATRIX_ALIAS_CLEANUP}" \
  "${CONTROLLER_CONTAINER}:${CONTROLLER_MATRIX_ALIAS_CLEANUP}"
docker exec "${CONTROLLER_CONTAINER}" "${CONTROLLER_MATRIX_ALIAS_CLEANUP}" >/dev/null
purge_reserved_storage
reserved_storage_absent || die "Reserved Team smoke storage could not be cleared safely."

"${BUILD_WORKER_IMAGE}"
docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
docker cp "${MATRIX_ROUNDTRIP}" "${MANAGER_CONTAINER}:${MANAGER_MATRIX_ROUNDTRIP}"
log "Creating temporary AgentTeams Team ${TEAM_NAME}"
if ! docker exec "${MANAGER_CONTAINER}" hiclaw apply -f "${MANAGER_MANIFEST}"; then
  team_json >/dev/null 2>&1 && created=1
  die "Team apply failed."
fi
created=1

phase=""
for _ in $(seq 1 120); do
  resource="$(team_json || true)"
  phase="$(jq -r '.phase // empty' <<<"${resource}" 2>/dev/null || true)"
  case "${phase}" in
    Active|Failed) break ;;
  esac
  sleep 3
done
if [[ "${phase}" != "Active" ]]; then
  team_json | jq '{name,phase,leaderReady,readyWorkers,totalWorkers,message}' >&2 || true
  die "Team reached a terminal failure or did not reach Active phase within 360 seconds."
fi
team_resource="$(team_json)"
[[ "$(jq -r '.leaderReady' <<<"${team_resource}")" == "true" ]] || \
  die "Team Leader is not ready."
[[ "$(jq -r '.readyWorkers' <<<"${team_resource}")" == "1" ]] || \
  die "Expected one ready Team Worker."
[[ "$(jq -r '.totalWorkers' <<<"${team_resource}")" == "1" ]] || \
  die "Expected exactly one Team Worker."
team_room_id="$(jq -r '.teamRoomID // empty' <<<"${team_resource}")"
leader_dm_room_id="$(jq -r '.leaderDMRoomID // empty' <<<"${team_resource}")"
[[ -n "${team_room_id}" && -n "${leader_dm_room_id}" ]] || \
  die "Team room topology is incomplete."

assert_member_runtime "${LEADER_NAME}" team_leader "${LEADER_CONTAINER}"
assert_member_runtime "${WORKER_NAME}" worker "${WORKER_CONTAINER}"

leader_resource="$(member_json "${LEADER_NAME}")"
worker_resource="$(member_json "${WORKER_NAME}")"
leader_user_id="$(jq -r '.matrixUserID // empty' <<<"${leader_resource}")"
worker_user_id="$(jq -r '.matrixUserID // empty' <<<"${worker_resource}")"
leader_room_id="$(jq -r '.roomID // empty' <<<"${leader_resource}")"
worker_room_id="$(jq -r '.roomID // empty' <<<"${worker_resource}")"
manager_user_id="$(docker exec "${MANAGER_CONTAINER}" jq -r \
  '.channels.matrix.userId // empty' /root/manager-workspace/openclaw.json)"
[[ -n "${leader_user_id}" && -n "${worker_user_id}" && \
   -n "${leader_room_id}" && -n "${worker_room_id}" && -n "${manager_user_id}" ]] || \
  die "Team member Matrix identity is incomplete."

wait_for_member_channel "${LEADER_CONTAINER}" "${LEADER_NAME}" 0 \
  "${leader_room_id}" "${team_room_id}" "${worker_room_id}" || \
  die "Team Leader Matrix channel did not become ready in all owned rooms."
wait_for_member_channel "${WORKER_CONTAINER}" "${WORKER_NAME}" 0 \
  "${worker_room_id}" "${team_room_id}" || \
  die "Team Worker Matrix channel did not become ready."

docker cp "${MATRIX_ROUNDTRIP}" "${LEADER_CONTAINER}:${LEADER_MATRIX_ROUNDTRIP}"
docker cp "${MATRIX_ROOM_MEMBERS}" "${LEADER_CONTAINER}:${LEADER_MATRIX_ROOM_MEMBERS}"
leader_config="/root/hiclaw-fs/agents/${LEADER_NAME}/openclaw.json"
docker exec "${LEADER_CONTAINER}" "${LEADER_MATRIX_ROOM_MEMBERS}" \
  "${leader_config}" "${team_room_id}" team \
  "${leader_user_id},${worker_user_id}" "${manager_user_id}"
docker exec "${LEADER_CONTAINER}" "${LEADER_MATRIX_ROOM_MEMBERS}" \
  "${leader_config}" "${leader_room_id}" leader_room \
  "${manager_user_id},${leader_user_id}" "${worker_user_id}"
docker exec "${LEADER_CONTAINER}" "${LEADER_MATRIX_ROOM_MEMBERS}" \
  "${leader_config}" "${worker_room_id}" worker_room \
  "${leader_user_id},${worker_user_id}" "${manager_user_id}"

leader_nonce="$(cat /proc/sys/kernel/random/uuid)"
leader_target="team-leader-read-probe-${leader_nonce}.txt"
printf '%s' "${leader_nonce}" | docker exec -i "${LEADER_CONTAINER}" \
  sh -c 'umask 077; cat >"$1/$2"' _ \
  "/root/hiclaw-fs/agents/${LEADER_NAME}" "${leader_target}"
log "Testing Manager -> Tiangong Team Leader through Matrix"
leader_output="$(docker exec "${MANAGER_CONTAINER}" \
  "${MANAGER_MATRIX_ROUNDTRIP}" "${leader_room_id}" "${leader_user_id}" \
  "${leader_nonce}" "${leader_target}")"
printf '%s\n' "${leader_output}"
grep -Fqx 'matrix_to_pi_response=pass' <<<"${leader_output}" || \
  die "Manager-to-Leader Matrix round trip failed."
leader_terminal_hash="$(assert_read_evidence \
  "${LEADER_CONTAINER}" "${LEADER_NAME}" "${leader_target}")"
[[ "${leader_terminal_hash}" =~ ^[0-9a-f]{64}$ ]] || die "Leader Evidence terminal hash is invalid."
assert_harness "${LEADER_CONTAINER}" "${LEADER_NAME}"
printf 'team_leader_matrix_to_pi=pass\n'

worker_nonce="$(cat /proc/sys/kernel/random/uuid)"
worker_target="team-worker-read-probe-${worker_nonce}.txt"
printf '%s' "${worker_nonce}" | docker exec -i "${WORKER_CONTAINER}" \
  sh -c 'umask 077; cat >"$1/$2"' _ \
  "/root/hiclaw-fs/agents/${WORKER_NAME}" "${worker_target}"
log "Testing Team Leader -> Tiangong Team Worker through Matrix"
worker_output="$(docker exec "${LEADER_CONTAINER}" \
  "${LEADER_MATRIX_ROUNDTRIP}" "${worker_room_id}" "${worker_user_id}" \
  "${worker_nonce}" "${worker_target}")"
printf '%s\n' "${worker_output}"
grep -Fqx 'matrix_to_pi_response=pass' <<<"${worker_output}" || \
  die "Leader-to-Worker Matrix round trip failed."
worker_terminal_hash="$(assert_read_evidence \
  "${WORKER_CONTAINER}" "${WORKER_NAME}" "${worker_target}")"
[[ "${worker_terminal_hash}" =~ ^[0-9a-f]{64}$ ]] || die "Worker Evidence terminal hash is invalid."
assert_harness "${WORKER_CONTAINER}" "${WORKER_NAME}"
printf 'team_worker_matrix_to_pi=pass\n'

log "Restarting Team Leader and verifying role, rooms, and persistent Evidence"
leader_restart_started="$(date +%s)"
docker restart "${LEADER_CONTAINER}" >/dev/null
wait_for_member_channel "${LEADER_CONTAINER}" "${LEADER_NAME}" "${leader_restart_started}" \
  "${leader_room_id}" "${team_room_id}" "${worker_room_id}" || \
  die "Team Leader did not become ready after restart."
[[ "$(docker exec "${LEADER_CONTAINER}" printenv AGENTTEAMS_WORKER_ROLE)" == "team_leader" ]] || \
  die "Team Leader role fact changed after restart."
leader_hash_after="$(assert_read_evidence \
  "${LEADER_CONTAINER}" "${LEADER_NAME}" "${leader_target}")"
[[ "${leader_hash_after}" == "${leader_terminal_hash}" ]] || \
  die "Team Leader Evidence changed across an idle restart."
printf 'team_leader_restart_persistence=pass\n'

log "Restarting Team Worker and verifying role, rooms, and persistent Evidence"
worker_restart_started="$(date +%s)"
docker restart "${WORKER_CONTAINER}" >/dev/null
wait_for_member_channel "${WORKER_CONTAINER}" "${WORKER_NAME}" "${worker_restart_started}" \
  "${worker_room_id}" "${team_room_id}" || \
  die "Team Worker did not become ready after restart."
[[ "$(docker exec "${WORKER_CONTAINER}" printenv AGENTTEAMS_WORKER_ROLE)" == "worker" ]] || \
  die "Team Worker role fact changed after restart."
worker_hash_after="$(assert_read_evidence \
  "${WORKER_CONTAINER}" "${WORKER_NAME}" "${worker_target}")"
[[ "${worker_hash_after}" == "${worker_terminal_hash}" ]] || \
  die "Team Worker Evidence changed across an idle restart."
printf 'team_worker_restart_persistence=pass\n'

log "Tiangong Team Leader runtime boundary smoke passed."
