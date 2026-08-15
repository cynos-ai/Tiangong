#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

mkdir -p "${TEST_ROOT}/bin"
binding="${TEST_ROOT}/binding.json"
printf '%s\n' '{}' >"${binding}"
chmod 600 "${binding}"
cat >"${TEST_ROOT}/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}:${2:-}" in
  inspect:*)
    if [[ "$*" == *".State.Running"* ]]; then printf 'true\n'
    elif [[ "$*" == *".Name"* ]]; then printf '/leader-test\n'
    elif [[ "$*" == *".Config.Env"* ]]; then printf '%s\n' '["TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit","TIANGONG_LEADER_RUNTIME_BINDING_FILE=/run/tiangong-leader/leader-binding.json","TIANGONG_COORDINATION_CONTROL_TOKEN=test-control-token-123456"]'
    elif [[ "$*" == *".Mounts"* ]]; then printf '%s\n' '[{"Destination":"/run/tiangong-leader/leader-binding.json","RW":false}]'
    fi
    ;;
  exec:*) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/docker"

PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_LEADER_WORKER_CONTAINER=leader-test \
TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
  "${REPO_ROOT}/scripts/verify-leader-runtime-injection.sh" >"${TEST_ROOT}/pass.out"
grep -q 'leader_runtime_injection=pass' "${TEST_ROOT}/pass.out"
! grep -q 'test-control-token' "${TEST_ROOT}/pass.out"

cat >"${TEST_ROOT}/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}:${2:-}" in
  inspect:*)
    if [[ "$*" == *".State.Running"* ]]; then printf 'true\n'
    elif [[ "$*" == *".Name"* ]]; then printf '/leader-test\n'
    elif [[ "$*" == *".Config.Env"* ]]; then printf '%s\n' '["TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit","TIANGONG_LEADER_RUNTIME_BINDING_FILE=/run/tiangong-leader/leader-binding.json","TIANGONG_COORDINATION_CONTROL_TOKEN=test-control-token-123456","TIANGONG_COORDINATION_DATABASE_URL=postgres://forbidden"]'
    elif [[ "$*" == *".Mounts"* ]]; then printf '%s\n' '[{"Destination":"/run/tiangong-leader/leader-binding.json","RW":false}]'
    fi
    ;;
  exec:*) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/docker"
if PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_LEADER_WORKER_CONTAINER=leader-test \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
  TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
  "${REPO_ROOT}/scripts/verify-leader-runtime-injection.sh" >"${TEST_ROOT}/fail.out" 2>&1; then
  printf 'FAIL: Worker with a PG URL was accepted.\n' >&2
  exit 1
fi
grep -q 'WORKER_ENV_BINDING_MISMATCH' "${TEST_ROOT}/fail.out"

printf 'leader_runtime_injection_contract=pass\n'
