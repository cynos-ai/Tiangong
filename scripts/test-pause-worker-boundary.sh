#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HELPER="${REPO_ROOT}/smoke-testing/support/pause-worker-until-file.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  inspect)
    if [[ "${FAKE_BAD_IDENTITY:-0}" == "1" ]]; then
      printf '%s\n' '[{"Name":"/foreign","State":{"Running":true,"Paused":false},"Config":{"Env":["AGENTTEAMS_WORKER_NAME=foreign"]}}]'
    else
      printf '%s\n' '[{"Name":"/agentteams-test-worker","State":{"Running":true,"Paused":false},"Config":{"Env":["AGENTTEAMS_WORKER_NAME=worker-test"]}}]'
    fi
    ;;
  pause)
    printf 'paused\n' >"${FAKE_STATE}"
    : >"${FAKE_PAUSE_MARKER}"
    ;;
  unpause)
    printf 'unpaused\n' >"${FAKE_STATE}"
    ;;
  *)
    printf 'unexpected docker operation\n' >&2
    exit 1
    ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/docker"

state="${TEST_ROOT}/state"
pause_marker="${TEST_ROOT}/paused"
ready="/tmp/tiangong-smoke-pause-boundary-${RANDOM}"
export FAKE_STATE="${state}" FAKE_PAUSE_MARKER="${pause_marker}"

output="${TEST_ROOT}/pass.out"
PATH="${TEST_ROOT}/bin:${PATH}" "${HELPER}" agentteams-test-worker worker-test 10 "${ready}" >"${output}" 2>&1 &
pid=$!
for _ in {1..20}; do
  [[ -e "${pause_marker}" ]] && break
  sleep 0.1
done
[[ -e "${pause_marker}" ]] || { printf 'FAIL: helper did not pause the exact Worker.\n' >&2; exit 1; }
printf 'ready=pass\n' >"${ready}"
wait "${pid}"
grep -q 'pause_worker_until_file=pass' "${output}"
[[ "$(cat "${state}")" == "unpaused" ]] || { printf 'FAIL: helper did not unpause after readiness.\n' >&2; exit 1; }
rm -f "${ready}" "${pause_marker}"

output="${TEST_ROOT}/timeout.out"
if PATH="${TEST_ROOT}/bin:${PATH}" "${HELPER}" agentteams-test-worker worker-test 1 "${ready}" >"${output}" 2>&1; then
  printf 'FAIL: readiness timeout returned success.\n' >&2
  exit 1
fi
grep -q 'code=READINESS_TIMEOUT' "${output}"
[[ "$(cat "${state}")" == "unpaused" ]] || { printf 'FAIL: timeout path left Worker paused.\n' >&2; exit 1; }

export FAKE_BAD_IDENTITY=1
if PATH="${TEST_ROOT}/bin:${PATH}" "${HELPER}" agentteams-test-worker worker-test 1 "${ready}" >"${TEST_ROOT}/identity.out" 2>&1; then
  printf 'FAIL: helper accepted a mismatched Worker identity.\n' >&2
  exit 1
fi
grep -q 'code=WORKER_IDENTITY_MISMATCH' "${TEST_ROOT}/identity.out"

printf 'Paused Worker boundary helper tests passed.\n'
