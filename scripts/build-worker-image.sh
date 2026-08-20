#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly IMAGE="tg-worker:dev"
readonly EXPECTED_NODE_VERSION="v22.23.2"
readonly EXPECTED_GIT_VERSION="git version 2.43.0"

command -v docker >/dev/null 2>&1 || { printf 'ERROR: docker is required.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'ERROR: the Docker daemon is unavailable.\n' >&2; exit 1; }

if [[ -n "${TIANGONG_NPM_REGISTRY:-}" ]]; then
  [[ "${TIANGONG_NPM_REGISTRY}" =~ ^https://(registry\.npmjs\.org|registry\.npmmirror\.com)/?$ ]] || {
    printf 'ERROR: TIANGONG_NPM_REGISTRY must be an approved public registry.\n' >&2
    exit 1
  }
fi

run_image() { MSYS_NO_PATHCONV=1 docker run "$@"; }
build_args=(--pull)
[[ -z "${TIANGONG_NPM_REGISTRY:-}" ]] || build_args+=(--build-arg "TIANGONG_NPM_REGISTRY=${TIANGONG_NPM_REGISTRY}")
[[ -z "${TIANGONG_OTEL_EXPORTER_ENDPOINT:-}" ]] || build_args+=(--build-arg "TIANGONG_OTEL_EXPORTER_ENDPOINT=${TIANGONG_OTEL_EXPORTER_ENDPOINT}")

build() {
  local target="$1" image="$2"
  printf '[Tiangong] Building target=%s image=%s\n' "${target}" "${image}"
  docker build "${build_args[@]}" --target "${target}" --tag "${image}" "${REPO_ROOT}/worker"
}

build default "${IMAGE}"

[[ "$(run_image --rm --entrypoint node "${IMAGE}" --version)" == "${EXPECTED_NODE_VERSION}" ]] || { printf 'ERROR: Node version mismatch.\n' >&2; exit 1; }
[[ "$(run_image --rm --entrypoint /usr/bin/git "${IMAGE}" --version)" == "${EXPECTED_GIT_VERSION}" ]] || { printf 'ERROR: Git version mismatch.\n' >&2; exit 1; }
run_image --rm --entrypoint node "${IMAGE}" --input-type=module -e '
  if (await import("node:fs").then(({ existsSync }) => existsSync("/opt/tiangong-worker/node_modules/@earendil-works/pi-coding-agent"))) process.exit(1);
  const plugin = await import("/opt/tiangong-worker/plugin/index.mjs");
  if (plugin.default?.id !== "tiangong-control") process.exit(1);
  const { assertMemberRuntimeRoute } = await import("/opt/tiangong-worker/agent/runtime-routing.mjs");
  const { loadAgentPackages } = await import("/opt/tiangong-worker/agent/packages/loader.mjs");
  const { loadInstalledSkills } = await import("/opt/tiangong-worker/agent/skills/catalog.mjs");
  const [agents, skills] = await Promise.all([loadAgentPackages(), loadInstalledSkills()]);
  if (agents.packages.length !== 6 || skills.skills.length !== 6 || await import("node:fs").then(({ existsSync }) => existsSync("/opt/tiangong-worker/legacy"))) process.exit(1);
  assertMemberRuntimeRoute({ responsibility: "leader", configuredRuntime: "openclaw-built-in", configuredModel: "glm-5", selectedRuntime: "openclaw-built-in", selectedModel: "glm-5" });
  assertMemberRuntimeRoute({ responsibility: "developer", configuredRuntime: "openclaw-built-in", configuredModel: "glm-5", selectedRuntime: "openclaw-built-in", selectedModel: "glm-5" });
'
run_image --rm --workdir /opt/tiangong-worker --entrypoint node "${IMAGE}" ./scripts/verify-openclaw-workspace-tools.mjs
printf '[Tiangong] Generic Worker image ready: %s\n' "${IMAGE}"
printf '[Tiangong] Runtime routes are MemberConfig-bound; no role-specific Worker image was built.\n'
