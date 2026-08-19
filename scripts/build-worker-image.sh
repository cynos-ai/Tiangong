#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly IMAGE="tg-worker:dev"
readonly CANARY_IMAGE="tg-worker-canary:dev"
readonly CHAT_BRIDGE_IMAGE="tg-worker-canary-chat-bridge:dev"
readonly RUNNER_BROKER_IMAGE="tg-runner-broker:dev"
readonly DEPLOYMENT_SERVICE_IMAGE="tg-deployment-service:dev"
readonly DEPLOYMENT_BROKER_IMAGE="tg-deployment-broker:dev"
readonly CODEX_CAPABILITY_CACHE_IMAGE="tg-codex-capability-cache:dev"
readonly OPENCODEX_SIDECAR_IMAGE="tg-opencodex-sidecar:dev"
readonly OPENCODEX_RECEIPT_SERVICE_IMAGE="tg-opencodex-receipt-service:dev"
readonly OPENCODEX_ADAPTER_IMAGE="tg-opencodex-adapter:dev"
readonly EXPECTED_NODE_VERSION="v22.23.2"
readonly EXPECTED_CODEX_VERSION="codex-cli 0.120.0"
readonly EXPECTED_GIT_VERSION="git version 2.43.0"
readonly EXPECTED_DOCKER_CLI_VERSION="28.3.3"

command -v docker >/dev/null 2>&1 || { printf 'ERROR: docker is required.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'ERROR: the Docker daemon is unavailable.\n' >&2; exit 1; }

validate_codex_gateway_override() {
  local base_url="${TIANGONG_CODEX_BASE_URL:-}" hosts="${TIANGONG_CODEX_GATEWAY_HOSTS:-}"
  if [[ -n "${base_url}" ]]; then
    [[ "${base_url}" =~ ^https?://[^@/?#[:space:]]+(/[^?#[:space:]]*)?$ ]] || { printf 'ERROR: TIANGONG_CODEX_BASE_URL is unsafe.\n' >&2; exit 1; }
  fi
  if [[ -n "${hosts}" ]]; then
    [[ "${hosts}" =~ ^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$ ]] || { printf 'ERROR: TIANGONG_CODEX_GATEWAY_HOSTS is invalid.\n' >&2; exit 1; }
  fi
}
validate_codex_gateway_override
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
[[ -z "${TIANGONG_CODEX_GATEWAY_HOSTS:-}" ]] || build_args+=(--build-arg "TIANGONG_CODEX_GATEWAY_HOSTS=${TIANGONG_CODEX_GATEWAY_HOSTS}")
[[ -z "${TIANGONG_CODEX_BASE_URL:-}" ]] || build_args+=(--build-arg "TIANGONG_CODEX_BASE_URL=${TIANGONG_CODEX_BASE_URL}")

build() {
  local target="$1" image="$2"
  printf '[Tiangong] Building target=%s image=%s\n' "${target}" "${image}"
  docker build "${build_args[@]}" --target "${target}" --tag "${image}" "${REPO_ROOT}/worker"
}

build default "${IMAGE}"
build canary "${CANARY_IMAGE}"
build canary-chat-bridge "${CHAT_BRIDGE_IMAGE}"
build runner-broker "${RUNNER_BROKER_IMAGE}"
build deployment-service "${DEPLOYMENT_SERVICE_IMAGE}"
build deployment-broker "${DEPLOYMENT_BROKER_IMAGE}"
build codex-capability-cache "${CODEX_CAPABILITY_CACHE_IMAGE}"
build opencodex-sidecar "${OPENCODEX_SIDECAR_IMAGE}"
build opencodex-receipt-service "${OPENCODEX_RECEIPT_SERVICE_IMAGE}"
build opencodex-adapter "${OPENCODEX_ADAPTER_IMAGE}"

[[ "$(run_image --rm --entrypoint node "${IMAGE}" --version)" == "${EXPECTED_NODE_VERSION}" ]] || { printf 'ERROR: Node version mismatch.\n' >&2; exit 1; }
[[ "$(run_image --rm --entrypoint /usr/bin/git "${IMAGE}" --version)" == "${EXPECTED_GIT_VERSION}" ]] || { printf 'ERROR: Git version mismatch.\n' >&2; exit 1; }
actual_docker_cli_version="$(run_image --rm --entrypoint /usr/local/bin/docker "${RUNNER_BROKER_IMAGE}" --version | awk '{print $3}' | tr -d ',')"
[[ "${actual_docker_cli_version}" == "${EXPECTED_DOCKER_CLI_VERSION}" ]] || { printf 'ERROR: Docker CLI version mismatch.\n' >&2; exit 1; }
actual_codex_version="$(run_image --rm --entrypoint /opt/tiangong-worker/node_modules/.bin/codex "${CANARY_IMAGE}" --version)"
[[ "${actual_codex_version}" == "${EXPECTED_CODEX_VERSION}" ]] || { printf 'ERROR: Codex version mismatch.\n' >&2; exit 1; }
run_image --rm --entrypoint node "${IMAGE}" --input-type=module -e '
  if (await import("node:fs").then(({ existsSync }) => existsSync("/opt/tiangong-worker/node_modules/@earendil-works/pi-coding-agent"))) process.exit(1);
  const plugin = await import("/opt/tiangong-worker/plugin/index.mjs");
  if (plugin.default?.id !== "tiangong-control") process.exit(1);
  const { assertMemberRuntimeRoute } = await import("/opt/tiangong-worker/agent/runtime-routing.mjs");
  const { loadAgentPackages } = await import("/opt/tiangong-worker/agent/packages/loader.mjs");
  const { loadInstalledSkills } = await import("/opt/tiangong-worker/agent/skills/catalog.mjs");
  const [agents, skills] = await Promise.all([loadAgentPackages(), loadInstalledSkills()]);
  if (agents.packages.length !== 6 || skills.skills.length !== 6 || await import("node:fs").then(({ existsSync }) => existsSync("/opt/tiangong-worker/legacy"))) process.exit(1);
  assertMemberRuntimeRoute({ responsibility: "leader", configuredRuntime: "openclaw-built-in", configuredModel: "deepseek-chat", selectedRuntime: "openclaw-built-in", selectedModel: "deepseek-chat" });
  assertMemberRuntimeRoute({ responsibility: "developer", configuredRuntime: "codex-app-server", configuredModel: "deepseek-v4-flash", selectedRuntime: "codex-app-server", selectedModel: "deepseek-v4-flash" });
'
run_image --rm --workdir /opt/tiangong-worker --env OPENCLAW_CODEX_APP_SERVER_BIN=/opt/tiangong-worker/node_modules/.bin/codex --entrypoint node "${CANARY_IMAGE}" scripts/probe-codex-app-server.mjs

printf '[Tiangong] Generic Worker image ready: %s\n' "${IMAGE}"
printf '[Tiangong] Runtime routes are MemberConfig-bound; no role-specific Worker image was built.\n'
