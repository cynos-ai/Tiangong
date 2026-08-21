#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

chmod +x "${REPO_ROOT}/scripts/build-agentloop-query-adapter-image.sh" "${REPO_ROOT}/scripts/deploy-agentloop-query-adapter.sh"
bash -n "${REPO_ROOT}/scripts/build-agentloop-query-adapter-image.sh"
bash -n "${REPO_ROOT}/scripts/deploy-agentloop-query-adapter.sh"
python3 -m py_compile "${REPO_ROOT}/agentloop_query_adapter/core.py" "${REPO_ROOT}/agentloop_query_adapter/server.py"

mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${FAKE_DOCKER_LOG}"
if [[ "${FAKE_DOCKER_MODE:-start}" == start ]]; then
  case "${1:-}:${2:-}" in
    info:*) exit 0 ;;
    image:inspect)
      if [[ "$*" == *"--format"* ]]; then printf 'sha256:fake-image\n'; fi
      exit 0
      ;;
    network:inspect|container:inspect) exit 1 ;;
    network:create|run:*|exec:*) exit 0 ;;
    *) exit 0 ;;
  esac
fi
case "${1:-}:${2:-}" in
  info:*) exit 0 ;;
  container:inspect)
    case "$*" in
      *tiangong-coordination-runtime*) exit 1 ;;
      *io.tiangong.owner*) printf 'tiangong-deployment\n' ;;
      *io.tiangong.component*) printf 'agentloop-query-adapter\n' ;;
      *State.Running*) printf 'true\n' ;;
      *) ;;
    esac
    exit 0
    ;;
  network:inspect)
    case "$*" in
      *io.tiangong.owner*) printf 'tiangong-deployment\n' ;;
      *io.tiangong.component*) printf 'agentloop-diagnostics-network\n' ;;
      *'len .Containers'*) printf '0\n' ;;
      *) ;;
    esac
    exit 0
    ;;
  container:rm|network:rm) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/docker"

secret="${TEST_ROOT}/aliyun-readonly.env"
printf '%s\n' \
  'ALIBABA_CLOUD_ACCESS_KEY_ID=synthetic-deployment-key-id' \
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET=synthetic-deployment-key-secret' \
  >"${secret}"
chmod 600 "${secret}"

common_env=(
  "PATH=${TEST_ROOT}/bin:${PATH}"
  "TIANGONG_AGENTLOOP_QUERY_SECRET_FILE=${secret}"
  'TIANGONG_AGENTLOOP_QUERY_ENDPOINT=https://proj-test.cn-hangzhou.log.aliyuncs.com'
  'TIANGONG_AGENTLOOP_QUERY_PROJECT=proj-test'
  'TIANGONG_AGENTLOOP_QUERY_SERVICES=service-a,service-b'
  'TIANGONG_AGENTLOOP_QUERY_ENVIRONMENT=isolated-test'
)

env "${common_env[@]}" FAKE_DOCKER_LOG="${TEST_ROOT}/docker-start.log" \
  "${REPO_ROOT}/scripts/deploy-agentloop-query-adapter.sh" start >"${TEST_ROOT}/start.out"
grep -q 'agentloop_query_adapter_deployment=ready' "${TEST_ROOT}/start.out"
grep -q -- 'network create --label io.tiangong.owner=tiangong-deployment' "${TEST_ROOT}/docker-start.log"
grep -q -- '--network-alias agentloop-query-adapter' "${TEST_ROOT}/docker-start.log"
grep -q -- '--mount type=bind,' "${TEST_ROOT}/docker-start.log"
grep -q -- 'dst=/run/secrets/aliyun-readonly.env,readonly' "${TEST_ROOT}/docker-start.log"
grep -q -- '--read-only' "${TEST_ROOT}/docker-start.log"
grep -q -- '--cap-drop=ALL' "${TEST_ROOT}/docker-start.log"
grep -q -- '--security-opt no-new-privileges' "${TEST_ROOT}/docker-start.log"
grep -q -- '--pids-limit 64' "${TEST_ROOT}/docker-start.log"
grep -q -- '--memory 192m' "${TEST_ROOT}/docker-start.log"
grep -q -- '--cpus 0.5' "${TEST_ROOT}/docker-start.log"
if grep -Eq 'synthetic-deployment-key-(id|secret)' "${TEST_ROOT}/start.out"; then
  printf 'FAIL: query credential leaked to deployment output.\n' >&2
  exit 1
fi
if grep -Eq 'synthetic-deployment-key-(id|secret)' "${TEST_ROOT}/docker-start.log"; then
  printf 'FAIL: query credential was passed through Docker arguments or environment.\n' >&2
  exit 1
fi

env "${common_env[@]}" FAKE_DOCKER_MODE=stop FAKE_DOCKER_LOG="${TEST_ROOT}/docker-stop.log" \
  "${REPO_ROOT}/scripts/deploy-agentloop-query-adapter.sh" stop >"${TEST_ROOT}/stop.out"
grep -q 'agentloop_query_adapter_deployment=stopped' "${TEST_ROOT}/stop.out"
grep -q 'container rm -f tiangong-agentloop-query-adapter' "${TEST_ROOT}/docker-stop.log"
grep -q 'network rm tiangong-agentloop-diagnostics' "${TEST_ROOT}/docker-stop.log"

chmod 640 "${secret}"
if env "${common_env[@]}" FAKE_DOCKER_LOG="${TEST_ROOT}/docker-unsafe.log" \
  "${REPO_ROOT}/scripts/deploy-agentloop-query-adapter.sh" start >"${TEST_ROOT}/unsafe.out" 2>&1; then
  printf 'FAIL: broad query secret mode was accepted.\n' >&2
  exit 1
fi
grep -q 'QUERY_CONFIGURATION_INVALID' "${TEST_ROOT}/unsafe.out"
chmod 600 "${secret}"

if env "${common_env[@]}" TIANGONG_AGENTLOOP_QUERY_ENDPOINT=https://evil.example.test \
  FAKE_DOCKER_LOG="${TEST_ROOT}/docker-target.log" \
  "${REPO_ROOT}/scripts/deploy-agentloop-query-adapter.sh" start >"${TEST_ROOT}/target.out" 2>&1; then
  printf 'FAIL: invalid SLS target was accepted.\n' >&2
  exit 1
fi
grep -q 'QUERY_CONFIGURATION_INVALID' "${TEST_ROOT}/target.out"

printf 'agentloop_query_adapter_deployment_contract=pass\n'
