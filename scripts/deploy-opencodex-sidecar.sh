#!/usr/bin/env bash
set -Eeuo pipefail

readonly NETWORK="${TIANGONG_AGENTTEAMS_NETWORK:-agentteams-net}"
readonly IMAGE="${TIANGONG_OPENCODEX_ADAPTER_IMAGE:-tg-opencodex-adapter:dev}"
readonly CONTAINER="${TIANGONG_OPENCODEX_ADAPTER_CONTAINER:-tiangong-opencodex-adapter}"
readonly VOLUME="${TIANGONG_OPENCODEX_STATE_VOLUME:-tiangong-opencodex-state}"
readonly STATE_DIR="/var/lib/tiangong-opencodex"
readonly OWNER="tiangong-deployment"
readonly COMPONENT="opencodex-adapter"
readonly CLI="/opt/tiangong-worker/agent/deployment/opencodex-sidecar-cli.mjs"

fail() { printf 'opencodex_sidecar_deployment=fail code=%s\n' "$1" >&2; exit 1; }
owned_volume() {
  [[ "$(docker volume inspect --format '{{index .Labels "io.tiangong.owner"}}' "${VOLUME}" 2>/dev/null || true)" == "${OWNER}" ]] || return 1
  [[ "$(docker volume inspect --format '{{index .Labels "io.tiangong.component"}}' "${VOLUME}" 2>/dev/null || true)" == "${COMPONENT}" ]]
}
owned_container() {
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.owner"}}' "${CONTAINER}" 2>/dev/null || true)" == "${OWNER}" ]] || return 1
  [[ "$(docker container inspect --format '{{index .Config.Labels "io.tiangong.component"}}' "${CONTAINER}" 2>/dev/null || true)" == "${COMPONENT}" ]]
}
require_network() { docker network inspect "${NETWORK}" >/dev/null 2>&1 || fail NETWORK_NOT_FOUND; }
require_image() { docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail IMAGE_NOT_FOUND; }

start() {
  require_network
  require_image
  if docker volume inspect "${VOLUME}" >/dev/null 2>&1; then owned_volume || fail FOREIGN_VOLUME; else
    docker volume create --label "io.tiangong.owner=${OWNER}" --label "io.tiangong.component=${COMPONENT}" --label 'io.tiangong.schema=1' "${VOLUME}" >/dev/null
  fi
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    docker container inspect --format '{{.State.Running}}' "${CONTAINER}" | grep -Fxq true || docker container start "${CONTAINER}" >/dev/null
  else
    docker run -d --name "${CONTAINER}" --network "${NETWORK}" --network-alias "${CONTAINER}" \
      --label "io.tiangong.owner=${OWNER}" --label "io.tiangong.component=${COMPONENT}" --label 'io.tiangong.schema=1' \
      --mount "type=volume,src=${VOLUME},dst=${STATE_DIR}" \
      --mount 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock' \
      --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --security-opt no-new-privileges \
      "${IMAGE}" >/dev/null
  fi
  for _ in $(seq 1 30); do
    if docker exec "${CONTAINER}" node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8790/healthz"); if (!r.ok) process.exit(1);' >/dev/null 2>&1; then
      printf 'opencodex_sidecar_deployment=ready container=%s volume=%s network=%s\n' "${CONTAINER}" "${VOLUME}" "${NETWORK}"
      return 0
    fi
    sleep 1
  done
  fail NOT_READY
}

stop() {
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then owned_container || fail FOREIGN_CONTAINER; docker container rm -f "${CONTAINER}" >/dev/null; fi
  printf 'opencodex_sidecar_deployment=stopped container=%s volume_retained=%s\n' "${CONTAINER}" "${VOLUME}"
}

remove() {
  if docker ps -aq --filter "label=io.tiangong.owner=${OWNER}" --filter 'label=io.tiangong.component=opencodex-sidecar' | grep -q .; then fail SIDECARS_STILL_EXIST; fi
  stop
  if docker volume inspect "${VOLUME}" >/dev/null 2>&1; then owned_volume || fail FOREIGN_VOLUME; docker volume rm "${VOLUME}" >/dev/null; fi
  docker volume inspect "${VOLUME}" >/dev/null 2>&1 && fail VOLUME_CLEANUP_INCOMPLETE
  printf 'opencodex_sidecar_deployment=removed volume=%s\n' "${VOLUME}"
}

lifecycle() {
  start
  local action="${1:-}"; shift || true
  [[ -n "${action}" ]] || fail ACTION_REQUIRED
  local worker_container="${TIANGONG_OPENCODEX_WORKER_CONTAINER:-}"
  local -a env_args=()
  [[ -n "${worker_container}" ]] && env_args+=(--env "TIANGONG_OPENCODEX_WORKER_CONTAINER=${worker_container}")
  if [[ "${action}" == "provision" ]]; then
    local binding_path=""; if [[ "${1:-}" == "--binding" ]]; then binding_path="${2:-}"; shift 2; fi
    [[ -n "${binding_path}" && -f "${binding_path}" ]] || fail BINDING_REQUIRED
    docker exec -i "${env_args[@]}" "${CONTAINER}" node "${CLI}" provision --binding-stdin "$@" <"${binding_path}"
  else
    docker exec "${env_args[@]}" "${CONTAINER}" node "${CLI}" "${action}" "$@"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  remove) remove ;;
  status)
    if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then owned_container || fail FOREIGN_CONTAINER; printf 'opencodex_sidecar_deployment=status running=%s container=%s volume=%s\n' "$(docker container inspect --format '{{.State.Running}}' "${CONTAINER}")" "${CONTAINER}" "${VOLUME}"; else printf 'opencodex_sidecar_deployment=status running=false container=%s volume=%s\n' "${CONTAINER}" "${VOLUME}"; fi
    ;;
  lifecycle) shift; lifecycle "$@" ;;
  *) fail UNKNOWN_COMMAND ;;
esac
