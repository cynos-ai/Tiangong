#!/usr/bin/env bash
set -Eeuo pipefail

# Gate B deployment driver. It reuses the reviewed Leader smoke oracle, while
# adding B5 role routes and the native Leader binding before Matrix turns.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly TEAM_NAME="tiangong-leader-smoke"
readonly LEADER_NAME="tiangong-leader-smoke-leader"
readonly DESIGNER_NAME="tiangong-leader-smoke-designer"
readonly IMPLEMENTOR_NAME="tiangong-leader-smoke-implementor"
readonly ASSESSOR_NAME="tiangong-leader-smoke-assessor"
readonly OPERATOR_NAME="tiangong-leader-smoke-operator"
readonly TURN_CONTAINER="agentteams-worker-${DESIGNER_NAME}"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly DRIVER="${SCRIPT_DIR}/run-leader-smoke.sh"
readonly DEPLOY_COORDINATION="${REPO_ROOT}/scripts/deploy-coordination-runtime.sh"
readonly INJECT_ROLE="${REPO_ROOT}/scripts/inject-b5-role-runtime-docker.sh"
readonly INJECT_LEADER="${REPO_ROOT}/scripts/inject-leader-runtime-docker.sh"
readonly RUNNER_BROKER_SCRIPT="${REPO_ROOT}/scripts/runner-broker.sh"
readonly OPENCODEX_DEPLOY="${REPO_ROOT}/scripts/deploy-opencodex-sidecar.sh"

RUN_ID="${TIANGONG_GATEB_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
[[ "${RUN_ID}" =~ ^[A-Za-z0-9._-]{1,48}$ ]] || { printf 'gateb=fail code=RUN_ID_INVALID\n' >&2; exit 2; }
readonly PG_CONTAINER="tiangong-b5-gateb-pg-${RUN_ID}"
readonly COORD_CONTAINER="tiangong-b5-gateb-coordination-${RUN_ID}"
readonly BINDING_VOLUME="tiangong-b5-gateb-binding-${RUN_ID}"
# Keep Docker-facing temporary files under the repository mount. Docker
# Desktop can resolve this path through wslpath as a host C: path, whereas a
# WSL /tmp path becomes a \u005c\u005cwsl.localhost UNC path that the daemon rejects.
readonly STATE_DIR="${REPO_ROOT}/.tmp-gateb-${RUN_ID}"
readonly ENV_FILE="${STATE_DIR}/coordination.env"
readonly BINDING_FILE="${STATE_DIR}/leader-binding.json"
readonly DRIVER_LOG="${STATE_DIR}/leader-smoke.log"
readonly TEAM_READY_BARRIER="${STATE_DIR}/team-ready-for-injection"
readonly INJECTION_BARRIER="${STATE_DIR}/injection-complete"
readonly NORMALIZED_TURN="${STATE_DIR}/leader-coordination-turn.sh"
readonly NORMALIZED_FOLLOWUP="${STATE_DIR}/leader-followup-turn.sh"
readonly NORMALIZED_REPORT="${STATE_DIR}/requester-report-check.sh"
readonly NORMALIZED_DRIVER="${SCRIPT_DIR}/.run-leader-smoke-${RUN_ID}.sh"
readonly CONTROL_TOKEN="gateb-control-${RUN_ID}-token"
readonly PG_PASSWORD="gateb-pg-${RUN_ID}-password"
readonly SIDECAR_BINDING_FILE="${STATE_DIR}/opencodex-binding.json"
# The lifecycle CLI runs inside the shared adapter container. Keep the
# controller snapshot in its deployment-owned state volume rather than
# passing a host-only path that would fail with ENOENT inside the container.
readonly SIDECAR_SNAPSHOT_FILE="/var/lib/tiangong-opencodex/opencodex-${IMPLEMENTOR_NAME}.controller.json"
readonly SIDECAR_CONTAINER="tiangong-opencodex-${IMPLEMENTOR_NAME}"
readonly SMOKE_MODEL="${TIANGONG_SMOKE_MODEL:-deepseek-chat}"
readonly CODEX_MODEL="${TIANGONG_B5_CODEX_MODEL:-deepseek-v4-pro}"
DOCKER_BINARY="$(command -v docker 2>/dev/null || true)"
DOCKER_BINARY_REAL="$(readlink -f "${DOCKER_BINARY}" 2>/dev/null || printf '%s' "${DOCKER_BINARY}")"
DOCKER_USES_WINDOWS_PATHS=0
[[ "${DOCKER_BINARY_REAL}" == *.exe ]] && DOCKER_USES_WINDOWS_PATHS=1
readonly DOCKER_BINARY DOCKER_BINARY_REAL DOCKER_USES_WINDOWS_PATHS
keep_failure_arg=0
[[ "${1:-}" == --keep-failure ]] && keep_failure_arg=1
readonly KEEP_FAILURE="${TIANGONG_GATEB_KEEP_FAILURE:-${keep_failure_arg}}"

driver_pid=''
coord_started=0
pg_started=0
runner_broker_started=0
manager_stopped=0
sidecar_provisioned=0
sidecar_attempted=0

