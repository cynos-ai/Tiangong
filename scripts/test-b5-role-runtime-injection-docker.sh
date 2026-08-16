#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/inspect.json" <<'JSON'
[
  {
    "State": {"Running": true},
    "Name": "/worker-test",
    "Config": {
      "Image": "tiangong-worker-implementor:dev",
      "Entrypoint": ["/usr/bin/node"],
      "Cmd": ["/opt/tiangong-worker/agent/deployment/service.mjs"],
      "WorkingDir": "/root/agentteams-fs/agents/worker-test",
      "User": "",
      "Env": [
        "AGENTTEAMS_WORKER_NAME=worker-test",
        "AGENTTEAMS_WORKER_GATEWAY_KEY=secret-must-not-print",
        "TIANGONG_ROLE_ID=stale",
        "TIANGONG_CODEX_RUNTIME=0",
        "OPENCLAW_AGENT_RUNTIME=tiangong-pi"
      ],
      "Labels": {"example.label": "value"},
      "ExposedPorts": {"8088/tcp": {}}
    },
    "HostConfig": {
      "NetworkMode": "agentteams-net",
      "Privileged": false,
      "ReadonlyRootfs": false,
      "CapAdd": [],
      "CapDrop": ["ALL"],
      "SecurityOpt": ["no-new-privileges:true"],
      "Init": true,
      "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
      "Binds": ["worker-test-auth:/var/run/secrets/agentteams"],
      "Mounts": [{"Type":"volume","Name":"worker-test-auth","Target":"/var/run/secrets/agentteams","RW":true}],
      "Devices": [],
      "PortBindings": {"8088/tcp": [{"HostIp": "", "HostPort": "18818"}]},
      "ExtraHosts": ["host.docker.internal:host-gateway"],
      "ShmSize": 67108864
    }
  }
]
JSON

cat >"${TEST_ROOT}/bin/docker" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
root="${TIANGONG_B5_INJECTION_TEST_ROOT:?}"
case "${1:-}:${2:-}" in
  inspect:*) cat "${root}/inspect.json" ;;
  container:inspect) exit 0 ;;
  rename:*) exit 0 ;;
  stop:*) exit 0 ;;
  run:*)
    printf '%s\n' "$*" >"${root}/run.args"
    args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
      if [[ "${args[i]}" == --env-file ]]; then
        env_path="${args[i+1]}"
        if [[ "${env_path}" == \\wsl.localhost\\* ]] && command -v wslpath >/dev/null 2>&1; then
          env_path="$(wslpath -u "${env_path}")"
        fi
        cp "${env_path}" "${root}/env"
      fi
    done
    ;;
  exec:*)
    grep -Fq "TIANGONG_ROLE_ID=${TIANGONG_B5_EXPECTED_ROLE}" "${root}/env"
    grep -Fq 'TIANGONG_RUNTIME_ROLE_ROUTING_REQUIRED=1' "${root}/env"
    grep -Fq 'OPENCLAW_AGENT_HARNESS_FALLBACK=none' "${root}/env"
    ;;
  rm:*) exit 0 ;;
  *) printf 'unexpected docker call: %s\n' "$*" >&2; exit 1 ;;
esac
SH
chmod 755 "${TEST_ROOT}/bin/docker"
cat >"${TEST_ROOT}/bin/wslpath" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${2:-}"
SH
chmod 755 "${TEST_ROOT}/bin/wslpath"

output="${TEST_ROOT}/output"
PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_B5_INJECTION_TEST_ROOT="${TEST_ROOT}" \
TIANGONG_B5_EXPECTED_ROLE=leader \
TIANGONG_B5_WORKER_CONTAINER=worker-test \
TIANGONG_B5_ROLE_ID=leader \
TIANGONG_B5_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
TIANGONG_B5_COORDINATION_CONTROL_TOKEN=test-control-token-123456 \
  "${SCRIPT_DIR}/inject-b5-role-runtime-docker.sh" >"${output}"

grep -Fq 'b5_role_runtime_injection=pass container=worker-test role=leader runtime=openclaw-built-in' "${output}"
grep -Fq -- '--volume worker-test-auth:/var/run/secrets/agentteams' "${TEST_ROOT}/run.args"
grep -Fq -- '--publish 18818:8088/tcp' "${TEST_ROOT}/run.args"
grep -Fq -- '--cap-drop ALL' "${TEST_ROOT}/run.args"
grep -Fq -- '--security-opt no-new-privileges:true' "${TEST_ROOT}/run.args"
grep -Fq -- '--init' "${TEST_ROOT}/run.args"
grep -Fq -- '--restart unless-stopped' "${TEST_ROOT}/run.args"
grep -Fq 'TIANGONG_ROLE_ID=leader' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_CODEX_RUNTIME=0' "${TEST_ROOT}/env"
grep -Fq 'OPENCLAW_AGENT_RUNTIME=pi' "${TEST_ROOT}/env"
grep -Fq 'CODEX_HOME=/root/.codex' "${TEST_ROOT}/env"
grep -Fq 'OPENCLAW_CODEX_DISCOVERY_LIVE=0' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_MEMBER_ID=worker-test' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_MEMBER_COORDINATION_ENABLED=0' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit' "${TEST_ROOT}/env"
! grep -Fq 'secret-must-not-print' "${output}"
! grep -Fq 'secret-must-not-print' "${TEST_ROOT}/run.args"

output="${TEST_ROOT}/implementor-output"
PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_B5_INJECTION_TEST_ROOT="${TEST_ROOT}" \
TIANGONG_B5_EXPECTED_ROLE=implementor \
TIANGONG_B5_WORKER_CONTAINER=worker-test \
TIANGONG_B5_ROLE_ID=implementor \
TIANGONG_B5_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
TIANGONG_B5_COORDINATION_CONTROL_TOKEN=test-control-token-123456 \
  "${SCRIPT_DIR}/inject-b5-role-runtime-docker.sh" >"${output}"
grep -Fq 'runtime=codex-app-server' "${output}"
grep -Fq 'TIANGONG_RUNTIME_LANE=openclaw-canary' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_CODEX_RUNTIME=1' "${TEST_ROOT}/env"
grep -Fq 'OPENCLAW_AGENT_RUNTIME=codex' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_CODEX_CAPABILITY_CACHE_SHARED=1' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_CODEX_CAPABILITY_CACHE_URL=http://tiangong-codex-capability-cache:8788' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_CODEX_MODEL=deepseek-v4-flash' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_MEMBER_ID=worker-test' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_MEMBER_COORDINATION_ENABLED=1' "${TEST_ROOT}/env"

if PATH="${TEST_ROOT}/bin:${PATH}" TIANGONG_B5_WORKER_CONTAINER=worker-test TIANGONG_B5_ROLE_ID=unknown \
  "${SCRIPT_DIR}/inject-b5-role-runtime-docker.sh" >"${TEST_ROOT}/invalid.out" 2>&1; then
  printf 'expected invalid role rejection\n' >&2
  exit 1
fi
grep -Fq 'code=ROLE_INVALID' "${TEST_ROOT}/invalid.out"

printf 'b5_role_runtime_injection_docker_contract=pass\n'
