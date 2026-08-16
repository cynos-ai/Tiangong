#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

chmod +x "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh"
bash -n "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh"
bash -n "${REPO_ROOT}/scripts/build-coordination-image.sh"

mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${FAKE_DOCKER_LOG}"
case "${1:-}:${2:-}" in
  network:inspect|image:inspect) exit 0 ;;
  container:inspect) exit 1 ;;
  exec:*) exit 0 ;;
  run:*) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/docker"

binding="${TEST_ROOT}/leader-binding.json"
env_file="${TEST_ROOT}/coordination.env"
printf '%s\n' '{}' >"${binding}"
printf '%s\n' \
  'TIANGONG_COORDINATION_DATABASE_URL=postgres://coordination.invalid/db' \
  'TIANGONG_COORDINATION_CONTROL_TOKEN=coordination-control-token-123456' \
  >"${env_file}"
chmod 600 "${binding}" "${env_file}"

output="${TEST_ROOT}/output"
FAKE_DOCKER_LOG="${TEST_ROOT}/docker.log" \
PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
TIANGONG_COORDINATION_ENV_FILE="${env_file}" \
TIANGONG_COORDINATION_IMAGE=coordination-test:dev \
TIANGONG_COORDINATION_CONTAINER=coordination-test \
  "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh" start >"${output}"

grep -q 'coordination_runtime_deployment=ready' "${output}"
grep -q -- '--read-only' "${TEST_ROOT}/docker.log"
grep -q -- '--cap-drop=ALL' "${TEST_ROOT}/docker.log"
grep -q -- '--cap-add=CHOWN' "${TEST_ROOT}/docker.log"
grep -q -- '--cap-add=DAC_OVERRIDE' "${TEST_ROOT}/docker.log"
grep -q -- '--cap-add=SETUID' "${TEST_ROOT}/docker.log"
grep -q -- '--cap-add=SETGID' "${TEST_ROOT}/docker.log"
grep -q -- '--security-opt no-new-privileges' "${TEST_ROOT}/docker.log"
grep -q -- '--env-file' "${TEST_ROOT}/docker.log"
grep -q -- 'leader-binding.json,readonly' "${TEST_ROOT}/docker.log"
if grep -q 'coordination-control-token' "${output}"; then
  printf 'FAIL: deployment diagnostic leaked a control token.\n' >&2
  exit 1
fi

output_port="${TEST_ROOT}/output-port"
FAKE_DOCKER_LOG="${TEST_ROOT}/docker-port.log" \
PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
TIANGONG_COORDINATION_ENV_FILE="${env_file}" \
TIANGONG_COORDINATION_HOST_PORT=18780 \
  "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh" start >"${output_port}"
grep -q -- '--publish 127.0.0.1:18780:8780/tcp' "${TEST_ROOT}/docker-port.log"

output_volume="${TEST_ROOT}/output-volume"
FAKE_DOCKER_LOG="${TEST_ROOT}/docker-volume.log" \
PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
TIANGONG_COORDINATION_ENV_FILE="${env_file}" \
TIANGONG_DOCKER_BINDING_VOLUME=coordination-test-binding \
  "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh" start >"${output_volume}"
grep -q -- '--mount type=volume,source=coordination-test-binding,destination=/run/tiangong-coordination,readonly' "${TEST_ROOT}/docker-volume.log"
if grep -q -- 'leader-binding.json,readonly' "${TEST_ROOT}/docker-volume.log"; then
  printf 'FAIL: volume deployment unexpectedly used a host binding.\n' >&2
  exit 1
fi

if FAKE_DOCKER_LOG="${TEST_ROOT}/docker-invalid-port.log" \
  PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
  TIANGONG_COORDINATION_ENV_FILE="${env_file}" \
  TIANGONG_COORDINATION_HOST_PORT=70000 \
  "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh" start >"${TEST_ROOT}/invalid-port.out" 2>&1; then
  printf 'FAIL: invalid host port was accepted.\n' >&2
  exit 1
fi
grep -q 'INVALID_HOST_PORT' "${TEST_ROOT}/invalid-port.out"

printf '%s\n' 'NODE_ENV=production' >>"${env_file}"
if FAKE_DOCKER_LOG="${TEST_ROOT}/docker-reserved.log" \
  PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
  TIANGONG_COORDINATION_ENV_FILE="${env_file}" \
  "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh" start >"${TEST_ROOT}/reserved.out" 2>&1; then
  printf 'FAIL: reserved environment key was accepted.\n' >&2
  exit 1
fi
grep -q 'RESERVED_ENVIRONMENT_KEY' "${TEST_ROOT}/reserved.out"

sed -i 's/^NODE_ENV=production$/TIANGONG_UNSUPPORTED_SECRET=should-not-run/' "${env_file}"
if FAKE_DOCKER_LOG="${TEST_ROOT}/docker-unsupported.log" \
  PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
  TIANGONG_COORDINATION_ENV_FILE="${env_file}" \
  "${REPO_ROOT}/scripts/deploy-coordination-runtime.sh" start >"${TEST_ROOT}/unsupported.out" 2>&1; then
  printf 'FAIL: unsupported environment key was accepted.\n' >&2
  exit 1
fi
grep -q 'UNSUPPORTED_ENVIRONMENT_KEY' "${TEST_ROOT}/unsupported.out"

printf 'coordination_runtime_deployment_contract=pass\n'
