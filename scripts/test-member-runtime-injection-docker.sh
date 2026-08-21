#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM
mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/inspect.json" <<'JSON'
[{"State":{"Running":true},"Name":"/worker-test","Config":{"Image":"tg-worker:dev","Entrypoint":["/usr/bin/node"],"Cmd":["service.mjs"],"WorkingDir":"/root/agentteams-fs/agents/worker-test","User":"","Env":["AGENTTEAMS_WORKER_NAME=worker-test","AGENTTEAMS_WORKER_GATEWAY_KEY=must-not-print","TIANGONG_ROLE_ID=stale","TIANGONG_MEMBER_OBSOLETE=stale","ARMS_LICENSE_KEY=must-not-survive","OTEL_EXPORTER_OTLP_HEADERS=must-not-survive"],"Labels":{},"ExposedPorts":{"8088/tcp":{}}},"HostConfig":{"NetworkMode":"agentteams-net","Privileged":false,"ReadonlyRootfs":false,"CapAdd":[],"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges:true"],"Init":true,"RestartPolicy":{"Name":"unless-stopped","MaximumRetryCount":0},"Binds":["worker-test-auth:/var/run/secrets/agentteams"],"Mounts":[{"Type":"volume","Name":"worker-test-auth","Target":"/var/run/secrets/agentteams","RW":true}],"Devices":[],"PortBindings":{"8088/tcp":[{"HostIp":"","HostPort":"18818"}]},"ExtraHosts":[],"ShmSize":67108864}}]
JSON
cat >"${TEST_ROOT}/bin/docker" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
root="${TIANGONG_MEMBER_INJECTION_TEST_ROOT:?}"
case "${1:-}:${2:-}" in
  inspect:*) jq --arg model "${TIANGONG_EXPECTED_MODEL}" '.[0].Config.Env += ["AGENTTEAMS_MODEL=" + $model]' "${root}/inspect.json" ;;
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
    grep -Fq 'TIANGONG_MEMBER_REVISION=2' "${root}/env"
    grep -Fq "TIANGONG_MEMBER_AGENT_PACKAGE_ID=tiangong-${TIANGONG_EXPECTED_RESPONSIBILITY}" "${root}/env"
    grep -Fq 'TIANGONG_MEMBER_AGENT_PACKAGE_VERSION=1.0.0' "${root}/env"
    grep -Fq "TIANGONG_MEMBER_ALLOWED_SKILLS=${TIANGONG_EXPECTED_SKILLS}" "${root}/env"
    grep -Fq 'TIANGONG_MEMBER_RUNTIME_ROUTING_REQUIRED=1' "${root}/env"
    grep -Fq 'TIANGONG_AGENTLOOP_ENABLED=' "${root}/env"
    ! grep -Eq 'TIANGONG_MEMBER_OBSOLETE=|ARMS_LICENSE_KEY=|OTEL_EXPORTER_OTLP_HEADERS=' "${root}/env" ;;
  *) printf 'unexpected docker call: %s\n' "$*" >&2; exit 1 ;;
esac
SH
chmod 755 "${TEST_ROOT}/bin/docker"

run_case() {
  local responsibility="$1" runtime="$2" model="$3" skills="$4" output
  output="${TEST_ROOT}/${responsibility}.out"
  PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_MEMBER_INJECTION_TEST_ROOT="${TEST_ROOT}" \
  TIANGONG_EXPECTED_RESPONSIBILITY="${responsibility}" TIANGONG_EXPECTED_RUNTIME="${runtime}" TIANGONG_EXPECTED_MODEL="${model}" \
  TIANGONG_EXPECTED_SKILLS="${skills}" \
  TIANGONG_MEMBER_WORKER_CONTAINER=worker-test TIANGONG_MEMBER_RESPONSIBILITY="${responsibility}" \
  TIANGONG_MEMBER_RUNTIME="${runtime}" TIANGONG_MEMBER_MODEL="${model}" TIANGONG_MEMBER_REVISION=2 \
  TIANGONG_MEMBER_AGENT_PACKAGE_ID="tiangong-${responsibility}" TIANGONG_MEMBER_AGENT_PACKAGE_VERSION=1.0.0 \
  TIANGONG_MEMBER_ALLOWED_SKILLS="${skills}" \
  TIANGONG_MEMBER_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit \
  TIANGONG_MEMBER_COORDINATION_CONTROL_TOKEN=test-control-token-123456 \
    bash "${SCRIPT_DIR}/inject-member-runtime-docker.sh" >"${output}"
  grep -Fq "member_runtime_injection=pass container=worker-test responsibility=${responsibility} runtime=${runtime} model=${model} revision=2 agent_package=tiangong-${responsibility}@1.0.0" "${output}"
  if grep -Fq must-not-print "${output}" || grep -Fq must-not-print "${TEST_ROOT}/run.args"; then printf 'secret leaked\n' >&2; exit 1; fi
}

