#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly MANAGER_CONTAINER="agentteams-manager"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly WORKER_NAME="tiangong-openclaw-canary"
readonly CONTAINER_NAME="agentteams-worker-${WORKER_NAME}"
readonly IMAGE="tiangong-worker-canary:dev"
readonly FIXTURE="${REPO_ROOT}/smoke-testing/fixtures/openclaw-gate-a-canary-worker.yaml"
readonly MANAGER_FIXTURE="/tmp/tiangong-openclaw-gate-a-canary-worker.yaml"
readonly STORAGE_PREFIX="agentteams/agentteams-storage/agents/${WORKER_NAME}/"
readonly MIRROR_PATH="/root/agentteams-fs/agents/${WORKER_NAME}"
readonly STATE_ROOT="${REPO_ROOT}/.runtime/agentteams/openclaw-gate-a"
readonly STATE_FILE="${STATE_ROOT}/state.env"
readonly BUILD_CONTEXT="${REPO_ROOT}/team-playbooks"
created=0

log() {
  printf '[Tiangong] %s\n' "$*"
}

die() {
  printf '[Tiangong] ERROR: %s\n' "$*" >&2
  exit 1
}

require_real_run() {
  [[ "${TIANGONG_RUN_REAL:-0}" == 1 ]] || \
    die 'real Gate A canary is disabled; set TIANGONG_RUN_REAL=1 explicitly.'
}

require_commands() {
  local command
  for command in docker jq grep; do
    command -v "${command}" >/dev/null 2>&1 || die "Missing required command: ${command}."
  done
  docker info >/dev/null 2>&1 || die 'The Docker daemon is unavailable.'
  docker inspect "${MANAGER_CONTAINER}" >/dev/null 2>&1 || die "${MANAGER_CONTAINER} does not exist."
  docker inspect "${CONTROLLER_CONTAINER}" >/dev/null 2>&1 || die "${CONTROLLER_CONTAINER} does not exist."
  [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}')" == true ]] || \
    die "${MANAGER_CONTAINER} is not running."
  [[ "$(docker inspect "${CONTROLLER_CONTAINER}" --format '{{.State.Running}}')" == true ]] || \
    die "${CONTROLLER_CONTAINER} is not running."
  [[ -f "${FIXTURE}" && ! -L "${FIXTURE}" ]] || die "Missing or symlinked canary fixture: ${FIXTURE}."
}

worker_json() {
  docker exec "${MANAGER_CONTAINER}" agt get workers "${WORKER_NAME}" -o json 2>/dev/null
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"
}

assert_unowned() {
  worker_json >/dev/null 2>&1 && die "Worker ${WORKER_NAME} already exists; refusing to replace it."
  container_exists && die "Container ${CONTAINER_NAME} already exists; refusing to replace it."
  docker exec "${CONTROLLER_CONTAINER}" mc ls "${STORAGE_PREFIX}" 2>/dev/null | grep -q . && \
    die "Storage prefix ${STORAGE_PREFIX} already exists; refusing to replace it."
  docker exec "${CONTROLLER_CONTAINER}" test ! -e "${MIRROR_PATH}" || \
    die "Worker mirror ${MIRROR_PATH} already exists; refusing to replace it."
}

prepare_state() {
  [[ ! -L "${REPO_ROOT}/.runtime" && ! -L "${REPO_ROOT}/.runtime/agentteams" ]] || \
    die 'Refusing symlinked runtime state path.'
  mkdir -p "${STATE_ROOT}"
  chmod 700 "${STATE_ROOT}"
  [[ ! -e "${STATE_FILE}" || ! -L "${STATE_FILE}" ]] || die 'Refusing symlinked canary state file.'
}

build_canary_image() {
  [[ "${TIANGONG_BUILD_CANARY:-0}" == 1 ]] || return 0
  log "Building isolated canary image ${IMAGE}"
  docker build --pull --build-context "team_playbooks=${BUILD_CONTEXT}" \
    --target canary --tag "${IMAGE}" "${REPO_ROOT}/worker"
}

write_state() {
  local container_id image_id
  container_id="$(docker inspect "${CONTAINER_NAME}" --format '{{.Id}}' 2>/dev/null || true)"
  image_id="$(docker inspect "${CONTAINER_NAME}" --format '{{.Image}}' 2>/dev/null || true)"
  {
    printf 'worker_name=%q\n' "${WORKER_NAME}"
    printf 'container_name=%q\n' "${CONTAINER_NAME}"
    printf 'container_id=%q\n' "${container_id}"
    printf 'image=%q\n' "${IMAGE}"
    printf 'image_id=%q\n' "${image_id}"
    printf 'storage_prefix=%q\n' "${STORAGE_PREFIX}"
    printf 'mirror_path=%q\n' "${MIRROR_PATH}"
  } >"${STATE_FILE}"
  chmod 600 "${STATE_FILE}"
}

