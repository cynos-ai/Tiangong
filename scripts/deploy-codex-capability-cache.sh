#!/usr/bin/env bash
set -Eeuo pipefail

readonly NETWORK="${TIANGONG_AGENTTEAMS_NETWORK:-agentteams-net}"
readonly IMAGE="${TIANGONG_CODEX_CAPABILITY_CACHE_IMAGE:-tiangong-codex-capability-cache:dev}"
readonly CONTAINER="${TIANGONG_CODEX_CAPABILITY_CACHE_CONTAINER:-tiangong-codex-capability-cache}"
readonly VOLUME="${TIANGONG_CODEX_CAPABILITY_CACHE_VOLUME:-tiangong-codex-capability-cache}"
readonly CACHE_DIR="/var/lib/tiangong-capabilities"
readonly OWNER="tiangong-deployment"
readonly COMPONENT="codex-capability-cache"

fail() { printf 'codex_capability_cache_deployment=fail code=%s\n' "$1" >&2; exit 1; }
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
  if docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
    owned_volume || fail FOREIGN_VOLUME
  else
    docker volume create --label "io.tiangong.owner=${OWNER}" --label "io.tiangong.component=${COMPONENT}" --label 'io.tiangong.schema=1' "${VOLUME}" >/dev/null
  fi
  if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
    owned_container || fail FOREIGN_CONTAINER
    docker container inspect --format '{{.State.Running}}' "${CONTAINER}" | grep -Fxq true || docker container start "${CONTAINER}" >/dev/null
  else
    docker run -d --name "${CONTAINER}" \
      --label "io.tiangong.owner=${OWNER}" \
      --label "io.tiangong.component=${COMPONENT}" \
      --label 'io.tiangong.schema=1' \
      --network "${NETWORK}" \
      --network-alias "${CONTAINER}" \
      --mount "type=volume,src=${VOLUME},dst=${CACHE_DIR}" \
      "${IMAGE}" >/dev/null
  fi
  for _ in $(seq 1 30); do
    if docker exec "${CONTAINER}" node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8788/healthz"); if (!r.ok) process.exit(1); const v=await r.json(); if (v.status !== "ok") process.exit(1);' >/dev/null 2>&1; then
      printf 'codex_capability_cache_deployment=ready container=%s volume=%s network=%s\n' "${CONTAINER}" "${VOLUME}" "${NETWORK}"
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
  printf 'codex_capability_cache_deployment=stopped container=%s volume_retained=%s\n' "${CONTAINER}" "${VOLUME}"
}

remove() {
  stop
  if docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
    owned_volume || fail FOREIGN_VOLUME
    docker volume rm "${VOLUME}" >/dev/null
  fi
  if docker volume inspect "${VOLUME}" >/dev/null 2>&1; then fail VOLUME_CLEANUP_INCOMPLETE; fi
  printf 'codex_capability_cache_deployment=removed volume=%s\n' "${VOLUME}"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  remove) remove ;;
  status)
    if docker container inspect "${CONTAINER}" >/dev/null 2>&1; then
      owned_container || fail FOREIGN_CONTAINER
      printf 'codex_capability_cache_deployment=status running=%s container=%s volume=%s\n' "$(docker container inspect --format '{{.State.Running}}' "${CONTAINER}")" "${CONTAINER}" "${VOLUME}"
    else
      printf 'codex_capability_cache_deployment=status running=false container=%s volume=%s\n' "${CONTAINER}" "${VOLUME}"
    fi
    ;;
  *) fail UNKNOWN_COMMAND ;;
esac
