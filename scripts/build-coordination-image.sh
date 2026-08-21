#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="${TIANGONG_COORDINATION_IMAGE:-tiangong-coordination-runtime:dev}"
readonly NODE_IMAGE="${TIANGONG_COORDINATION_NODE_IMAGE:-node:22.23.2-bookworm-slim}"

command -v docker >/dev/null 2>&1 || { printf 'ERROR: docker is required.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'ERROR: Docker daemon is unavailable.\n' >&2; exit 1; }

docker build --pull \
  --build-arg "NODE_IMAGE=${NODE_IMAGE}" \
  --tag "${IMAGE}" \
  --file "${REPO_ROOT}/app/Dockerfile" \
  "${REPO_ROOT}"

actual_node_version="$(docker run --rm --entrypoint node "${IMAGE}" --version)"
[[ "${actual_node_version}" == v22.23.* ]] || {
  printf 'ERROR: coordination image uses unexpected Node.js version: %s\n' "${actual_node_version}" >&2
  exit 1
}

docker run --rm --entrypoint node "${IMAGE}" --input-type=module -e '
  const module = await import("/opt/tiangong/app/coordination/runtime-server.mjs");
  const { loadAgentPackages } = await import("/opt/tiangong/worker/agent/packages/loader.mjs");
  const { loadInstalledSkills } = await import("/opt/tiangong/worker/agent/skills/catalog.mjs");
  const [agents, skills] = await Promise.all([loadAgentPackages(), loadInstalledSkills()]);
  if (typeof module.startCoordinationRuntime !== "function" || agents.packages.length !== 6 || skills.skills.length !== 6) process.exit(1);
'

printf 'tiangong_coordination_image=ready image=%s node=%s\n' "${IMAGE}" "${actual_node_version}"
