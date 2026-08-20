#!/usr/bin/env bash
set -Eeuo pipefail

# Static migration-before-cutover gate. It proves the new-Team default and the
# native OpenClaw/Codex routing with no Tiangong-owned runtime fallback, without
# touching AgentTeams, Docker, PG, or MinIO. Qwen remains a later optional lane.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT

fail() {
  printf 'openclaw_migration_default_contract=fail code=%s\n' "$1" >&2
  exit 1
}

# `.env.example` is checked out with the platform's native line ending on
# Windows; normalize only this static contract before matching it.
grep -Fqx 'AGENTTEAMS_DEFAULT_WORKER_RUNTIME=openclaw' <(tr -d '\r' < "${REPO_ROOT}/.env.example") || fail ENV_DEFAULT_NOT_OPENCLAW
grep -Fq ": \"\${AGENTTEAMS_DEFAULT_WORKER_RUNTIME:=openclaw}\"" "${REPO_ROOT}/scripts/agentteams.sh" || fail BOOTSTRAP_DEFAULT_NOT_OPENCLAW
grep -Fq 'readonly OPENCLAW_RUNTIME=pi' "${REPO_ROOT}/scripts/inject-member-runtime-docker.sh" || fail OPENCLAW_NATIVE_RUNTIME_MISSING
grep -Fq 'tiangong-control' "${REPO_ROOT}/worker/plugin/openclaw.plugin.json" || fail CONTROL_PLUGIN_MISSING
if rg -n 'tiangong-pi|TIANGONG_OPENCLAW_NATIVE|registerAgentHarness' "${REPO_ROOT}/worker/plugin" "${REPO_ROOT}/worker/bin/openclaw" "${REPO_ROOT}/scripts/inject-member-runtime-docker.sh" >/dev/null; then
  fail LEGACY_HARNESS_REFERENCE_PRESENT
fi
grep -Fq 'configure_builtin_gateway' "${REPO_ROOT}/worker/bin/openclaw" || fail BUILTIN_GATEWAY_OVERRIDE_MISSING
grep -Fq 'builtin_gateway_override=pass' "${REPO_ROOT}/worker/bin/openclaw" || fail BUILTIN_GATEWAY_OVERRIDE_MARKER_MISSING
grep -Fq ".models.providers[\$provider_id].models" "${REPO_ROOT}/worker/bin/openclaw" || fail CODEX_MODEL_PROJECTION_MISSING
grep -Fq 'OPENCLAW_AGENT_HARNESS_FALLBACK=none' "${REPO_ROOT}/worker/Dockerfile" || fail FALLBACK_NOT_CLOSED
grep -Fq 'Qwen' "${REPO_ROOT}/docs/design/openclaw-progressive-migration.zh.md" || fail OPTIONAL_QWEN_DOC_MISSING

printf 'openclaw_migration_default_contract=pass default=openclaw fallback=none deepseek-only=1\n'
