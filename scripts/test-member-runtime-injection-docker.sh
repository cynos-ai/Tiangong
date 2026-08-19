#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM
mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/inspect.json" <<'JSON'
[{"State":{"Running":true},"Name":"/worker-test","Config":{"Image":"tg-worker:dev","Entrypoint":["/usr/bin/node"],"Cmd":["service.mjs"],"WorkingDir":"/root/agentteams-fs/agents/worker-test","User":"","Env":["AGENTTEAMS_WORKER_NAME=worker-test","AGENTTEAMS_WORKER_GATEWAY_KEY=must-not-print","TIANGONG_ROLE_ID=stale"],"Labels":{},"ExposedPorts":{"8088/tcp":{}}},"HostConfig":{"NetworkMode":"agentteams-net","Privileged":false,"ReadonlyRootfs":false,"CapAdd":[],"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges:true"],"Init":true,"RestartPolicy":{"Name":"unless-stopped","MaximumRetryCount":0},"Binds":["worker-test-auth:/var/run/secrets/agentteams"],"Mounts":[{"Type":"volume","Name":"worker-test-auth","Target":"/var/run/secrets/agentteams","RW":true}],"Devices":[],"PortBindings":{"8088/tcp":[{"HostIp":"","HostPort":"18818"}]},"ExtraHosts":[],"ShmSize":67108864}}]
JSON
cat >"${TEST_ROOT}/bin/docker" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
root="${TIANGONG_MEMBER_INJECTION_TEST_ROOT:?}"
case "${1:-}:${2:-}" in
  inspect:*) cat "${root}/inspect.json" ;;
  container:inspect|rename:*|stop:*|rm:*) exit 0 ;;
  run:*)
    printf '%s\n' "$*" >"${root}/run.args"; args=("$@")
    for ((i=0;i<${#args[@]};i++)); do
      if [[ "${args[i]}" == --env-file ]]; then cp "${args[i+1]}" "${root}/env"; fi
    done ;;
  exec:*)
    grep -Fq "TIANGONG_MEMBER_RESPONSIBILITY=${TIANGONG_EXPECTED_RESPONSIBILITY}" "${root}/env"
    grep -Fq "TIANGONG_MEMBER_RUNTIME=${TIANGONG_EXPECTED_RUNTIME}" "${root}/env"
    grep -Fq "TIANGONG_MEMBER_MODEL=${TIANGONG_EXPECTED_MODEL}" "${root}/env"
    grep -Fq 'TIANGONG_MEMBER_RUNTIME_ROUTING_REQUIRED=1' "${root}/env" ;;
  *) printf 'unexpected docker call: %s\n' "$*" >&2; exit 1 ;;
esac
SH
chmod 755 "${TEST_ROOT}/bin/docker"

run_case() {
  local responsibility="$1" runtime="$2" model="$3" output
  output="${TEST_ROOT}/${responsibility}.out"
  PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_MEMBER_INJECTION_TEST_ROOT="${TEST_ROOT}" \
  TIANGONG_EXPECTED_RESPONSIBILITY="${responsibility}" TIANGONG_EXPECTED_RUNTIME="${runtime}" TIANGONG_EXPECTED_MODEL="${model}" \
  TIANGONG_MEMBER_WORKER_CONTAINER=worker-test TIANGONG_MEMBER_RESPONSIBILITY="${responsibility}" \
  TIANGONG_MEMBER_RUNTIME="${runtime}" TIANGONG_MEMBER_MODEL="${model}" \
  TIANGONG_MEMBER_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
  TIANGONG_MEMBER_COORDINATION_CONTROL_TOKEN=test-control-token-123456 \
    bash "${SCRIPT_DIR}/inject-member-runtime-docker.sh" >"${output}"
  grep -Fq "member_runtime_injection=pass container=worker-test responsibility=${responsibility} runtime=${runtime} model=${model}" "${output}"
  if grep -Fq must-not-print "${output}" || grep -Fq must-not-print "${TEST_ROOT}/run.args"; then printf 'secret leaked\n' >&2; exit 1; fi
}

run_case leader openclaw-built-in deepseek-chat
grep -Fq 'TIANGONG_CODEX_RUNTIME=0' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_MEMBER_COORDINATION_ENABLED=0' "${TEST_ROOT}/env"
run_case developer codex-app-server deepseek-v4-flash
grep -Fq 'TIANGONG_CODEX_RUNTIME=1' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_CODEX_MODEL=deepseek-v4-flash' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_CODEX_CAPABILITY_CACHE_URL=http://tg-codex-capability-cache:8788' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_MEMBER_COORDINATION_ENABLED=1' "${TEST_ROOT}/env"
grep -Fq -- '--volume worker-test-auth:/var/run/secrets/agentteams' "${TEST_ROOT}/run.args"
grep -Fq -- '--cap-drop ALL' "${TEST_ROOT}/run.args"

if PATH="${TEST_ROOT}/bin:${PATH}" TIANGONG_MEMBER_WORKER_CONTAINER=worker-test TIANGONG_MEMBER_RESPONSIBILITY=leader TIANGONG_MEMBER_RUNTIME=codex-app-server TIANGONG_MEMBER_MODEL=deepseek-v4-flash bash "${SCRIPT_DIR}/inject-member-runtime-docker.sh" >"${TEST_ROOT}/invalid.out" 2>&1; then
  printf 'expected responsibility/runtime mismatch\n' >&2; exit 1
fi
grep -Fq 'code=RUNTIME_RESPONSIBILITY_MISMATCH' "${TEST_ROOT}/invalid.out"
printf 'member_runtime_injection_docker_contract=pass\n'
