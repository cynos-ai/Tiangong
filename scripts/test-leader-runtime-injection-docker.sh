#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

mkdir -p "${TEST_ROOT}/bin"
binding="${TEST_ROOT}/binding.json"
printf '{}\n' >"${binding}"
chmod 600 "${binding}"

cat >"${TEST_ROOT}/inspect.json" <<'JSON'
[
  {
    "State": {"Running": true},
    "Name": "/leader-test",
    "Config": {
      "Image": "tiangong-worker-leader:dev",
      "Entrypoint": ["/opt/agentteams/scripts/worker-entrypoint.sh"],
      "Cmd": [],
      "WorkingDir": "/root/agentteams-fs/agents/leader-test",
      "User": "",
      "Env": ["EXAMPLE_ENV=value"],
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
      "Binds": ["leader-test-auth:/var/run/secrets/agentteams"],
      "Mounts": [],
      "Devices": [],
      "PortBindings": {"8088/tcp": [{"HostIp": "", "HostPort": "18818"}]},
      "ExtraHosts": ["host.docker.internal:host-gateway"],
      "ShmSize": 67108864
    }
  }
]
JSON

jq '. [0].HostConfig.Memory = 1048576' "${TEST_ROOT}/inspect.json" >"${TEST_ROOT}/inspect-limited.json"

cat >"${TEST_ROOT}/inspect-volume.json" <<'JSON'
[
  {
    "State": {"Running": true},
    "Name": "/leader-test",
    "Config": {
      "Image": "tiangong-worker-leader:dev",
      "Entrypoint": ["/opt/agentteams/scripts/worker-entrypoint.sh"],
      "Cmd": [],
      "WorkingDir": "/root/agentteams-fs/agents/leader-test",
      "User": "",
      "Env": ["EXAMPLE_ENV=value"],
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
      "Binds": null,
      "Mounts": [
        {"Type": "volume", "Source": "leader-test-auth", "Target": "/var/run/secrets/agentteams"},
        {"Type": "volume", "Source": "leader-test-binding", "Target": "/run/tiangong-leader", "ReadOnly": true}
      ],
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
root="${TIANGONG_INJECTION_TEST_ROOT:?}"
case "${1:-}:${2:-}" in
  inspect:-f)
    format="${3:-}"
    case "${format}" in
      *State.Running*) printf 'true\n' ;;
      *.Name*) printf '/leader-test\n' ;;
      *Config.Env*) printf '%s\n' '["TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit","TIANGONG_LEADER_RUNTIME_BINDING_FILE=/run/tiangong-leader/leader-binding.json","TIANGONG_COORDINATION_CONTROL_TOKEN=test-control-token-123456"]' ;;
      *Mounts*)
        if [[ "${TIANGONG_INJECTION_TEST_VOLUME:-0}" == 1 ]]; then
          printf '%s\n' '[{"Type":"volume","Name":"leader-test-binding","Destination":"/run/tiangong-leader","RW":false}]'
        else
          printf '%s\n' '[{"Destination":"/run/tiangong-leader/leader-binding.json","RW":false}]'
        fi
        ;;
    esac
    ;;
  inspect:*)
    if [[ "${TIANGONG_INJECTION_TEST_RESOURCE:-0}" == 1 ]]; then
      cat "${root}/inspect-limited.json"
    elif [[ "${TIANGONG_INJECTION_TEST_VOLUME:-0}" == 1 ]]; then
      cat "${root}/inspect-volume.json"
    else
      cat "${root}/inspect.json"
    fi
    ;;
  volume:inspect) exit 0 ;;
  container:inspect) exit 0 ;;
  exec:*) exit 0 ;;
  rename:*) exit 0 ;;
  stop:*) exit 0 ;;
  run:*) printf '%s\n' "$*" >"${root}/run.args" ;;
  rm:*) exit 0 ;;
  *) printf 'unexpected docker call: %s\n' "$*" >&2; exit 1 ;;
esac
SH
chmod 755 "${TEST_ROOT}/bin/docker"

output="${TEST_ROOT}/output"
PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_INJECTION_TEST_ROOT="${TEST_ROOT}" \
TIANGONG_LEADER_WORKER_CONTAINER=leader-test \
TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
TIANGONG_COORDINATION_CONTROL_TOKEN=test-control-token-123456 \
  "${SCRIPT_DIR}/inject-leader-runtime-docker.sh" >"${output}"

grep -Fq 'leader_runtime_injection=pass container=leader-test' "${output}"
grep -Fq -- '--mount type=bind,src=' "${TEST_ROOT}/run.args"
grep -Fq 'dst=/run/tiangong-leader/leader-binding.json,readonly' "${TEST_ROOT}/run.args"
grep -Fq -- '--publish 18818:8088/tcp' "${TEST_ROOT}/run.args"
grep -Fq -- '--add-host host.docker.internal:host-gateway' "${TEST_ROOT}/run.args"
grep -Fq -- '--cap-drop ALL' "${TEST_ROOT}/run.args"
grep -Fq -- '--security-opt no-new-privileges:true' "${TEST_ROOT}/run.args"
grep -Fq -- '--init' "${TEST_ROOT}/run.args"
grep -Fq -- '--restart unless-stopped' "${TEST_ROOT}/run.args"
! grep -Fq 'test-control-token-123456' "${output}"

if PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_INJECTION_TEST_ROOT="${TEST_ROOT}" \
  TIANGONG_INJECTION_TEST_RESOURCE=1 \
  TIANGONG_LEADER_WORKER_CONTAINER=leader-test \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
  TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
  TIANGONG_COORDINATION_CONTROL_TOKEN=test-control-token-123456 \
    "${SCRIPT_DIR}/inject-leader-runtime-docker.sh" >"${TEST_ROOT}/resource-output" 2>&1; then
  printf 'expected resource-limit rejection\n' >&2
  exit 1
fi
grep -Fq 'code=UNSUPPORTED_RESOURCE_LIMIT' "${TEST_ROOT}/resource-output"

volume_output="${TEST_ROOT}/volume-output"
PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_INJECTION_TEST_ROOT="${TEST_ROOT}" \
TIANGONG_INJECTION_TEST_VOLUME=1 \
TIANGONG_LEADER_INJECTION_ROTATE=1 \
TIANGONG_DOCKER_BINDING_VOLUME=leader-test-binding \
TIANGONG_LEADER_WORKER_CONTAINER=leader-test \
TIANGONG_LEADER_RUNTIME_BINDING_FILE="${binding}" \
TIANGONG_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
TIANGONG_COORDINATION_CONTROL_TOKEN=test-control-token-123456 \
  "${SCRIPT_DIR}/inject-leader-runtime-docker.sh" >"${volume_output}"
grep -Fq 'leader_runtime_injection=pass container=leader-test' "${volume_output}"
grep -Fq 'source=leader-test-binding,destination=/run/tiangong-leader,readonly' "${TEST_ROOT}/run.args"
! grep -Fq 'test-control-token-123456' "${volume_output}"

printf 'leader_runtime_injection_docker_contract=pass\n'
