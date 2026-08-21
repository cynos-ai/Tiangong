#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="${TIANGONG_AGENTLOOP_QUERY_ADAPTER_IMAGE:-tiangong-agentloop-query-adapter:dev}"
readonly PYTHON_IMAGE="${TIANGONG_AGENTLOOP_QUERY_PYTHON_IMAGE:-python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c}"

command -v docker >/dev/null 2>&1 || { printf 'ERROR: docker is required.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'ERROR: Docker daemon is unavailable.\n' >&2; exit 1; }

docker build --pull \
  --build-arg "PYTHON_IMAGE=${PYTHON_IMAGE}" \
  --tag "${IMAGE}" \
  --file "${REPO_ROOT}/agentloop_query_adapter/Dockerfile" \
  "${REPO_ROOT}"

docker run --rm --entrypoint python "${IMAGE}" -c '
from importlib.metadata import version
from agentloop_query_adapter.core import MAX_RESULTS
assert version("aliyun-log-python-sdk") == "0.9.50"
assert MAX_RESULTS == 100
'

printf 'agentloop_query_adapter_image=ready image=%s sdk=0.9.50\n' "${IMAGE}"
