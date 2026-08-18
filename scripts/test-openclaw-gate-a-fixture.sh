#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly FIXTURE="${REPO_ROOT}/smoke-testing/fixtures/openclaw-gate-a-canary-worker.yaml"
readonly DOCKERFILE="${REPO_ROOT}/worker/Dockerfile"
readonly BUILDER="${REPO_ROOT}/scripts/build-worker-image.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

contains_exact_line() {
  local expected="$1" path="$2"
  tr -d '\r' <"${path}" | grep -Fqx "${expected}"
}

[[ -f "${FIXTURE}" && ! -L "${FIXTURE}" ]] || fail 'Gate A canary fixture is missing or symlinked.'
[[ -f "${DOCKERFILE}" && ! -L "${DOCKERFILE}" ]] || fail 'Worker Dockerfile is missing or symlinked.'
[[ -x "${BUILDER}" ]] || fail 'Worker image builder must be executable.'

contains_exact_line '  runtime: openclaw' "${FIXTURE}" || fail 'Canary fixture must use the OpenClaw runtime.'
contains_exact_line '  image: tiangong-worker-canary:dev' "${FIXTURE}" || fail 'Canary fixture must use the isolated image.'
grep -Fq 'FROM worker-base AS canary' "${DOCKERFILE}" || fail 'Canary Docker target is missing.'
grep -Fq 'TIANGONG_RUNTIME_LANE=openclaw-canary' "${DOCKERFILE}" || fail 'Canary image lane is not explicit.'
grep -Fq 'TIANGONG_CANARY_REQUIRED=1' "${DOCKERFILE}" || fail 'Canary image does not require explicit lane binding.'
grep -Fq 'OPENCLAW_AGENT_RUNTIME=codex' "${DOCKERFILE}" || fail 'Canary image does not force the native Codex runtime.'
grep -Fq 'OPENCLAW_AGENT_HARNESS_FALLBACK=none' "${DOCKERFILE}" || fail 'Canary image permits a hidden harness fallback.'
grep -Fq 'ARG TIANGONG_CODEX_GATEWAY_HOSTS=agentteams-controller' "${DOCKERFILE}" || fail 'Canary image does not constrain the Codex gateway host.'
grep -Fq 'ARG TIANGONG_CODEX_CREDENTIAL_SOURCE=agentteams-consumer-token' "${DOCKERFILE}" || fail 'Canary image must use the AgentTeams consumer-token credential route.'
grep -Fq 'ARG TIANGONG_CODEX_BASE_URL=' "${DOCKERFILE}" || fail 'Canary image must expose a non-secret Codex endpoint override.'
grep -Fq 'TIANGONG_CODEX_BASE_URL="${TIANGONG_CODEX_BASE_URL}"' "${DOCKERFILE}" || fail 'Worker base image must carry the explicit Codex endpoint override.'
grep -Fq 'TIANGONG_CODEX_GATEWAY_HOSTS=${TIANGONG_CODEX_GATEWAY_HOSTS}' "${BUILDER}" || fail 'Worker image builder must pass the explicit Codex gateway host allowlist.'
grep -Fq 'TIANGONG_CODEX_BASE_URL=${TIANGONG_CODEX_BASE_URL}' "${BUILDER}" || fail 'Worker image builder must pass the explicit Codex endpoint override.'
grep -Fq 'ARG TIANGONG_CODEX_TRANSPORT=auto' "${DOCKERFILE}" || fail 'Canary image must resolve the route from the shared capability cache.'
grep -Fq 'ARG TIANGONG_CODEX_BRIDGE=auto' "${DOCKERFILE}" || fail 'Canary image must resolve the bridge from the shared capability cache.'
grep -Fq 'ARG TIANGONG_CODEX_CAPABILITY_CACHE_PATH=/var/lib/tiangong-capabilities/codex.json' "${DOCKERFILE}" || fail 'Canary image must use the deployment-owned shared capability cache.'
grep -Fq 'ARG TIANGONG_CODEX_CAPABILITY_CACHE_SHARED=1' "${DOCKERFILE}" || fail 'Canary image must use the deployment-owned cache adapter.'
grep -Fq 'ARG TIANGONG_CODEX_CAPABILITY_CACHE_URL=http://tiangong-codex-capability-cache:8788' "${DOCKERFILE}" || fail 'Canary image must use the internal cache service endpoint.'
grep -Fq 'FROM worker-base AS canary-chat-bridge' "${DOCKERFILE}" || fail 'Chat-only bridge canary target is missing.'
grep -Fq 'ARG TIANGONG_CODEX_MODEL=qwen3.7-plus' "${DOCKERFILE}" || fail 'Chat-only bridge canary must select the Qwen Coding Plan model.'
grep -Fq 'ARG TIANGONG_CODEX_TRANSPORT=responses-via-chat-bridge' "${DOCKERFILE}" || fail 'Chat-only bridge canary must select the bridge transport.'
grep -Fq 'ARG TIANGONG_CODEX_BRIDGE=opencodex' "${DOCKERFILE}" || fail 'Chat-only bridge canary must select OpenCodex.'
# shellcheck disable=SC2016
grep -Fq 'del(.models.providers[$provider].apiKey)' "${REPO_ROOT}/worker/bin/openclaw" || fail 'Codex canary must not persist the Worker gateway credential in OpenClaw config.'
grep -Fq 'x-opencodex-api-key' "${REPO_ROOT}/worker/bin/openclaw" || fail 'OpenCodex bridge must use its dedicated admission header.'
grep -Fq 'TIANGONG_CODEX_SIDECAR_RECEIPT_PATH' "${REPO_ROOT}/worker/bin/openclaw" || fail 'Chat-only Codex workers must receive an explicit sidecar readiness receipt path.'
grep -Fq 'codex-capability-cache.mjs' "${REPO_ROOT}/worker/bin/openclaw" || fail 'Canary worker must use the shared capability cache.'
grep -Fq 'TIANGONG_CODEX_CAPABILITY_CACHE_SHARED:-0' "${REPO_ROOT}/worker/bin/openclaw" || fail 'Canary auto routing must fail closed without a shared-cache declaration.'
grep -Fq 'codex-sidecar-receipt-missing' "${REPO_ROOT}/worker/agent/preflight/codex-gateway-preflight.mjs" || fail 'Codex preflight must fail closed when the bridge readiness receipt is missing.'
[[ -f "${REPO_ROOT}/worker/agent/deployment/opencodex-sidecar.mjs" ]] || fail 'OpenCodex sidecar lifecycle contract is missing.'
grep -Fq 'bin/codex-app-server' "${DOCKERFILE}" || fail 'Canary image does not include the sanitized Codex app-server launcher.'
[[ -x "${REPO_ROOT}/worker/bin/codex-app-server" ]] || fail 'Sanitized Codex app-server launcher is not executable.'
[[ -x "${REPO_ROOT}/worker/bin/codex" ]] || fail 'Canary codex PATH shim is not executable.'
grep -Fq 'command: "/opt/tiangong-worker/bin/codex-app-server"' "${REPO_ROOT}/worker/bin/openclaw" || fail 'Canary OpenClaw config does not pin the sanitized Codex launcher.'
grep -Fq 'ARG TIANGONG_CODEX_PROVIDER=agentteams-gateway' "${DOCKERFILE}" || fail 'Canary image does not use the AgentTeams gateway provider.'
grep -Fq 'ARG TIANGONG_CODEX_MODEL=deepseek-v4-pro' "${DOCKERFILE}" || fail 'Canary image does not select DeepSeek V4 Pro.'
grep -Fq 'CANARY_IMAGE="tiangong-worker-canary:dev"' "${BUILDER}" || fail 'Canary image is not built by the image builder.'
contains_exact_line '  model: codex/deepseek-v4-pro' "${FIXTURE}" || fail 'Canary fixture must use the AgentTeams-routed DeepSeek Codex model reference.'

if grep -Eqi 'password|access_token|apiKey|secret|token:' "${FIXTURE}"; then
  fail 'Canary fixture contains credential-bearing fields.'
fi
canary_fixture_count="$(grep -El '^  image: tiangong-worker-canary:dev$' "${REPO_ROOT}/smoke-testing/fixtures"/*.yaml | wc -l | tr -d ' ')"
if [[ "${canary_fixture_count}" != 1 ]]; then
  fail 'Canary image is unexpectedly reused by another fixture.'
fi

printf 'OpenClaw Gate A canary fixture contract passed.\n'
