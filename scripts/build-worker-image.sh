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
  const { existsSync, readFileSync } = await import("node:fs");
  if (existsSync("/opt/tiangong-worker/node_modules/@earendil-works/pi-coding-agent")) process.exit(1);
  const agentLoop = JSON.parse(readFileSync("/opt/agentloop/opentelemetry-instrumentation-openclaw/package.json", "utf8"));
  if (agentLoop.version !== "0.1.5-beta" || agentLoop.license !== "Apache-2.0" || agentLoop.dependencies["@opentelemetry/exporter-trace-otlp-proto"] !== "0.221.0" || !existsSync("/opt/tiangong-worker/licenses/agentloop-openclaw-Apache-2.0.txt")) process.exit(1);
  if (existsSync("/opt/tiangong-worker/node_modules/@opentelemetry/exporter-trace-otlp-http")) process.exit(1);
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

probe_log="$(mktemp "${TMPDIR:-/tmp}/tiangong-agentloop-image.XXXXXX")"
trap 'rm -f "${probe_log:-}"' EXIT
set +e
# shellcheck disable=SC2016 # HOME/OPENCLAW_CONFIG_PATH expand in the container shell.
run_image --rm --entrypoint /bin/bash \
  --env HOME=/tmp/tiangong-m8-home \
  --env OPENCLAW_CONFIG_PATH=/tmp/tiangong-m8-home/openclaw.json \
  --env AGENTTEAMS_WORKER_NAME=tiangong-m8-image-check \
  --env TIANGONG_AGENTLOOP_ENABLED=1 \
  --env TIANGONG_AGENTLOOP_CONTENT_CAPTURE=isolated-test \
  --env TIANGONG_AGENTLOOP_SERVICE_NAME=tiangong-m8-image-check \
  "${IMAGE}" -lc 'mkdir -p "${HOME}"; printf %s '\''{"gateway":{"mode":"local"}}'\'' >"${OPENCLAW_CONFIG_PATH}"; chmod 600 "${OPENCLAW_CONFIG_PATH}"; timeout 12 /opt/tiangong-worker/bin/openclaw gateway run' \
  >"${probe_log}" 2>&1
probe_status=$?
set -e
if [[ "${probe_status}" != 124 ]] || ! grep -Eq 'ready \(3 plugins:.*opentelemetry-instrumentation-openclaw' "${probe_log}" || grep -Eqi 'plugin not found|blocked plugin|Unrecognized key' "${probe_log}"; then
  tail -80 "${probe_log}" >&2
  printf 'ERROR: AgentLoop plugin did not load cleanly in pinned OpenClaw.\n' >&2
  exit 1
fi
rm -f "${probe_log}"
trap - EXIT
printf '[Tiangong] AgentLoop plugin load passed: version=0.1.5-beta openclaw=2026.4.14 transport=http/protobuf.\n'
printf '[Tiangong] Generic Worker image ready: %s\n' "${IMAGE}"
printf '[Tiangong] Runtime routes are MemberConfig-bound; no role-specific Worker image was built.\n'