wait_for_container() {
  for _ in $(seq 1 90); do
    if container_exists; then return 0; fi
    sleep 2
  done
  return 1
}

load_state() {
  [[ -f "${STATE_FILE}" && ! -L "${STATE_FILE}" ]] || die 'Gate A canary state is absent.'
  unset worker_name container_name container_id image image_id storage_prefix mirror_path
  # The state file is produced by this script using shell-escaped values only.
  # shellcheck disable=SC1090
  source "${STATE_FILE}"
  [[ "${worker_name:-}" == "${WORKER_NAME}" &&
     "${container_name:-}" == "${CONTAINER_NAME}" &&
     "${storage_prefix:-}" == "${STORAGE_PREFIX}" &&
     "${mirror_path:-}" == "${MIRROR_PATH}" ]] || die 'Canary state ownership does not match fixed Gate A scope.'
}

purge_owned_storage() {
  docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force "${STORAGE_PREFIX}" >/dev/null 2>&1 || true
  docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "${MIRROR_PATH}" >/dev/null 2>&1 || true
  docker exec "${MANAGER_CONTAINER}" rm -rf -- "${MIRROR_PATH}" >/dev/null 2>&1 || true
  ! docker exec "${CONTROLLER_CONTAINER}" mc ls "${STORAGE_PREFIX}" 2>/dev/null | grep -q . &&
    docker exec "${CONTROLLER_CONTAINER}" test ! -e "${MIRROR_PATH}" &&
    docker exec "${MANAGER_CONTAINER}" test ! -e "${MIRROR_PATH}"
}

wait_for_absence() {
  for _ in $(seq 1 60); do
    if ! worker_json >/dev/null 2>&1 && ! container_exists; then return 0; fi
    sleep 1
  done
  return 1
}

wait_for_ready() {
  local logs phase=''
  for _ in $(seq 1 90); do
    logs="$(docker logs "${CONTAINER_NAME}" 2>&1 || true)"
    phase="$(worker_json | jq -r '.phase // empty' 2>/dev/null || true)"
    if [[ "${phase}" == Running ]] &&
       [[ "$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}' 2>/dev/null)" == true ]] &&
       docker exec "${CONTAINER_NAME}" openclaw health >/dev/null 2>&1 &&
       grep -Fq "tiangong_preflight=pass plugin=tiangong-pi lane=openclaw-canary" <<<"${logs}" &&
       grep -Fq "codex_gateway_preflight=pass provider=agentteams-gateway model=deepseek-v4-pro gateway_model_probe=pass credential_source=agentteams-consumer-token" <<<"${logs}" &&
       grep -Fq "worker/${WORKER_NAME} reported ready" <<<"${logs}"; then
      return 0
    fi
    if [[ "${phase}" == Failed ]]; then
      printf '%s\n' "${logs}" >&2
      return 1
    fi
    sleep 2
  done
  printf '%s\n' "${logs}" >&2
  return 1
}

wait_for_ready_since() {
  local since="$1" logs phase=''
  for _ in $(seq 1 90); do
    logs="$(docker logs --since "${since}" "${CONTAINER_NAME}" 2>&1 || true)"
    phase="$(worker_json | jq -r '.phase // empty' 2>/dev/null || true)"
    if [[ "${phase}" == Running ]] &&
       [[ "$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}' 2>/dev/null)" == true ]] &&
       docker exec "${CONTAINER_NAME}" openclaw health >/dev/null 2>&1 &&
       grep -Fq "tiangong_preflight=pass plugin=tiangong-pi lane=openclaw-canary" <<<"${logs}" &&
       grep -Fq "codex_gateway_preflight=pass provider=agentteams-gateway model=deepseek-v4-pro gateway_model_probe=pass credential_source=agentteams-consumer-token" <<<"${logs}" &&
       grep -Fq "worker/${WORKER_NAME} reported ready" <<<"${logs}"; then
      return 0
    fi
    if [[ "${phase}" == Failed ]]; then
      printf '%s\n' "${logs}" >&2
      return 1
    fi
    sleep 2
  done
  printf '%s\n' "${logs}" >&2
  return 1
}

