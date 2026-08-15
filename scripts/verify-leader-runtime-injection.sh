#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONTAINER="${TIANGONG_LEADER_WORKER_CONTAINER:-}"
readonly BINDING_FILE="${TIANGONG_LEADER_RUNTIME_BINDING_FILE:-}"
readonly ENDPOINT="${TIANGONG_COORDINATION_CONTROL_ENDPOINT:-}"
readonly BINDING_TARGET="${TIANGONG_LEADER_RUNTIME_BINDING_TARGET:-/run/tiangong-leader/leader-binding.json}"

fail() { printf 'leader_runtime_injection=fail code=%s\n' "$1" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "${2:-COMMAND_NOT_FOUND}"; }
regular_binding() {
  local mode path="$1"
  [[ -n "${path}" && -f "${path}" && ! -L "${path}" ]] || return 1
  mode="$(stat -c '%a' "${path}" 2>/dev/null || stat -f '%Lp' "${path}")"
  [[ "${mode}" == 600 || "${mode}" == 400 ]]
}
valid_endpoint() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/v1/coordination/admit$ ]]
}
require_command docker
require_command jq
[[ -n "${CONTAINER}" ]] || fail WORKER_CONTAINER_REQUIRED
[[ -n "${BINDING_FILE}" ]] || fail BINDING_FILE_REQUIRED
[[ -n "${ENDPOINT}" ]] || fail CONTROL_ENDPOINT_REQUIRED
regular_binding "${BINDING_FILE}" || fail INVALID_BINDING_FILE
valid_endpoint "${ENDPOINT}" || fail INVALID_CONTROL_ENDPOINT

running="$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || true)"
[[ "${running}" == true ]] || fail WORKER_NOT_RUNNING
name="$(docker inspect -f '{{.Name}}' "${CONTAINER}" 2>/dev/null || true)"
[[ "${name}" == "/${CONTAINER}" ]] || fail WORKER_IDENTITY_MISMATCH

env_json="$(docker inspect -f '{{json .Config.Env}}' "${CONTAINER}" 2>/dev/null || true)"
[[ -n "${env_json}" ]] || fail WORKER_ENV_UNAVAILABLE
jq -e --arg endpoint "${ENDPOINT}" --arg binding "${BINDING_TARGET}" '
  if type != "array" then false
  else
    ([.[] | select(startswith("TIANGONG_COORDINATION_CONTROL_ENDPOINT="))] | length == 1) and
    ([.[] | select(. == ("TIANGONG_COORDINATION_CONTROL_ENDPOINT=" + $endpoint))] | length == 1) and
    ([.[] | select(startswith("TIANGONG_LEADER_RUNTIME_BINDING_FILE="))] | length == 1) and
    ([.[] | select(. == ("TIANGONG_LEADER_RUNTIME_BINDING_FILE=" + $binding))] | length == 1) and
    ([.[] | select(startswith("TIANGONG_COORDINATION_CONTROL_TOKEN="))] | length == 1) and
    ([.[] | select(startswith("TIANGONG_COORDINATION_DATABASE_URL=") or startswith("TIANGONG_COORDINATION_MATRIX_TOKEN="))] | length == 0)
  end
' >/dev/null <<<"${env_json}" || fail WORKER_ENV_BINDING_MISMATCH

mounts_json="$(docker inspect -f '{{json .Mounts}}' "${CONTAINER}" 2>/dev/null || true)"
jq -e --arg target "${BINDING_TARGET}" '
  type == "array" and any(.[]; .Destination == $target and .RW == false)
' >/dev/null <<<"${mounts_json}" || fail BINDING_MOUNT_MISMATCH

docker exec "${CONTAINER}" node --input-type=module -e '
  const path = process.env.TIANGONG_LEADER_RUNTIME_BINDING_FILE;
  const { readLeaderRuntimeBinding } = await import("/opt/tiangong-worker/agent/team/leader-runtime-config.mjs");
  await readLeaderRuntimeBinding(path);
' >/dev/null 2>&1 || fail WORKER_BINDING_UNREADABLE

printf 'leader_runtime_injection=pass container=%s endpoint=%s\n' "${CONTAINER}" "${ENDPOINT}"
