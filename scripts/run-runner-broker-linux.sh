#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly CONTROL_IMAGE="${TIANGONG_RUNNER_CONTROL_IMAGE:-tiangong-runner-broker:dev}"

fail() { printf 'runner_broker_linux=fail code=%s\n' "$1" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail DOCKER_COMMAND_NOT_FOUND
docker image inspect "${CONTROL_IMAGE}" >/dev/null 2>&1 || fail CONTROL_IMAGE_NOT_FOUND
docker run --rm --entrypoint node \
  --env TIANGONG_DOCKER_PATH=/usr/local/bin/docker \
  --mount "type=bind,src=${REPO_ROOT},dst=/workspace,readonly" \
  --mount 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock' \
  --workdir /workspace "${CONTROL_IMAGE}" \
  smoke-testing/support/run-runner-broker-smoke.mjs
printf 'runner_broker_linux=pass\n'