start_canary() {
  require_real_run
  require_commands
  prepare_state
  [[ ! -e "${STATE_FILE}" ]] || die 'A Gate A canary is already recorded; run stop first.'
  assert_unowned
  build_canary_image
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || \
    die "Missing ${IMAGE}; set TIANGONG_BUILD_CANARY=1 to build it explicitly."
  docker exec -i "${MANAGER_CONTAINER}" sh -c 'umask 077; cat >"$1"' _ "${MANAGER_FIXTURE}" <"${FIXTURE}"
  created=1
  write_state
  timeout 45 docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_FIXTURE}" >/dev/null || \
    die 'AgentTeams refused or timed out applying the canary Worker manifest.'
  wait_for_container || die 'AgentTeams did not create the canary container within 180 seconds.'
  write_state
  log "Created isolated Worker ${WORKER_NAME} with image ${IMAGE}."
}

status_canary() {
  require_commands
  load_state
  local resource phase running lane fallback
  resource="$(worker_json)"
  phase="$(jq -r '.phase // empty' <<<"${resource}")"
  running="$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}' 2>/dev/null || true)"
  lane="$(docker exec "${CONTAINER_NAME}" printenv TIANGONG_RUNTIME_LANE 2>/dev/null || true)"
  fallback="$(docker exec "${CONTAINER_NAME}" printenv OPENCLAW_AGENT_HARNESS_FALLBACK 2>/dev/null || true)"
  printf 'gate_a_phase=%s\nworker_running=%s\nruntime_lane=%s\nharness_fallback=%s\n' \
    "${phase}" "${running}" "${lane}" "${fallback}"
  [[ "${phase}" == Running && "${running}" == true && "${lane}" == openclaw-canary && "${fallback}" == none ]] || \
    die 'Gate A canary is not in the required isolated ready state.'
}

restart_canary() {
  require_real_run
  require_commands
  load_state
  local before_id before_started after_id after_started
  before_id="$(docker inspect "${CONTAINER_NAME}" --format '{{.Id}}')"
  before_started="$(docker inspect "${CONTAINER_NAME}" --format '{{.State.StartedAt}}')"
  docker restart "${CONTAINER_NAME}" >/dev/null || die 'Canary container restart failed.'
  for _ in $(seq 1 30); do
    after_started="$(docker inspect "${CONTAINER_NAME}" --format '{{.State.StartedAt}}' 2>/dev/null || true)"
    [[ -n "${after_started}" && "${after_started}" != "${before_started}" ]] && break
    sleep 1
  done
  after_id="$(docker inspect "${CONTAINER_NAME}" --format '{{.Id}}' 2>/dev/null || true)"
  [[ "${after_id}" == "${before_id}" ]] || die 'Canary restart replaced the container identity.'
  wait_for_ready_since "${before_started}" || die 'Canary did not re-establish readiness after restart.'
  status_canary
  printf 'gate_a_restart=pass\n'
}

stop_canary() {
  require_real_run
  require_commands
  if [[ -f "${STATE_FILE}" && ! -L "${STATE_FILE}" ]]; then
    load_state
  elif ((created != 1)); then
    die 'Gate A canary state is absent.'
  fi
  local cleanup_failed=0
  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_FIXTURE}" >/dev/null 2>&1 || cleanup_failed=1
  if worker_json >/dev/null 2>&1; then
    docker exec "${MANAGER_CONTAINER}" agt delete worker "${WORKER_NAME}" >/dev/null 2>&1 || cleanup_failed=1
  fi
  wait_for_absence || cleanup_failed=1
  purge_owned_storage || cleanup_failed=1
  if ((cleanup_failed == 0)); then
    rm -f -- "${STATE_FILE}"
    rmdir "${STATE_ROOT}" 2>/dev/null || true
    printf 'gate_a_cleanup=pass\n'
  else
    printf 'gate_a_cleanup=fail\n' >&2
    return 1
  fi
}

run_canary() {
  local status=0
  trap 'status=$?; set +e; if ((created == 1)); then stop_canary; fi; exit "${status}"' EXIT
  start_canary
  wait_for_ready || die 'Gate A canary did not reach preflight and channel readiness.'
  status_canary
  printf 'gate_a_preflight=pass\n'
  printf 'gate_a_readiness=pass\n'
  trap - EXIT
  stop_canary
}

start_command() {
  local status=0
  trap 'status=$?; set +e; if ((created == 1)); then stop_canary; fi; exit "${status}"' EXIT
  start_canary
  trap - EXIT
}

case "${1:-run}" in
  start) start_command ;;
  status) status_canary ;;
  restart) restart_canary ;;
  stop) stop_canary ;;
  run) run_canary ;;
  *) die "Usage: $0 {run|start|status|stop}" ;;
esac
