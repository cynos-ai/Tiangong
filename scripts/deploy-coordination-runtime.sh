#!/usr/bin/env bash
set -Eeuo pipefail

readonly NETWORK="${TIANGONG_AGENTTEAMS_NETWORK:-agentteams-net}"
readonly IMAGE="${TIANGONG_COORDINATION_IMAGE:-tiangong-coordination-runtime:dev}"
readonly CONTAINER="${TIANGONG_COORDINATION_CONTAINER:-tiangong-coordination-runtime}"
readonly OWNER="tiangong-deployment"
readonly COMPONENT="coordination-runtime"
readonly BINDING_TARGET="/run/tiangong-coordination/leader-binding.json"
readonly ENV_FILE="${TIANGONG_COORDINATION_ENV_FILE:-}"
readonly BINDING_FILE="${TIANGONG_LEADER_RUNTIME_BINDING_FILE:-}"
readonly DOCKER_BINDING_VOLUME="${TIANGONG_DOCKER_BINDING_VOLUME:-}"
readonly HOST_PORT="${TIANGONG_COORDINATION_HOST_PORT:-}"

fail() { printf 'coordination_runtime_deployment=fail code=%s\n' "$1" >&2; exit 1; }
owned_container() {
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.owner"}}' "${CONTAINER}" 2>/dev/null || true)" == "${OWNER}" ]] || return 1
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.component"}}' "${CONTAINER}" 2>/dev/null || true)" == "${COMPONENT}" ]]
}
require_network() { docker network inspect "${NETWORK}" >/dev/null 2>&1 || fail NETWORK_NOT_FOUND; }
require_image() { docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail IMAGE_NOT_FOUND; }
docker_host_path() {
  local path="$1"
  if command -v wslpath >/dev/null 2>&1 && [[ "${path}" == /* ]]; then
    wslpath -w "${path}"
  elif command -v cygpath >/dev/null 2>&1 && [[ "${path}" == /* ]]; then
    cygpath -w "${path}"
  else
    printf '%s\n' "${path}"
  fi
}
valid_volume_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]
}
validate_host_port() {
  [[ -z "${HOST_PORT}" || "${HOST_PORT}" =~ ^[0-9]+$ ]] || fail INVALID_HOST_PORT
  [[ -z "${HOST_PORT}" || ( "${HOST_PORT}" -ge 1 && "${HOST_PORT}" -le 65535 ) ]] || fail INVALID_HOST_PORT
}
regular_secret_file() {
  local path="$1" max_bytes="$2" mode
  [[ -n "${path}" && -f "${path}" && ! -L "${path}" ]] || return 1
  [[ "$(wc -c <"${path}")" -le "${max_bytes}" ]] || return 1
  mode="$(stat -c '%a' "${path}" 2>/dev/null || stat -f '%Lp' "${path}")"
  [[ "${mode}" == 600 || "${mode}" == 400 ]]
}
validate_env_keys() {
  local line key
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" == *=* ]] || fail ENV_LINE_INVALID
    key="${line%%=*}"
    case "${key}" in
      TIANGONG_COORDINATION_DATABASE_URL|TIANGONG_COORDINATION_CONTROL_TOKEN|TIANGONG_COORDINATION_MATRIX_TOKEN|AGENTTEAMS_MATRIX_URL|TIANGONG_COORDINATION_CONSUMER_ID|TIANGONG_COORDINATION_OUTBOX_INTERVAL_MS|TIANGONG_LEADER_RUNTIME_BINDING_FILE|TIANGONG_COORDINATION_PORT|NODE_ENV) ;;
      *) fail UNSUPPORTED_ENVIRONMENT_KEY ;;
    esac
  done <"${ENV_FILE}"
}
require_inputs() {
  [[ -n "${ENV_FILE}" ]] || fail ENV_FILE_REQUIRED
  [[ -n "${BINDING_FILE}" ]] || fail BINDING_FILE_REQUIRED
  if [[ -n "${DOCKER_BINDING_VOLUME}" ]]; then
    valid_volume_name "${DOCKER_BINDING_VOLUME}" || fail INVALID_BINDING_VOLUME
    docker volume inspect "${DOCKER_BINDING_VOLUME}" >/dev/null 2>&1 || fail BINDING_VOLUME_NOT_FOUND
  fi
  regular_secret_file "${ENV_FILE}" 16384 || fail INVALID_ENV_FILE
  regular_secret_file "${BINDING_FILE}" 65536 || fail INVALID_BINDING_FILE
  validate_env_keys
  grep -Eq '^TIANGONG_COORDINATION_DATABASE_URL=[^[:space:]]+$' "${ENV_FILE}" || fail DATABASE_URL_MISSING
  grep -Eq '^TIANGONG_COORDINATION_CONTROL_TOKEN=[^[:space:]]{16,512}$' "${ENV_FILE}" || fail CONTROL_TOKEN_MISSING
  if grep -Eq '^(TIANGONG_COORDINATION_MATRIX_TOKEN|AGENTTEAMS_MATRIX_URL)=' "${ENV_FILE}"; then
    grep -Eq '^TIANGONG_COORDINATION_MATRIX_TOKEN=[^[:space:]]{16,512}$' "${ENV_FILE}" || fail MATRIX_TOKEN_INVALID
    grep -Eq '^AGENTTEAMS_MATRIX_URL=https?://[^[:space:]]+$' "${ENV_FILE}" || fail MATRIX_URL_INVALID
  fi
  if grep -Eq '^(TIANGONG_LEADER_RUNTIME_BINDING_FILE|TIANGONG_COORDINATION_PORT|NODE_ENV)=' "${ENV_FILE}"; then
    fail RESERVED_ENVIRONMENT_KEY
  fi
}

start() {
  require_network
  require_image
  require_inputs
  validate_host_port
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    if [[ -n "${HOST_PORT}" ]]; then
      existing_host_port="$(docker container inspect --format '{{(index (index .HostConfig.PortBindings "8780/tcp") 0).HostPort}}' "${CONTAINER}" 2>/dev/null || true)"
      existing_host_ip="$(docker container inspect --format '{{(index (index .HostConfig.PortBindings "8780/tcp") 0).HostIp}}' "${CONTAINER}" 2>/dev/null || true)"
      [[ "${existing_host_port}" == "${HOST_PORT}" && "${existing_host_ip}" == "127.0.0.1" ]] || fail HOST_PORT_MISMATCH
    fi
    docker container inspect --format '{{.State.Running}}' "${CONTAINER}" | grep -Fxq true || docker container start "${CONTAINER}" >/dev/null
  else
    run_args=(docker run -d --name "${CONTAINER}" \
      --label "io.tiangong.owner=${OWNER}" \
      --label "io.tiangong.component=${COMPONENT}" \
      --label 'io.tiangong.schema=1' \
      --network "${NETWORK}" \
      --network-alias "${CONTAINER}" \
      --env-file "$(docker_host_path "${ENV_FILE}")" \
      --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
      --cap-drop=ALL \
      --cap-add=CHOWN \
      --cap-add=DAC_OVERRIDE \
      --cap-add=SETUID \
      --cap-add=SETGID \
      --security-opt no-new-privileges \
    )
    if [[ -n "${DOCKER_BINDING_VOLUME}" ]]; then
      run_args+=(--env "TIANGONG_LEADER_RUNTIME_BINDING_FILE=/run/tiangong-coordination/leader-binding.json" \
        --mount "type=volume,source=${DOCKER_BINDING_VOLUME},destination=/run/tiangong-coordination,readonly")
    else
      run_args+=(--env "TIANGONG_LEADER_RUNTIME_BINDING_FILE=/run/tiangong-coordination/leader-binding.json" \
        --mount "type=bind,src=$(docker_host_path "${BINDING_FILE}"),dst=/run/tiangong-coordination/leader-binding.json,readonly")
    fi
    if [[ -n "${HOST_PORT}" ]]; then
      run_args+=(--publish "127.0.0.1:${HOST_PORT}:8780/tcp")
    fi
    run_args+=("${IMAGE}")
    "${run_args[@]}" >/dev/null
  fi
  for _ in $(seq 1 60); do
    if docker exec "${CONTAINER}" node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8780/readyz"); if (!r.ok) process.exit(1);' >/dev/null 2>&1; then
      printf 'coordination_runtime_deployment=ready container=%s image=%s network=%s\n' "${CONTAINER}" "${IMAGE}" "${NETWORK}"
      return 0
    fi
    sleep 1
  done
  fail NOT_READY
}

stop() {
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    docker container rm -f "${CONTAINER}" >/dev/null
  fi
  printf 'coordination_runtime_deployment=stopped container=%s\n' "${CONTAINER}"
}

status() {
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    printf 'coordination_runtime_deployment=status running=%s container=%s image=%s network=%s\n' \
      "$(docker container inspect --format '{{.State.Running}}' "${CONTAINER}")" "${CONTAINER}" "${IMAGE}" "${NETWORK}"
  else
    printf 'coordination_runtime_deployment=status running=false container=%s image=%s network=%s\n' "${CONTAINER}" "${IMAGE}" "${NETWORK}"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) fail UNKNOWN_COMMAND ;;
esac
