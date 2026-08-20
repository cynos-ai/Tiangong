#!/usr/bin/env bash
set -Eeuo pipefail

# Phase C is a deployment boundary, not a model-prompt claim. This gate runs
# the deterministic contracts by default and only touches AgentTeams/Docker
# when TIANGONG_PHASE_C_REAL=1 is explicitly set.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT

failures=0
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/tiangong-phase-c.XXXXXX")"
cleanup() { rm -rf -- "${tmp_root}"; }
trap cleanup EXIT INT TERM

node_bin="${TIANGONG_NODE_BIN:-}"
if [[ -z "${node_bin}" ]]; then
  node_bin="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "${node_bin}" ]]; then
  node_bin="$(command -v node.exe 2>/dev/null || true)"
fi
[[ -n "${node_bin}" ]] || {
  printf 'phasec=fail step=node code=NODE_NOT_FOUND\n' >&2
  exit 1
}

run_step() {
  local label="$1"
  shift
  local output="${tmp_root}/${label}.out"
  if "$@" >"${output}" 2>&1; then
    printf 'phasec=pass step=%s\n' "${label}"
    return 0
  else
    local code=$?
    failures=$((failures + 1))
    printf 'phasec=fail step=%s code=EXIT_%s\n' "${label}" "${code}" >&2
    if [[ "${TIANGONG_PHASE_C_DEBUG:-0}" == 1 ]]; then
      # Only expose stable machine markers; never print arbitrary model text,
      # credentials, request bodies, or provider responses from the gate log.
      grep -E '^(phasec|gateb=|leader_smoke_|coordination_runtime_deployment|leader_runtime_injection|member_runtime_injection|.*contract=)' "${output}" | tail -n 30 >&2 || true
    fi
    return 0
  fi
}

run_step coordination-deployment-contract bash "${SCRIPT_DIR}/test-coordination-runtime-deployment.sh"
run_step leader-injection-contract bash "${SCRIPT_DIR}/test-leader-runtime-injection.sh"
run_step leader-injection-docker-contract bash "${SCRIPT_DIR}/test-leader-runtime-injection-docker.sh"
run_step member-injection-docker-contract bash "${SCRIPT_DIR}/test-member-runtime-injection-docker.sh"
run_step gateway-provider-normalizer-contract bash "${SCRIPT_DIR}/test-agentteams-gateway-provider-normalizer.sh"
run_step openclaw-migration-default-contract bash "${SCRIPT_DIR}/test-openclaw-migration-gate.sh"

grep -Fq "/api/v1/gateway/consumers/\${consumer_name}/bind" "${REPO_ROOT}/smoke-testing/support/run-b5-gateb-smoke.sh" || {
  printf 'phasec=fail step=gateway-consumer-binding-contract code=BIND_ENDPOINT_MISSING\n' >&2
  failures=$((failures + 1))
}

# Gate B must not reuse the fixed smoke Team/Matrix namespace. Shared
# AgentTeams history keeps immutable project/result records, so a rerun gets a
# run-scoped manifest and passes the same names into the Leader oracle.
grep -Fq 'SMOKE_SCOPE_RAW=' "${REPO_ROOT}/smoke-testing/support/run-b5-gateb-smoke.sh" || {
  printf 'phasec=fail step=gateb-isolation-contract code=RESOURCE_SCOPE_MISSING\n' >&2
  failures=$((failures + 1))
}
# shellcheck disable=SC2016
isolation_team_injection='TIANGONG_SMOKE_TEAM_NAME="${TEAM_NAME}"'
grep -Fq "${isolation_team_injection}" "${REPO_ROOT}/smoke-testing/support/run-b5-gateb-smoke.sh" || {
  printf 'phasec=fail step=gateb-isolation-contract code=TEAM_SCOPE_NOT_INJECTED\n' >&2
  failures=$((failures + 1))
}
# shellcheck disable=SC2016
isolation_manifest_injection='TIANGONG_SMOKE_WORKERS_MANIFEST="${SMOKE_WORKERS_MANIFEST}"'
grep -Fq "${isolation_manifest_injection}" "${REPO_ROOT}/smoke-testing/support/run-b5-gateb-smoke.sh" || {
  printf 'phasec=fail step=gateb-isolation-contract code=WORKER_MANIFEST_SCOPE_NOT_INJECTED\n' >&2
  failures=$((failures + 1))
}
grep -Fq 'TIANGONG_SMOKE_TEAM_NAME:-tiangong-leader-smoke' "${REPO_ROOT}/smoke-testing/support/run-leader-smoke.sh" || {
  printf 'phasec=fail step=gateb-isolation-contract code=LEADER_SCOPE_NOT_CONSUMED\n' >&2
  failures=$((failures + 1))
}
grep -Fq 'openCodexSidecarContainerName' "${REPO_ROOT}/worker/agent/deployment/opencodex-sidecar-adapter.mjs" || {
  printf 'phasec=fail step=sidecar-name-contract code=BOUNDED_NAME_HELPER_MISSING\n' >&2
  failures=$((failures + 1))
}
grep -Fq 'sha256sum' "${REPO_ROOT}/smoke-testing/support/run-b5-gateb-smoke.sh" || {
  printf 'phasec=fail step=sidecar-name-contract code=GATEB_NAME_HASH_MISSING\n' >&2
  failures=$((failures + 1))
}

pushd "${REPO_ROOT}" >/dev/null
run_step worker-phase-c-tests "${node_bin}" --test \
  worker/test/codex-capability-cache.test.mjs \
  worker/test/codex-capability-cache-remote.test.mjs \
  worker/test/codex-capability-detection.test.mjs \
  worker/test/codex-gateway-preflight.test.mjs \
  worker/test/openclaw-preflight.test.mjs \
  worker/test/runtime-routing.test.mjs \
  worker/test/leader-role-registration.test.mjs \
  worker/test/leader-runtime-config.test.mjs \
  worker/test/member-coordination-hooks.test.mjs \
  worker/test/opencodex-sidecar-receipt-service.test.mjs \
  worker/test/opencodex-sidecar.test.mjs \
  worker/test/opencodex-sidecar-adapter.test.mjs \
  worker/test/canary-admission.test.mjs

# This deterministic contract proves that an unresolved restarted execution is
# classified as the expected RECOVERY_REQUIRED branch rather than a generic
# gate failure or fabricated success.
run_step expected-recovery-contract "${node_bin}" --test \
  worker/test/phase-b5-recovery.test.mjs

run_step app-phase-c-tests "${node_bin}" --test \
  app/test/control-api.test.mjs \
  app/test/matrix-wake-consumer.test.mjs \
  app/test/postgres-control-api.test.mjs \
  app/test/postgres-store.test.mjs \
  app/test/runtime-server.test.mjs
popd >/dev/null

if [[ "${TIANGONG_PHASE_C_REAL:-0}" == 1 ]]; then
  run_step real-agentteams-gateb bash "${REPO_ROOT}/smoke-testing/support/run-b5-gateb-smoke.sh"
else
  printf 'phasec=skip step=real-agentteams-gateb reason=explicit_opt_in_required\n'
fi

if ((failures > 0)); then
  printf 'phasec=fail failures=%s\n' "${failures}" >&2
  exit 1
fi
printf 'phasec=pass gate=deterministic-boundary\n'
