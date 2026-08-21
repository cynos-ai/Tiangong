#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly ACTION="${1:-status}"
readonly CONTAINER="tiangong-agentloop-collector"
readonly NETWORK="${TIANGONG_AGENTTEAMS_NETWORK:-agentteams-net}"
readonly CONFIG="${REPO_ROOT}/deploy/agentloop/collector.yaml"
readonly IMAGE="otel/opentelemetry-collector:0.136.0@sha256:98fd3b410ae8a939be9588f1580c4b7c3da6ebba49f5363df4259a827aabb779"
readonly OWNER="tiangong-agentloop"
readonly SECRET_FILE="${TIANGONG_AGENTLOOP_SECRET_FILE:-}"

fail() { printf 'agentloop_collector=fail code=%s\n' "$1" >&2; exit 1; }
owned_container() {
  [[ "$(docker inspect --format '{{ index .Config.Labels "io.tiangong.owner" }}' "${CONTAINER}" 2>/dev/null || true)" == "${OWNER}" ]]
}

command -v docker >/dev/null 2>&1 || fail DOCKER_REQUIRED
case "${ACTION}" in
  status)
    if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then printf 'agentloop_collector=absent\n'; exit 0; fi
    owned_container || fail CONTAINER_NOT_OWNED
    running="$(docker inspect --format '{{.State.Running}}' "${CONTAINER}")"
    printf 'agentloop_collector=%s\n' "$([[ "${running}" == true ]] && printf running || printf stopped)"
    ;;
  stop)
    if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then printf 'agentloop_collector=absent\n'; exit 0; fi
    owned_container || fail CONTAINER_NOT_OWNED
    docker rm --force "${CONTAINER}" >/dev/null
    printf 'agentloop_collector=removed\n'
    ;;
  start)
    [[ -n "${SECRET_FILE}" ]] || fail SECRET_FILE_REQUIRED
    [[ -f "${CONFIG}" && ! -L "${CONFIG}" ]] || fail CONFIG_INVALID
    node "${SCRIPT_DIR}/validate-agentloop-secret-file.mjs" "${SECRET_FILE}" >/dev/null || fail SECRET_FILE_INVALID
    docker network inspect "${NETWORK}" >/dev/null 2>&1 || fail NETWORK_NOT_FOUND
    if docker inspect "${CONTAINER}" >/dev/null 2>&1; then fail CONTAINER_ALREADY_EXISTS; fi
    docker run --rm \
      --env-file "${SECRET_FILE}" \
      --mount "type=bind,src=${CONFIG},dst=/etc/otelcol/config.yaml,readonly" \
      "${IMAGE}" validate --config=/etc/otelcol/config.yaml >/dev/null || fail CONFIG_VALIDATION_FAILED
    docker run --detach \
      --name "${CONTAINER}" \
      --network "${NETWORK}" \
      --env-file "${SECRET_FILE}" \
      --mount "type=bind,src=${CONFIG},dst=/etc/otelcol/config.yaml,readonly" \
      --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --memory 256m \
      --pids-limit 128 \
      --label "io.tiangong.owner=${OWNER}" \
      --label io.tiangong.component=agentloop-otel-collector \
      "${IMAGE}" --config=/etc/otelcol/config.yaml >/dev/null
    stable=0
    for _ in $(seq 1 30); do
      if [[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || true)" == true ]]; then
        stable=$((stable + 1))
        if ((stable >= 3)); then
          printf 'agentloop_collector=running endpoint=http://%s:4318 credential_boundary=collector\n' "${CONTAINER}"
          exit 0
        fi
      else
        stable=0
      fi
      sleep 1
    done
    docker logs --tail 20 "${CONTAINER}" 2>&1 | sed -E 's/[A-Za-z0-9._@-]{16,}/[redacted]/g' >&2 || true
    docker rm --force "${CONTAINER}" >/dev/null 2>&1 || true
    fail START_FAILED
    ;;
  *) fail ACTION_INVALID ;;
esac