fail() { printf 'gateb=fail code=%s\n' "$1" >&2; exit 1; }
container_exists() { docker container inspect "$1" >/dev/null 2>&1; }
worker_container() { printf 'agentteams-worker-%s\n' "$1"; }
lock_windows_file() {
  local path="$1"
  [[ "${OSTYPE:-}" =~ ^(msys|cygwin) ]] || return 0
  command -v icacls >/dev/null 2>&1 || fail WINDOWS_ACL_TOOL_MISSING
  icacls "$(cygpath -w "${path}")" /inheritance:r /grant:r \
    "${USERNAME}:(R)" 'NT AUTHORITY\SYSTEM:(R)' 'BUILTIN\Administrators:(R)' >/dev/null || fail WINDOWS_ACL_LOCK
}
docker_host_path() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1 && [[ "${OSTYPE:-}" =~ ^(msys|cygwin) ]]; then
    cygpath -w "${path}"
  elif ((DOCKER_USES_WINDOWS_PATHS == 1)) && command -v wslpath >/dev/null 2>&1; then
    wslpath -w "${path}"
  else
    printf '%s\n' "${path}"
  fi
}
wait_worker_running() {
  local name="$1" container
  container="$(worker_container "${name}")"
  for _ in $(seq 1 180); do
    if container_exists "${container}" && [[ "$(docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]]; then return 0; fi
    sleep 2
  done
  return 1
}
wait_worker_ready() {
  local name="$1" container value phase matrix room
  container="$(worker_container "${name}")"
  for _ in $(seq 1 180); do
    if [[ -n "${driver_pid}" ]] && ! kill -0 "${driver_pid}" 2>/dev/null; then
      return 1
    fi
    if container_exists "${container}" && [[ "$(docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]]; then
      value="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${name}" -o json 2>/dev/null | tr -d '\r' || true)"
      phase="$(jq -r '.phase // empty' <<<"${value}" 2>/dev/null || true)"
      matrix="$(jq -r '.matrixUserID // empty' <<<"${value}" 2>/dev/null || true)"
      room="$(jq -r '.roomID // empty' <<<"${value}" 2>/dev/null || true)"
      [[ "${phase}" == Running && -n "${matrix}" && -n "${room}" ]] && return 0
    fi
    sleep 2
  done
  return 1
}
wait_team_active() {
  local value phase
  for _ in $(seq 1 180); do
    value="$(docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json 2>/dev/null | tr -d '\r' || true)"
    phase="$(jq -r '.phase // empty' <<<"${value}" 2>/dev/null || true)"
    if [[ "${phase}" == Active ]]; then printf '%s\n' "${value}"; return 0; fi
    [[ "${phase}" == Failed ]] && return 1
    sleep 2
  done
  return 1
}
provision_opencodex_sidecar() {
  local image="${TIANGONG_OPENCODEX_SIDECAR_IMAGE:-tiangong-opencodex-sidecar:dev}"
  # OpenCodex serves its data-plane API below /v1; /models is the HTML
  # dashboard and would make the Worker gateway probe accept HTML as a 200
  # response before JSON parsing. Bind the receipt to the API base explicitly.
  local endpoint="http://${SIDECAR_CONTAINER}:8791/v1"
  jq -n \
    --arg team "${TEAM_NAME}" \
    --arg worker "${IMPLEMENTOR_NAME}" \
    --arg image "${image}" \
    --arg endpoint "${endpoint}" \
    --arg provider "${TIANGONG_B5_CODEX_PROVIDER:-agentteams-gateway}" \
    --arg model "${CODEX_MODEL}" \
    --arg credential "agentteams://credentials/${IMPLEMENTOR_NAME}" \
    '{schemaVersion:1,teamId:$team,workerId:$worker,image:$image,endpoint:$endpoint,provider:$provider,model:$model,transport:"responses-via-chat-bridge",bridge:"opencodex",credentialSource:"agentteams-secret-projection",credentialRef:$credential,generation:1}' \
    >"${SIDECAR_BINDING_FILE}"
  chmod 600 "${SIDECAR_BINDING_FILE}"
  sidecar_attempted=1
  TIANGONG_OPENCODEX_ADAPTER_IMAGE="${TIANGONG_OPENCODEX_ADAPTER_IMAGE:-tiangong-opencodex-adapter:dev}" \
    TIANGONG_OPENCODEX_WORKER_CONTAINER="$(worker_container "${IMPLEMENTOR_NAME}")" \
    bash "${OPENCODEX_DEPLOY}" lifecycle provision \
      --binding "${SIDECAR_BINDING_FILE}" --snapshot "${SIDECAR_SNAPSHOT_FILE}" >/dev/null || \
    fail OPENCODEX_SIDECAR_PROVISION
  sidecar_provisioned=1
  TIANGONG_OPENCODEX_ADAPTER_IMAGE="${TIANGONG_OPENCODEX_ADAPTER_IMAGE:-tiangong-opencodex-adapter:dev}" \
    TIANGONG_OPENCODEX_WORKER_CONTAINER="$(worker_container "${IMPLEMENTOR_NAME}")" \
    bash "${OPENCODEX_DEPLOY}" lifecycle ready --snapshot "${SIDECAR_SNAPSHOT_FILE}" >/dev/null || \
    fail OPENCODEX_SIDECAR_NOT_READY
  printf 'gateb=opencodex_sidecar_provisioned worker=%s model=%s\n' "${IMPLEMENTOR_NAME}" "${CODEX_MODEL}"
}
cleanup() {
  local status=$? member
  trap - EXIT INT TERM
  set +e
  if ((manager_stopped == 1)); then
    docker start "${MANAGER_CONTAINER}" >/dev/null 2>&1 || status=1
    manager_stopped=0
  fi
  if [[ -n "${driver_pid}" ]] && kill -0 "${driver_pid}" 2>/dev/null; then
    kill -TERM "${driver_pid}" 2>/dev/null || true
    wait "${driver_pid}" 2>/dev/null || true
  fi
  if ((sidecar_attempted == 1)); then
    if ((sidecar_provisioned == 1)); then
      TIANGONG_OPENCODEX_ADAPTER_IMAGE="${TIANGONG_OPENCODEX_ADAPTER_IMAGE:-tiangong-opencodex-adapter:dev}" \
        bash "${OPENCODEX_DEPLOY}" lifecycle drain --snapshot "${SIDECAR_SNAPSHOT_FILE}" >/dev/null 2>&1 || status=1
      TIANGONG_OPENCODEX_ADAPTER_IMAGE="${TIANGONG_OPENCODEX_ADAPTER_IMAGE:-tiangong-opencodex-adapter:dev}" \
        bash "${OPENCODEX_DEPLOY}" lifecycle remove --snapshot "${SIDECAR_SNAPSHOT_FILE}" >/dev/null 2>&1 || status=1
    fi
    # A failed provision may create the owned container before writing its
    # controller snapshot. Remove only that exact run-owned identity so a
    # later canary cannot inherit a foreign image or stale process.
    if container_exists "${SIDECAR_CONTAINER}"; then
      labels="$(docker inspect "${SIDECAR_CONTAINER}" --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}} {{end}}' 2>/dev/null || true)"
      if [[ "${labels}" == *'io.tiangong.owner=agentteams-deployment '* &&
            "${labels}" == *'io.tiangong.component=opencodex-sidecar '* &&
            "${labels}" == *"io.tiangong.team-id=${TEAM_NAME} "* &&
            "${labels}" == *"io.tiangong.worker-id=${IMPLEMENTOR_NAME} "* ]]; then
        docker rm -f "${SIDECAR_CONTAINER}" >/dev/null 2>&1 || status=1
      else
        status=1
      fi
    fi
    sidecar_provisioned=0
    sidecar_attempted=0
  fi
  if ((coord_started == 1)); then
    TIANGONG_COORDINATION_CONTAINER="${COORD_CONTAINER}" \
      TIANGONG_COORDINATION_ENV_FILE="${ENV_FILE}" \
      TIANGONG_LEADER_RUNTIME_BINDING_FILE="${BINDING_FILE}" \
      TIANGONG_DOCKER_BINDING_VOLUME="${BINDING_VOLUME}" \
      bash "${DEPLOY_COORDINATION}" stop >/dev/null 2>&1 || status=1
  fi
  if ((pg_started == 1)); then docker rm -f "${PG_CONTAINER}" >/dev/null 2>&1 || status=1; fi
  if ((runner_broker_started == 1)); then
    bash "${RUNNER_BROKER_SCRIPT}" stop >/dev/null 2>&1 || status=1
    runner_broker_started=0
  fi
  if docker volume inspect "${BINDING_VOLUME}" >/dev/null 2>&1; then
    docker volume rm "${BINDING_VOLUME}" >/dev/null 2>&1 || status=1
  fi
  if [[ "${KEEP_FAILURE}" == 1 ]]; then
    printf 'gateb_failure_state=%s\n' "${STATE_DIR}"
  else
    [[ ! -d "${STATE_DIR}" ]] || rm -rf -- "${STATE_DIR}"
    [[ ! -e "${NORMALIZED_DRIVER}" ]] || rm -f -- "${NORMALIZED_DRIVER}"
  fi
  for member in "${LEADER_NAME}" "${DESIGNER_NAME}" "${IMPLEMENTOR_NAME}" "${ASSESSOR_NAME}" "${OPERATOR_NAME}"; do
    container_exists "$(worker_container "${member}")" && status=1
    while IFS= read -r backup; do
      [[ -n "${backup}" ]] || continue
      docker rm -f "${backup}" >/dev/null 2>&1 || status=1
    done < <(docker ps -a --format '{{.Names}}' | grep -E "^$(worker_container "${member}")\\.tiangong-b5-injection\\.[0-9]+\\.[0-9]+$" || true)
  done
  container_exists "${PG_CONTAINER}" && status=1
  container_exists "${COORD_CONTAINER}" && status=1
  docker volume inspect "${BINDING_VOLUME}" >/dev/null 2>&1 && status=1
  if ((status == 0)); then printf 'gateb_cleanup=pass run=%s\n' "${RUN_ID}"; else printf 'gateb_cleanup=fail run=%s\n' "${RUN_ID}" >&2; fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in bash docker jq timeout; do command -v "${command}" >/dev/null 2>&1 || fail "COMMAND_${command^^}_MISSING"; done
[[ -f "${DRIVER}" && -f "${DEPLOY_COORDINATION}" && -f "${INJECT_ROLE}" && -f "${INJECT_LEADER}" && -f "${RUNNER_BROKER_SCRIPT}" && -f "${OPENCODEX_DEPLOY}" ]] || fail SMOKE_ASSET_MISSING
[[ "${SMOKE_MODEL}" =~ ^[A-Za-z0-9._:/-]{1,128}$ ]] || fail SMOKE_MODEL_INVALID
[[ "${CODEX_MODEL}" =~ ^[A-Za-z0-9._:/-]{1,128}$ ]] || fail CODEX_MODEL_INVALID
container_exists "${MANAGER_CONTAINER}" || fail MANAGER_MISSING
container_exists "${CONTROLLER_CONTAINER}" || fail CONTROLLER_MISSING
[[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}')" == true ]] || fail MANAGER_NOT_RUNNING
[[ "$(docker inspect "${CONTROLLER_CONTAINER}" --format '{{.State.Running}}')" == true ]] || fail CONTROLLER_NOT_RUNNING
docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json >/dev/null 2>&1 && fail RESERVED_TEAM_EXISTS
broker_result="$(timeout 60s bash "${RUNNER_BROKER_SCRIPT}" ensure 2>&1)" || {
  printf '%s\n' "${broker_result}" >&2
  fail RUNNER_BROKER_NOT_READY
}
printf '%s\n' "${broker_result}"
if grep -Eq 'managed=true' <<<"${broker_result}"; then
  runner_broker_started=1
  printf 'gateb=runner_broker_managed name=tiangong-runner-broker\n'
else
  printf 'gateb=runner_broker_reused name=tiangong-runner-broker\n'
fi
mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"
# shellcheck disable=SC2016
tr -d '\r' <"${DRIVER}" | sed \
  -e '/^"\${BUILD_SCRIPT}"$/d' \
  -e 's#head -c 8 /proc/sys/kernel/random/uuid#openssl rand -hex 8#g' \
  -e 's#cat /proc/sys/kernel/random/uuid#openssl rand -hex 16#g' >"${NORMALIZED_DRIVER}"
tr -d '\r' <"${SCRIPT_DIR}/leader-coordination-turn.sh" >"${NORMALIZED_TURN}"
tr -d '\r' <"${SCRIPT_DIR}/leader-followup-turn.sh" >"${NORMALIZED_FOLLOWUP}"
tr -d '\r' <"${SCRIPT_DIR}/requester-report-check.sh" >"${NORMALIZED_REPORT}"
turn_path="${NORMALIZED_TURN//\//\\/}"
followup_path="${NORMALIZED_FOLLOWUP//\//\\/}"
report_path="${NORMALIZED_REPORT//\//\\/}"
sed -i "s#^readonly TURN_HELPER=.*#readonly TURN_HELPER=\"${turn_path}\"#" "${NORMALIZED_DRIVER}"
sed -i "s#^readonly FOLLOWUP_HELPER=.*#readonly FOLLOWUP_HELPER=\"${followup_path}\"#" "${NORMALIZED_DRIVER}"
sed -i "s#^readonly REPORT_HELPER=.*#readonly REPORT_HELPER=\"${report_path}\"#" "${NORMALIZED_DRIVER}"
sed -i '1i export MSYS_NO_PATHCONV=1' "${NORMALIZED_DRIVER}"
# Git Bash needs Windows paths for Docker Desktop. WSL and native Linux
# already expose POSIX paths that the Docker CLI accepts, and do not provide
# cygpath; leave those paths unchanged instead of failing before the Team is
# created.
if command -v cygpath >/dev/null 2>&1 && [[ "${OSTYPE:-}" =~ ^(msys|cygwin) ]]; then
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${WORKERS_MANIFEST}"#"$(cygpath -w "\${WORKERS_MANIFEST}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${MANIFEST}"#"$(cygpath -w "\${MANIFEST}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${TURN_HELPER}"#"$(cygpath -w "\${TURN_HELPER}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${FOLLOWUP_HELPER}"#"$(cygpath -w "\${FOLLOWUP_HELPER}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${REPORT_HELPER}"#"$(cygpath -w "\${REPORT_HELPER}")"#' "${NORMALIZED_DRIVER}"
elif ((DOCKER_USES_WINDOWS_PATHS == 1)) && command -v wslpath >/dev/null 2>&1; then
  # WSL uses the Windows Docker CLI, which accepts the UNC path emitted by
  # wslpath but not the /mnt/c path passed to docker.exe directly.
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${WORKERS_MANIFEST}"#"$(wslpath -w "\${WORKERS_MANIFEST}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${MANIFEST}"#"$(wslpath -w "\${MANIFEST}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${TURN_HELPER}"#"$(wslpath -w "\${TURN_HELPER}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${FOLLOWUP_HELPER}"#"$(wslpath -w "\${FOLLOWUP_HELPER}")"#' "${NORMALIZED_DRIVER}"
  # shellcheck disable=SC2016
  sed -i '/^docker cp /s#"\${REPORT_HELPER}"#"$(wslpath -w "\${REPORT_HELPER}")"#' "${NORMALIZED_DRIVER}"
fi
sed -i "/^leader_json=/i printf 'leader_smoke_team_ready_for_injection=pass\\n'; : >\"${TEAM_READY_BARRIER//\//\\/}\"; while [[ ! -f \"${INJECTION_BARRIER//\//\\/}\" ]]; do sleep 1; done" "${NORMALIZED_DRIVER}"
chmod 700 "${NORMALIZED_DRIVER}"
printf 'TIANGONG_COORDINATION_DATABASE_URL=postgres://tiangong:%s@%s:5432/tiangong\n' "${PG_PASSWORD}" "${PG_CONTAINER}" >"${ENV_FILE}"
printf 'TIANGONG_COORDINATION_CONTROL_TOKEN=%s\n' "${CONTROL_TOKEN}" >>"${ENV_FILE}"
chmod 600 "${ENV_FILE}"
lock_windows_file "${ENV_FILE}"

docker volume create "${BINDING_VOLUME}" >/dev/null || fail BINDING_VOLUME_CREATE
docker run -d --name "${PG_CONTAINER}" --network agentteams-net \
  --label "io.tiangong.owner=gateb-${RUN_ID}" --label 'io.tiangong.component=gateb-postgres' \
  -e POSTGRES_USER=tiangong -e "POSTGRES_PASSWORD=${PG_PASSWORD}" -e POSTGRES_DB=tiangong postgres:16-alpine >/dev/null || fail POSTGRES_START
pg_started=1
printf 'gateb=postgres_started running=%s\n' "$(docker inspect "${PG_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null || printf false)"
pg_ready_checks=0
for _ in $(seq 1 90); do
  # Docker Desktop can leave a CLI exec attached while PostgreSQL is still
  # replacing its init process. Bound the probe so one stale attachment cannot
  # stall the entire Gate B run indefinitely.
  if timeout 10s docker exec "${PG_CONTAINER}" pg_isready -U tiangong -d tiangong >/dev/null 2>&1; then
    pg_ready_checks=$((pg_ready_checks + 1))
    ((pg_ready_checks >= 2)) && break
  else
    pg_ready_checks=0
  fi
  sleep 1
done
((pg_ready_checks >= 2)) || {
  printf 'gateb=postgres_probe_failed state=%s\n' "$(docker inspect "${PG_CONTAINER}" --format '{{.State.Status}}' 2>/dev/null || printf missing)"
  fail POSTGRES_NOT_READY
}

printf 'gateb=started run=%s\n' "${RUN_ID}"
TIANGONG_MATRIX_SENDER_CONTAINER="agentteams-worker-${DESIGNER_NAME}" \
TIANGONG_SMOKE_EVIDENCE_DIR="${STATE_DIR}" \
  bash "${NORMALIZED_DRIVER}" >"${DRIVER_LOG}" 2>&1 & driver_pid=$!

# AgentTeams owns the initial Worker and Team shape. Wait for all five before
# waiting for the child smoke to bind the Team and settle its Matrix policy;
# only then pause the Manager reconciler for the role-specific replacement.
for pair in \
  "${LEADER_NAME}:leader" "${DESIGNER_NAME}:designer" \
  "${IMPLEMENTOR_NAME}:implementor" "${ASSESSOR_NAME}:assessor" "${OPERATOR_NAME}:operator"; do
  member="${pair%%:*}"; role="${pair##*:}"
  wait_worker_ready "${member}" || fail "WORKER_${role^^}_NOT_READY"
done
for _ in $(seq 1 360); do
  [[ -f "${TEAM_READY_BARRIER}" ]] && break
  if ! kill -0 "${driver_pid}" 2>/dev/null; then fail TEAM_SETUP_CHILD_EXITED; fi
  sleep 2
done
[[ -f "${TEAM_READY_BARRIER}" ]] || fail TEAM_NOT_READY_FOR_INJECTION
docker stop "${MANAGER_CONTAINER}" >/dev/null || fail MANAGER_STOP_FOR_INJECTION
manager_stopped=1
for pair in \
  "${LEADER_NAME}:leader" "${DESIGNER_NAME}:designer" \
  "${IMPLEMENTOR_NAME}:implementor" "${ASSESSOR_NAME}:assessor" "${OPERATOR_NAME}:operator"; do
  member="${pair%%:*}"; role="${pair##*:}"
  TIANGONG_B5_WORKER_CONTAINER="$(worker_container "${member}")" \
  TIANGONG_B5_ROLE_ID="${role}" \
    TIANGONG_B5_COORDINATION_CONTROL_ENDPOINT="http://${COORD_CONTAINER}:8780/v1/coordination/admit" \
    TIANGONG_B5_COORDINATION_CONTROL_TOKEN="${CONTROL_TOKEN}" \
    TIANGONG_B5_CODEX_MODEL="${CODEX_MODEL}" \
    TIANGONG_B5_ALLOW_STOPPED=1 \
    TIANGONG_INJECTION_DEBUG=1 \
    TIANGONG_DOCKER_TEMP_DIR="${STATE_DIR}" \
    bash "${INJECT_ROLE}" >>"${STATE_DIR}/inject-${role}.log" 2>&1 || {
      code="$(sed -n 's/^b5_role_runtime_injection=fail code=//p' "${STATE_DIR}/inject-${role}.log" | tail -n 1)"
      printf 'gateb=role_injection_failed role=%s code=%s\n' "${role}" "${code:-UNKNOWN}"
      fail "ROLE_${role^^}_INJECTION"
    }
done
docker start "${MANAGER_CONTAINER}" >/dev/null || fail MANAGER_RESTART_AFTER_INJECTION
manager_stopped=0
for _ in $(seq 1 60); do
  docker exec "${MANAGER_CONTAINER}" agt get workers -o json >/dev/null 2>&1 && break
  sleep 2
done
docker exec "${MANAGER_CONTAINER}" agt get workers -o json >/dev/null 2>&1 || fail MANAGER_NOT_READY_AFTER_INJECTION
# AgentTeams v1.2.2 reconciles the public Worker shape after the Manager comes
# back. Reapply the deployment-owned runtime projection once the control plane
# is healthy; otherwise the controller may restore its legacy runtime env
# before the readiness gate observes it. This remains a narrow, idempotent
# replacement of the same run-owned Worker containers.
for pair in \
  "${LEADER_NAME}:leader" "${DESIGNER_NAME}:designer" \
  "${IMPLEMENTOR_NAME}:implementor" "${ASSESSOR_NAME}:assessor" "${OPERATOR_NAME}:operator"; do
  member="${pair%%:*}"; role="${pair##*:}"
  TIANGONG_B5_WORKER_CONTAINER="$(worker_container "${member}")" \
  TIANGONG_B5_ROLE_ID="${role}" \
  TIANGONG_B5_COORDINATION_CONTROL_ENDPOINT="http://${COORD_CONTAINER}:8780/v1/coordination/admit" \
  TIANGONG_B5_COORDINATION_CONTROL_TOKEN="${CONTROL_TOKEN}" \
  TIANGONG_B5_CODEX_MODEL="${CODEX_MODEL}" \
  TIANGONG_B5_ALLOW_STOPPED=1 \
  TIANGONG_INJECTION_DEBUG=1 \
    TIANGONG_DOCKER_TEMP_DIR="${STATE_DIR}" \
    bash "${INJECT_ROLE}" >>"${STATE_DIR}/reinject-${role}.log" 2>&1 || {
      code="$(sed -n 's/^b5_role_runtime_injection=fail code=//p' "${STATE_DIR}/reinject-${role}.log" | tail -n 1)"
      printf 'gateb=role_reinjection_failed role=%s code=%s\n' "${role}" "${code:-UNKNOWN}"
      fail "ROLE_${role^^}_REINJECTION"
    }
done
provision_opencodex_sidecar
printf 'gateb=role_runtime_reinjected_after_manager=pass\n'
# A Codex Worker performs its gateway preflight during container startup. The
# bounded injection window intentionally stops the Manager so no deployment
# mutation races with the five recreations; a Worker that starts in that window
# can therefore exit on a transient controller 503. Restart only the
# run-owned Workers which exited during that window, after the Manager is
# healthy again. Never restart a foreign or still-running container here.
sleep 5
for _ in $(seq 1 20); do
  for member in "${LEADER_NAME}" "${DESIGNER_NAME}" "${IMPLEMENTOR_NAME}" "${ASSESSOR_NAME}" "${OPERATOR_NAME}"; do
    worker_container_name="$(worker_container "${member}")"
    if container_exists "${worker_container_name}" && [[ "$(docker inspect "${worker_container_name}" --format '{{.State.Running}}' 2>/dev/null || true)" != true ]]; then
      docker start "${worker_container_name}" >/dev/null || fail "WORKER_${member^^}_RESTART_AFTER_MANAGER"
    fi
  done
  sleep 2
done
for _ in $(seq 1 120); do
  metadata_ready=1
  for member in "${LEADER_NAME}" "${DESIGNER_NAME}" "${IMPLEMENTOR_NAME}" "${ASSESSOR_NAME}" "${OPERATOR_NAME}"; do
    worker_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${member}" -o json 2>/dev/null | tr -d '\r' || true)"
    [[ -n "$(jq -r '.matrixUserID // empty' <<<"${worker_json}" 2>/dev/null || true)" ]] || metadata_ready=0
    [[ -n "$(jq -r '.roomID // empty' <<<"${worker_json}" 2>/dev/null || true)" ]] || metadata_ready=0
  done
  ((metadata_ready == 1)) && break
  sleep 2
done
((metadata_ready == 1)) || fail WORKER_METADATA_NOT_READY_AFTER_INJECTION
for pair in \
  "${LEADER_NAME}:leader" "${DESIGNER_NAME}:designer" \
  "${IMPLEMENTOR_NAME}:implementor" "${ASSESSOR_NAME}:assessor" "${OPERATOR_NAME}:operator"; do
  member="${pair%%:*}"; role="${pair##*:}"
  # The Leader tool surface requires the Coordination endpoint and binding
  # installed in the next deployment step. Member roles are independent and
  # must become ready before we continue; Leader readiness is checked after
  # its binding is injected below.
  [[ "${member}" == "${LEADER_NAME}" ]] && continue
  for _ in $(seq 1 180); do
    # Role injection can take several minutes and OpenClaw emits verbose
    # MinIO/config-sync lines. Injection recreates this exact container, so
    # inspect its complete lifecycle; a wall-clock window could expire while
    # a slow Docker Desktop operation is still preparing the next role.
    if docker logs "$(worker_container "${member}")" 2>&1 | grep -Fq ' reported ready'; then break; fi
    sleep 2
  done
  docker logs "$(worker_container "${member}")" 2>&1 | grep -Fq ' reported ready' || fail "WORKER_${role^^}_RUNTIME_NOT_READY"
done
# Role injection recreates each Worker container. Reinstall the two reviewed
# smoke helpers after that replacement so the Matrix sender does not retain a
# path into the pre-injection container filesystem.
docker cp "$(docker_host_path "${NORMALIZED_TURN}")" "${TURN_CONTAINER}:/tmp/tiangong-leader-coordination-turn.sh" || fail TURN_HELPER_RESTORE
docker cp "$(docker_host_path "${NORMALIZED_FOLLOWUP}")" "${TURN_CONTAINER}:/tmp/tiangong-leader-followup-turn.sh" || fail FOLLOWUP_HELPER_RESTORE
docker cp "$(docker_host_path "${NORMALIZED_REPORT}")" "${TURN_CONTAINER}:/tmp/tiangong-requester-report-check.sh" || fail REPORT_HELPER_RESTORE
: >"${INJECTION_BARRIER}"
team_json="$(wait_team_active)" || fail TEAM_NOT_ACTIVE
team_room="$(jq -r '.teamRoomID // empty' <<<"${team_json}")"
[[ -n "${team_room}" ]] || fail TEAM_ROOM_MISSING

leader_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${LEADER_NAME}" -o json | tr -d '\r')"
designer_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${DESIGNER_NAME}" -o json | tr -d '\r')"
implementor_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${IMPLEMENTOR_NAME}" -o json | tr -d '\r')"
assessor_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${ASSESSOR_NAME}" -o json | tr -d '\r')"
operator_json="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${OPERATOR_NAME}" -o json | tr -d '\r')"
leader_uid="$(jq -r '.matrixUserID // empty' <<<"${leader_json}")"
if [[ ! "${leader_uid}" =~ ^@[^:[:space:]]+:[^[:space:]]+$ ]]; then
  printf 'gateb=leader_metadata phase=%s matrix_present=%s room_present=%s\n' \
    "$(jq -r '.phase // empty' <<<"${leader_json}" 2>/dev/null || true)" \
    "$([[ -n "${leader_uid}" ]] && printf 1 || printf 0)" \
    "$([[ -n "$(jq -r '.roomID // empty' <<<"${leader_json}" 2>/dev/null || true)" ]] && printf 1 || printf 0)"
  printf 'gateb=leader_matrix_bytes len=%s hex=%s\n' \
    "${#leader_uid}" "$(printf '%s' "${leader_uid}" | od -An -t x1 | tr -d ' \n')"
  fail LEADER_MATRIX_ID_MISSING
fi
created_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
binding_file_arg="${BINDING_FILE}"
if command -v wslpath >/dev/null 2>&1; then
  binding_file_arg="$(wslpath -w "${BINDING_FILE}")"
fi
node.exe --input-type=module - \
  "${TEAM_NAME}" "${TEAM_NAME}-matrix" "${TEAM_NAME}-profile" "${created_at}" "${team_room}" \
  "${LEADER_NAME}" "${leader_uid}" \
  "${DESIGNER_NAME}" "$(jq -r '.matrixUserID // empty' <<<"${designer_json}")" \
  "${IMPLEMENTOR_NAME}" "$(jq -r '.matrixUserID // empty' <<<"${implementor_json}")" \
  "${ASSESSOR_NAME}" "$(jq -r '.matrixUserID // empty' <<<"${assessor_json}")" \
  "${OPERATOR_NAME}" "$(jq -r '.matrixUserID // empty' <<<"${operator_json}")" \
  "${binding_file_arg}" <<'NODE'
import { chmod, writeFile } from "node:fs/promises";
import { createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "./worker/agent/team/coordination-store.mjs";
const [teamId, routeId, profileId, now, roomId, leaderName, leaderUid, designerName, designerUid, implementorName, implementorUid, assessorName, assessorUid, operatorName, operatorUid, bindingFile] = process.argv.slice(2);
const profile = createControlProfile({ profileId, revision: 1, maxTimelineEntries: 4096, maxOutboxEntries: 1024, maxTasksPerWork: 256, toolResultRetentionMs: 31536000000 });
const names = ["LEADER", "DESIGNER", "IMPLEMENTOR", "ASSESSOR", "OPERATOR"];
const values = { LEADER: [leaderName, leaderUid], DESIGNER: [designerName, designerUid], IMPLEMENTOR: [implementorName, implementorUid], ASSESSOR: [assessorName, assessorUid], OPERATOR: [operatorName, operatorUid] };
const members = names.map((key) => createMemberConfig({ memberId: values[key][0], teamId, workerName: values[key][0], matrixUserId: values[key][1], role: key === "LEADER" ? "leader" : key.toLowerCase(), controlProfileId: profile.profileId, enabled: true, createdAt: now }));
const team = createTeamConfig({ teamId, revision: 1, leaderMemberId: leaderName, memberIds: members.map((member) => member.memberId), controlProfileId: profile.profileId, createdAt: now });
const route = createTeamRouteBinding({ routeId, teamId: team.teamId, revision: 1, channel: "matrix", roomId, createdAt: now });
await writeFile(bindingFile, `${JSON.stringify({ team, route, profile, leaderMember: members[0], members }, null, 2)}\n`, { mode: 0o600 });
await chmod(bindingFile, 0o600);
NODE
[[ -f "${BINDING_FILE}" ]] || fail BINDING_CREATE
lock_windows_file "${BINDING_FILE}"
MSYS_NO_PATHCONV=1 docker run --rm -i --mount "type=volume,source=${BINDING_VOLUME},destination=/run/binding" alpine:3.20 \
  sh -c 'cat > /run/binding/leader-binding.json && chmod 600 /run/binding/leader-binding.json' <"${BINDING_FILE}" || fail BINDING_VOLUME_WRITE

MSYS_NO_PATHCONV=1 \
  TIANGONG_COORDINATION_CONTAINER="${COORD_CONTAINER}" \
  TIANGONG_COORDINATION_ENV_FILE="${ENV_FILE}" \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${BINDING_FILE}" \
  TIANGONG_DOCKER_BINDING_VOLUME="${BINDING_VOLUME}" \
  TIANGONG_WINDOWS_ACL_VERIFIED=1 \
  bash "${DEPLOY_COORDINATION}" start || fail COORDINATION_START
coord_started=1
leader_container="$(worker_container "${LEADER_NAME}")"
if [[ "$(docker inspect "${leader_container}" --format '{{.State.Running}}' 2>/dev/null || true)" != true ]]; then
  docker start "${leader_container}" >/dev/null || fail LEADER_START_BEFORE_BINDING
  sleep 5
fi
TIANGONG_LEADER_WORKER_CONTAINER="$(worker_container "${LEADER_NAME}")" \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${BINDING_FILE}" \
  TIANGONG_DOCKER_TEMP_DIR="${STATE_DIR}" \
  TIANGONG_DOCKER_BINDING_VOLUME="${BINDING_VOLUME}" \
  TIANGONG_WINDOWS_ACL_VERIFIED=1 \
  TIANGONG_COORDINATION_CONTROL_ENDPOINT="http://${COORD_CONTAINER}:8780/v1/coordination/admit" \
  TIANGONG_COORDINATION_CONTROL_TOKEN="${CONTROL_TOKEN}" \
  bash "${INJECT_LEADER}" >"${STATE_DIR}/inject-leader.log" 2>&1 || fail LEADER_BINDING_INJECTION

for _ in $(seq 1 180); do
  if docker logs "$(worker_container "${LEADER_NAME}")" 2>&1 | grep -Fq ' reported ready'; then break; fi
  sleep 2
done
docker logs "$(worker_container "${LEADER_NAME}")" 2>&1 | grep -Fq ' reported ready' || fail LEADER_RUNTIME_NOT_READY_AFTER_BINDING

# The driver log is never printed: it may contain model/Matrix text. Only
# stable machine markers are used as the result oracle. On failure, expose
# the small allowlisted marker set needed to classify the failed boundary.
if ! wait "${driver_pid}"; then
  grep -E '^(leader_smoke_(real_team|design_roundtrip|matrix_handoff|requester_report|gate3|cleanup)=(pass|partial_blocked_terminal_only|fail)|leader_followup=(pass|timeout)|leader_prompt_sent=[A-Za-z0-9._:-]+)' "${DRIVER_LOG}" | tail -n 20 || true
  fail LEADER_MATRIX_VERTICAL
fi
driver_pid=''
grep -Eq 'leader_smoke_real_team=pass' "${DRIVER_LOG}" || fail TEAM_VERTICAL_MARKER_MISSING
grep -Eq 'leader_smoke_design_roundtrip=pass' "${DRIVER_LOG}" || fail DESIGN_ROUNDTRIP_MISSING
grep -Eq 'leader_smoke_requester_report=pass' "${DRIVER_LOG}" || fail CLOSURE_MARKER_MISSING
printf 'gateb_matrix_work_task_result_closure=pass run=%s\n' "${RUN_ID}"
