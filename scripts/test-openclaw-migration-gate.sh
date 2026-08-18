#!/usr/bin/env bash
set -Eeuo pipefail

# Static migration-before-cutover gate. It proves the new-Team default and the
# explicit legacy Pi rollback seam without touching AgentTeams, Docker, PG, or
# MinIO. Real cutover still requires Phase C and the provider canary.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT

fail() {
  printf 'openclaw_migration_default_contract=fail code=%s\n' "$1" >&2
  exit 1
}

grep -Fqx 'AGENTTEAMS_DEFAULT_WORKER_RUNTIME=openclaw' "${REPO_ROOT}/.env.example" || fail ENV_DEFAULT_NOT_OPENCLAW
grep -Fq ': "${AGENTTEAMS_DEFAULT_WORKER_RUNTIME:=openclaw}"' "${REPO_ROOT}/scripts/agentteams.sh" || fail BOOTSTRAP_DEFAULT_NOT_OPENCLAW
grep -Fq 'readonly NATIVE_OPENCLAW="${TIANGONG_B5_OPENCLAW_NATIVE:-1}"' "${REPO_ROOT}/scripts/inject-b5-role-runtime-docker.sh" || fail NATIVE_DEFAULT_NOT_ENABLED
grep -Fq 'TIANGONG_B5_OPENCLAW_NATIVE=0' "${REPO_ROOT}/scripts/test-b5-role-runtime-injection-docker.sh" || fail PI_ROLLBACK_NOT_TESTED
grep -Fq 'OPENCLAW_AGENT_RUNTIME="tiangong-pi"' "${REPO_ROOT}/worker/bin/openclaw" || fail PI_ROLLBACK_RUNTIME_MISSING
grep -Fq 'configure_builtin_gateway' "${REPO_ROOT}/worker/bin/openclaw" || fail BUILTIN_GATEWAY_OVERRIDE_MISSING
grep -Fq 'builtin_gateway_override=pass' "${REPO_ROOT}/worker/bin/openclaw" || fail BUILTIN_GATEWAY_OVERRIDE_MARKER_MISSING
grep -Fq '.models.providers[$provider_id].models' "${REPO_ROOT}/worker/bin/openclaw" || fail CODEX_MODEL_PROJECTION_MISSING
grep -Fq 'OPENCLAW_AGENT_HARNESS_FALLBACK=none' "${REPO_ROOT}/worker/Dockerfile" || fail FALLBACK_NOT_CLOSED
grep -Fq 'TIANGONG_B5_OPENCLAW_NATIVE=0' "${REPO_ROOT}/docs/design/openclaw-progressive-migration.zh.md" || fail ROLLBACK_DOC_MISSING

printf 'openclaw_migration_default_contract=pass default=openclaw rollback=tiangong-pi\n'
