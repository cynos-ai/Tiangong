#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="${TIANGONG_AGENTLOOP_QUERY_ADAPTER_IMAGE:-tiangong-agentloop-query-adapter:dev}"
readonly CONTAINER="${TIANGONG_AGENTLOOP_QUERY_ADAPTER_CONTAINER:-tiangong-agentloop-query-adapter}"
readonly NETWORK="${TIANGONG_AGENTLOOP_QUERY_NETWORK:-tiangong-agentloop-diagnostics}"
readonly COORDINATION_CONTAINER="${TIANGONG_COORDINATION_CONTAINER:-tiangong-coordination-runtime}"
readonly OWNER="tiangong-deployment"
readonly COMPONENT="agentloop-query-adapter"
readonly NETWORK_COMPONENT="agentloop-diagnostics-network"
readonly SECRET_FILE="${TIANGONG_AGENTLOOP_QUERY_SECRET_FILE:-}"
readonly ENDPOINT="${TIANGONG_AGENTLOOP_QUERY_ENDPOINT:-}"
readonly PROJECT="${TIANGONG_AGENTLOOP_QUERY_PROJECT:-}"
readonly SERVICES="${TIANGONG_AGENTLOOP_QUERY_SERVICES:-}"
readonly ENVIRONMENT="${TIANGONG_AGENTLOOP_QUERY_ENVIRONMENT:-}"
readonly MAX_RESULTS="${TIANGONG_AGENTLOOP_QUERY_MAX_RESULTS:-80}"
readonly TIMEOUT_SECONDS="${TIANGONG_AGENTLOOP_QUERY_TIMEOUT_SECONDS:-5}"
readonly MAX_CONCURRENCY="${TIANGONG_AGENTLOOP_QUERY_MAX_CONCURRENCY:-2}"

