#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONTAINER_NAME="agentteams-worker-tiangong-openclaw-canary"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'docker is required.'
docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1 || fail "${CONTAINER_NAME} does not exist."
[[ "$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}')" == true ]] ||
  fail "${CONTAINER_NAME} is not running."

info="$(docker exec "${CONTAINER_NAME}" openclaw plugins info tiangong-pi 2>/dev/null)" ||
  fail 'OpenClaw could not inspect the required Tiangong plugin.'
grep -Fqx 'Status: loaded' <<<"${info}" || fail 'Tiangong plugin is not loaded.'
grep -Fqx 'before_dispatch (priority 100)' <<<"${info}" ||
  fail 'The pinned OpenClaw before_dispatch admission hook is not registered.'
grep -Fqx 'before_tool_call (priority 100)' <<<"${info}" ||
  fail 'The pinned OpenClaw before_tool_call admission hook is not registered.'

printf 'OpenClaw Gate A live hook contract passed.\n'