run_case leader openclaw-built-in glm-5 work-coordination,work-planning
if grep -Eq 'TIANGONG_(CODEX|CANARY)|CODEX_HOME|OPENCLAW_CODEX' "${TEST_ROOT}/env"; then printf 'obsolete runtime environment was injected\n' >&2; exit 1; fi
grep -Fq 'TIANGONG_MEMBER_COORDINATION_ENABLED=0' "${TEST_ROOT}/env"
run_case architect openclaw-built-in glm-5 work-planning,plan-challenge
run_case challenger openclaw-built-in glm-5 plan-challenge
run_case reviewer openclaw-built-in glm-5 independent-code-review
run_case reviewer openclaw-built-in qwen3.7-plus independent-code-review
run_case tester openclaw-built-in glm-5 scenario-testing
TIANGONG_AGENTLOOP_ENABLED=1 TIANGONG_AGENTLOOP_CONTENT_CAPTURE=isolated-test TIANGONG_AGENTLOOP_SERVICE_NAME=tiangong-m8-test run_case tester openclaw-built-in glm-5 scenario-testing
grep -Fq 'TIANGONG_AGENTLOOP_ENABLED=1' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_AGENTLOOP_CONTENT_CAPTURE=isolated-test' "${TEST_ROOT}/env"
grep -Fq 'TIANGONG_AGENTLOOP_SERVICE_NAME=tiangong-m8-test' "${TEST_ROOT}/env"
run_case developer openclaw-built-in glm-5 test-driven-development,independent-code-review,scenario-testing
if grep -Eq 'TIANGONG_(CODEX|CANARY)|CODEX_HOME|OPENCLAW_CODEX' "${TEST_ROOT}/env"; then printf 'obsolete runtime environment was injected\n' >&2; exit 1; fi
grep -Fq 'TIANGONG_MEMBER_COORDINATION_ENABLED=1' "${TEST_ROOT}/env"
grep -Fq -- '--volume worker-test-auth:/var/run/secrets/agentteams' "${TEST_ROOT}/run.args"
grep -Fq -- '--cap-drop ALL' "${TEST_ROOT}/run.args"

if PATH="${TEST_ROOT}/bin:${PATH}" TIANGONG_MEMBER_INJECTION_TEST_ROOT="${TEST_ROOT}" TIANGONG_EXPECTED_MODEL=glm-5 TIANGONG_MEMBER_WORKER_CONTAINER=worker-test TIANGONG_MEMBER_RESPONSIBILITY=leader TIANGONG_MEMBER_RUNTIME=removed-runtime TIANGONG_MEMBER_MODEL=glm-5 TIANGONG_MEMBER_REVISION=2 TIANGONG_MEMBER_AGENT_PACKAGE_ID=tiangong-leader TIANGONG_MEMBER_AGENT_PACKAGE_VERSION=1.0.0 TIANGONG_MEMBER_ALLOWED_SKILLS=work-coordination bash "${SCRIPT_DIR}/inject-member-runtime-docker.sh" >"${TEST_ROOT}/invalid.out" 2>&1; then
  printf 'expected unsupported runtime\n' >&2; exit 1
fi
grep -Fq 'code=MEMBER_RUNTIME_INVALID' "${TEST_ROOT}/invalid.out"

if PATH="${TEST_ROOT}/bin:${PATH}" TIANGONG_MEMBER_INJECTION_TEST_ROOT="${TEST_ROOT}" TIANGONG_EXPECTED_MODEL=other-model TIANGONG_MEMBER_WORKER_CONTAINER=worker-test TIANGONG_MEMBER_RESPONSIBILITY=leader TIANGONG_MEMBER_RUNTIME=openclaw-built-in TIANGONG_MEMBER_MODEL=glm-5 TIANGONG_MEMBER_REVISION=2 TIANGONG_MEMBER_AGENT_PACKAGE_ID=tiangong-leader TIANGONG_MEMBER_AGENT_PACKAGE_VERSION=1.0.0 TIANGONG_MEMBER_ALLOWED_SKILLS=work-coordination TIANGONG_MEMBER_COORDINATION_CONTROL_ENDPOINT=http://coordination-runtime:8780/v1/coordination/admit TIANGONG_MEMBER_COORDINATION_CONTROL_TOKEN=test-control-token-123456 bash "${SCRIPT_DIR}/inject-member-runtime-docker.sh" >"${TEST_ROOT}/model-mismatch.out" 2>&1; then
  printf 'expected AgentTeams model mismatch\n' >&2; exit 1
fi
grep -Fq 'code=AGENTTEAMS_MODEL_MISMATCH' "${TEST_ROOT}/model-mismatch.out" || { cat "${TEST_ROOT}/model-mismatch.out" >&2; exit 1; }
printf 'member_runtime_injection_docker_contract=pass\n'
