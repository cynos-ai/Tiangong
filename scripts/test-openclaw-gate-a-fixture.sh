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

[[ -f "${FIXTURE}" && ! -L "${FIXTURE}" ]] || fail 'Gate A canary fixture is missing or symlinked.'
[[ -f "${DOCKERFILE}" && ! -L "${DOCKERFILE}" ]] || fail 'Worker Dockerfile is missing or symlinked.'
[[ -x "${BUILDER}" ]] || fail 'Worker image builder must be executable.'

grep -Fqx '  runtime: openclaw' "${FIXTURE}" || fail 'Canary fixture must use the OpenClaw runtime.'
grep -Fqx '  image: tiangong-worker-canary:dev' "${FIXTURE}" || fail 'Canary fixture must use the isolated image.'
grep -Fq 'FROM worker-base AS canary' "${DOCKERFILE}" || fail 'Canary Docker target is missing.'
grep -Fq 'TIANGONG_RUNTIME_LANE=openclaw-canary' "${DOCKERFILE}" || fail 'Canary image lane is not explicit.'
grep -Fq 'TIANGONG_CANARY_REQUIRED=1' "${DOCKERFILE}" || fail 'Canary image does not require explicit lane binding.'
grep -Fq 'OPENCLAW_AGENT_RUNTIME=codex' "${DOCKERFILE}" || fail 'Canary image does not force the native Codex runtime.'
grep -Fq 'OPENCLAW_AGENT_HARNESS_FALLBACK=none' "${DOCKERFILE}" || fail 'Canary image permits a hidden harness fallback.'
grep -Fq 'CANARY_IMAGE="tiangong-worker-canary:dev"' "${BUILDER}" || fail 'Canary image is not built by the image builder.'
grep -Fqx '  model: codex/gpt-5.4' "${FIXTURE}" || fail 'Canary fixture must use a Codex model reference.'

if grep -Eqi 'password|access_token|apiKey|secret|token:' "${FIXTURE}"; then
  fail 'Canary fixture contains credential-bearing fields.'
fi
canary_fixture_count="$(grep -El '^  image: tiangong-worker-canary:dev$' "${REPO_ROOT}/smoke-testing/fixtures"/*.yaml | wc -l | tr -d ' ')"
if [[ "${canary_fixture_count}" != 1 ]]; then
  fail 'Canary image is unexpectedly reused by another fixture.'
fi

printf 'OpenClaw Gate A canary fixture contract passed.\n'