fail() { printf 'agentloop_query_adapter_deployment=fail code=%s\n' "$1" >&2; exit 1; }
owned_container() {
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.owner"}}' "${CONTAINER}" 2>/dev/null || true)" == "${OWNER}" ]] || return 1
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.component"}}' "${CONTAINER}" 2>/dev/null || true)" == "${COMPONENT}" ]]
}
owned_network() {
  [[ "$(docker network inspect --format '{{index .Labels "io.tiangong.owner"}}' "${NETWORK}" 2>/dev/null || true)" == "${OWNER}" ]] || return 1
  [[ "$(docker network inspect --format '{{index .Labels "io.tiangong.component"}}' "${NETWORK}" 2>/dev/null || true)" == "${NETWORK_COMPONENT}" ]]
}
owned_coordination() {
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.owner"}}' "${COORDINATION_CONTAINER}" 2>/dev/null || true)" == "${OWNER}" ]] || return 1
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.component"}}' "${COORDINATION_CONTAINER}" 2>/dev/null || true)" == "coordination-runtime" ]]
}
docker_host_path() {
  local path="$1" docker_binary docker_binary_real
  docker_binary="$(command -v docker 2>/dev/null || true)"
  docker_binary_real="$(readlink -f "${docker_binary}" 2>/dev/null || printf '%s' "${docker_binary}")"
  if command -v cygpath >/dev/null 2>&1 && [[ "${OSTYPE:-}" =~ ^(msys|cygwin) && "${path}" == /* ]]; then
    cygpath -w "${path}"
  elif [[ "${docker_binary_real}" == *.exe ]] && command -v wslpath >/dev/null 2>&1 && [[ "${path}" == /* ]]; then
    wslpath -w "${path}"
  else
    printf '%s\n' "${path}"
  fi
}
config_hash() {
  printf '%s\0' "${ENDPOINT}" "${PROJECT}" "${SERVICES}" "${ENVIRONMENT}" "${MAX_RESULTS}" "${TIMEOUT_SECONDS}" "${MAX_CONCURRENCY}" | sha256sum | cut -d' ' -f1
}
require_tools() {
  command -v docker >/dev/null 2>&1 || fail DOCKER_REQUIRED
  command -v python3 >/dev/null 2>&1 || fail PYTHON3_REQUIRED
  command -v sha256sum >/dev/null 2>&1 || fail SHA256SUM_REQUIRED
  docker info >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE
}
validate_inputs() {
  [[ -n "${SECRET_FILE}" ]] || fail QUERY_SECRET_FILE_REQUIRED
  TIANGONG_AGENTLOOP_QUERY_SECRET_FILE="${SECRET_FILE}" \
  TIANGONG_AGENTLOOP_QUERY_ENDPOINT="${ENDPOINT}" \
  TIANGONG_AGENTLOOP_QUERY_PROJECT="${PROJECT}" \
  TIANGONG_AGENTLOOP_QUERY_SERVICES="${SERVICES}" \
  TIANGONG_AGENTLOOP_QUERY_ENVIRONMENT="${ENVIRONMENT}" \
  TIANGONG_AGENTLOOP_QUERY_MAX_RESULTS="${MAX_RESULTS}" \
  TIANGONG_AGENTLOOP_QUERY_TIMEOUT_SECONDS="${TIMEOUT_SECONDS}" \
  TIANGONG_AGENTLOOP_QUERY_MAX_CONCURRENCY="${MAX_CONCURRENCY}" \
  PYTHONPATH="${REPO_ROOT}" python3 - <<'PY' >/dev/null 2>&1 || fail QUERY_CONFIGURATION_INVALID
from agentloop_query_adapter.server import load_config
load_config()
PY
}
ensure_network() {
  if docker network inspect "${NETWORK}" >/dev/null 2>&1; then
    owned_network || fail FOREIGN_NETWORK
  else
    docker network create \
      --label "io.tiangong.owner=${OWNER}" \
      --label "io.tiangong.component=${NETWORK_COMPONENT}" \
      --label 'io.tiangong.schema=1' \
      "${NETWORK}" >/dev/null
  fi
}
start() {
  require_tools
  validate_inputs
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail IMAGE_NOT_FOUND
  ensure_network
  local expected_hash image_id mounted_source
  expected_hash="$(config_hash)"
  image_id="$(docker image inspect --format '{{.Id}}' "${IMAGE}")"
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.query-config"}}' "${CONTAINER}")" == "${expected_hash}" ]] || fail CONFIG_MISMATCH
    [[ "$(docker container inspect --format '{{.Image}}' "${CONTAINER}")" == "${image_id}" ]] || fail IMAGE_MISMATCH
    mounted_source="$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/run/secrets/aliyun-readonly.env"}}{{.Source}}{{end}}{{end}}' "${CONTAINER}")"
    [[ "$(readlink -f "${mounted_source}" 2>/dev/null || true)" == "$(readlink -f "${SECRET_FILE}" 2>/dev/null || true)" ]] || fail SECRET_MOUNT_MISMATCH
    docker container inspect --format '{{.State.Running}}' "${CONTAINER}" | grep -Fxq true || docker container start "${CONTAINER}" >/dev/null
  else
    docker run -d --name "${CONTAINER}" \
      --label "io.tiangong.owner=${OWNER}" \
      --label "io.tiangong.component=${COMPONENT}" \
      --label 'io.tiangong.schema=1' \
      --label "io.tiangong.query-config=${expected_hash}" \
      --network "${NETWORK}" \
      --network-alias agentloop-query-adapter \
      --user "$(id -u):$(id -g)" \
      --env 'TIANGONG_AGENTLOOP_QUERY_SECRET_FILE=/run/secrets/aliyun-readonly.env' \
      --env "TIANGONG_AGENTLOOP_QUERY_ENDPOINT=${ENDPOINT}" \
      --env "TIANGONG_AGENTLOOP_QUERY_PROJECT=${PROJECT}" \
      --env "TIANGONG_AGENTLOOP_QUERY_SERVICES=${SERVICES}" \
      --env "TIANGONG_AGENTLOOP_QUERY_ENVIRONMENT=${ENVIRONMENT}" \
      --env "TIANGONG_AGENTLOOP_QUERY_MAX_RESULTS=${MAX_RESULTS}" \
      --env "TIANGONG_AGENTLOOP_QUERY_TIMEOUT_SECONDS=${TIMEOUT_SECONDS}" \
      --env "TIANGONG_AGENTLOOP_QUERY_MAX_CONCURRENCY=${MAX_CONCURRENCY}" \
      --mount "type=bind,src=$(docker_host_path "${SECRET_FILE}"),dst=/run/secrets/aliyun-readonly.env,readonly" \
      --read-only \
      --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=16m' \
      --cap-drop=ALL \
      --security-opt no-new-privileges \
      --pids-limit 64 \
      --memory 192m \
      --cpus 0.5 \
      "${IMAGE}" >/dev/null
  fi
  for _ in $(seq 1 60); do
    if docker exec "${CONTAINER}" python -c 'import json,urllib.request; r=urllib.request.urlopen("http://127.0.0.1:8791/readyz", timeout=1); assert r.status == 200 and json.load(r)["ready"] is True' >/dev/null 2>&1; then
      printf 'agentloop_query_adapter_deployment=ready container=%s image=%s network=%s\n' "${CONTAINER}" "${IMAGE}" "${NETWORK}"
      return 0
    fi
    sleep 1
  done
  fail NOT_READY
}
stop() {
  require_tools
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    docker container rm -f "${CONTAINER}" >/dev/null
  fi
  if docker network inspect "${NETWORK}" >/dev/null 2>&1; then
    owned_network || fail FOREIGN_NETWORK
    if docker container inspect "${COORDINATION_CONTAINER}" >/dev/null 2>&1; then
      owned_coordination || fail FOREIGN_COORDINATION_CONTAINER
      docker network disconnect "${NETWORK}" "${COORDINATION_CONTAINER}" >/dev/null 2>&1 || true
    fi
    [[ "$(docker network inspect --format '{{len .Containers}}' "${NETWORK}")" == 0 ]] || fail NETWORK_IN_USE
    docker network rm "${NETWORK}" >/dev/null
  fi
  printf 'agentloop_query_adapter_deployment=stopped container=%s network=%s\n' "${CONTAINER}" "${NETWORK}"
}
status() {
  require_tools
  local running=false network_present=false
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    running="$(docker container inspect --format '{{.State.Running}}' "${CONTAINER}")"
  fi
  if docker network inspect "${NETWORK}" >/dev/null 2>&1; then
    owned_network || fail FOREIGN_NETWORK
    network_present=true
  fi
  printf 'agentloop_query_adapter_deployment=status running=%s network_present=%s container=%s image=%s network=%s\n' "${running}" "${network_present}" "${CONTAINER}" "${IMAGE}" "${NETWORK}"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) fail UNKNOWN_COMMAND ;;
esac
