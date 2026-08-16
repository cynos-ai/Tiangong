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
keep_failure_arg=0
[[ "${1:-}" == --keep-failure ]] && keep_failure_arg=1
readonly KEEP_FAILURE="${TIANGONG_GATEB_KEEP_FAILURE:-${keep_failure_arg}}"

driver_pid=''
coord_started=0
pg_started=0
runner_broker_started=0
manager_stopped=0

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
  docker volume rm "${BINDING_VOLUME}" >/dev/null 2>&1 || status=1
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

for command in bash docker jq; do command -v "${command}" >/dev/null 2>&1 || fail "COMMAND_${command^^}_MISSING"; done
[[ -f "${DRIVER}" && -f "${DEPLOY_COORDINATION}" && -f "${INJECT_ROLE}" && -f "${INJECT_LEADER}" && -f "${RUNNER_BROKER_SCRIPT}" ]] || fail SMOKE_ASSET_MISSING
container_exists "${MANAGER_CONTAINER}" || fail MANAGER_MISSING
container_exists "${CONTROLLER_CONTAINER}" || fail CONTROLLER_MISSING
[[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}')" == true ]] || fail MANAGER_NOT_RUNNING
[[ "$(docker inspect "${CONTROLLER_CONTAINER}" --format '{{.State.Running}}')" == true ]] || fail CONTROLLER_NOT_RUNNING
docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json >/dev/null 2>&1 && fail RESERVED_TEAM_EXISTS
if container_exists tiangong-runner-broker; then
  bash "${RUNNER_BROKER_SCRIPT}" status >/dev/null 2>&1 || fail RUNNER_BROKER_NOT_READY
  printf 'gateb=runner_broker_reused name=tiangong-runner-broker\n'
else
  bash "${RUNNER_BROKER_SCRIPT}" start >/dev/null || fail RUNNER_BROKER_START
  runner_broker_started=1
  printf 'gateb=runner_broker_started name=tiangong-runner-broker\n'
fi
mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"
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
sed -i '/^docker cp /s#"\${WORKERS_MANIFEST}"#"$(cygpath -w "\${WORKERS_MANIFEST}")"#' "${NORMALIZED_DRIVER}"
sed -i '/^docker cp /s#"\${MANIFEST}"#"$(cygpath -w "\${MANIFEST}")"#' "${NORMALIZED_DRIVER}"
sed -i '/^docker cp /s#"\${TURN_HELPER}"#"$(cygpath -w "\${TURN_HELPER}")"#' "${NORMALIZED_DRIVER}"
sed -i '/^docker cp /s#"\${FOLLOWUP_HELPER}"#"$(cygpath -w "\${FOLLOWUP_HELPER}")"#' "${NORMALIZED_DRIVER}"
sed -i '/^docker cp /s#"\${REPORT_HELPER}"#"$(cygpath -w "\${REPORT_HELPER}")"#' "${NORMALIZED_DRIVER}"
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
for _ in $(seq 1 90); do
  docker exec "${PG_CONTAINER}" pg_isready -U tiangong -d tiangong >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${PG_CONTAINER}" pg_isready -U tiangong -d tiangong >/dev/null 2>&1 || {
  printf 'gateb=postgres_probe_failed state=%s\n' "$(docker inspect "${PG_CONTAINER}" --format '{{.State.Status}}' 2>/dev/null || printf missing)"
  fail POSTGRES_NOT_READY
}

printf 'gateb=started run=%s\n' "${RUN_ID}"
TIANGONG_MATRIX_SENDER_CONTAINER="agentteams-worker-${DESIGNER_NAME}" \
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
  for _ in $(seq 1 180); do
    if docker logs --tail 120 "$(worker_container "${member}")" 2>&1 | grep -Fq ' reported ready'; then break; fi
    sleep 2
  done
  docker logs --tail 120 "$(worker_container "${member}")" 2>&1 | grep -Fq ' reported ready' || fail "WORKER_${role^^}_RUNTIME_NOT_READY"
done
# Role injection recreates each Worker container. Reinstall the two reviewed
# smoke helpers after that replacement so the Matrix sender does not retain a
# path into the pre-injection container filesystem.
docker cp "${NORMALIZED_TURN}" "${TURN_CONTAINER}:/tmp/tiangong-leader-coordination-turn.sh" || fail TURN_HELPER_RESTORE
docker cp "${NORMALIZED_FOLLOWUP}" "${TURN_CONTAINER}:/tmp/tiangong-leader-followup-turn.sh" || fail FOLLOWUP_HELPER_RESTORE
docker cp "${NORMALIZED_REPORT}" "${TURN_CONTAINER}:/tmp/tiangong-requester-report-check.sh" || fail REPORT_HELPER_RESTORE
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
env TEAM_ID="${TEAM_NAME}" ROUTE_ID="${TEAM_NAME}-matrix" PROFILE_ID="${TEAM_NAME}-profile" \
  CREATED_AT="${created_at}" ROOM_ID="${team_room}" \
  LEADER_NAME="${LEADER_NAME}" LEADER_UID="${leader_uid}" \
  DESIGNER_NAME="${DESIGNER_NAME}" DESIGNER_UID="$(jq -r '.matrixUserID // empty' <<<"${designer_json}")" \
  IMPLEMENTOR_NAME="${IMPLEMENTOR_NAME}" IMPLEMENTOR_UID="$(jq -r '.matrixUserID // empty' <<<"${implementor_json}")" \
  ASSESSOR_NAME="${ASSESSOR_NAME}" ASSESSOR_UID="$(jq -r '.matrixUserID // empty' <<<"${assessor_json}")" \
  OPERATOR_NAME="${OPERATOR_NAME}" OPERATOR_UID="$(jq -r '.matrixUserID // empty' <<<"${operator_json}")" \
  BINDING_FILE="${BINDING_FILE}" node.exe --input-type=module <<'NODE'
import { chmod, writeFile } from "node:fs/promises";
import { createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "./worker/agent/team/coordination-store.mjs";
const now = process.env.CREATED_AT;
const profile = createControlProfile({ profileId: process.env.PROFILE_ID, revision: 1, maxTimelineEntries: 4096, maxOutboxEntries: 1024, maxTasksPerWork: 256, toolResultRetentionMs: 31536000000 });
const names = ["LEADER", "DESIGNER", "IMPLEMENTOR", "ASSESSOR", "OPERATOR"];
const members = names.map((key) => createMemberConfig({ memberId: process.env[`${key}_NAME`], teamId: process.env.TEAM_ID, workerName: process.env[`${key}_NAME`], matrixUserId: process.env[`${key}_UID`], role: key === "LEADER" ? "leader" : key.toLowerCase(), controlProfileId: profile.profileId, enabled: true, createdAt: now }));
const team = createTeamConfig({ teamId: process.env.TEAM_ID, revision: 1, leaderMemberId: process.env.LEADER_NAME, memberIds: members.map((member) => member.memberId), controlProfileId: profile.profileId, createdAt: now });
const route = createTeamRouteBinding({ routeId: process.env.ROUTE_ID, teamId: team.teamId, revision: 1, channel: "matrix", roomId: process.env.ROOM_ID, createdAt: now });
await writeFile(process.env.BINDING_FILE, `${JSON.stringify({ team, route, profile, leaderMember: members[0], members }, null, 2)}\n`, { mode: 0o600 });
await chmod(process.env.BINDING_FILE, 0o600);
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
TIANGONG_LEADER_WORKER_CONTAINER="$(worker_container "${LEADER_NAME}")" \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${BINDING_FILE}" \
  TIANGONG_DOCKER_TEMP_DIR="${STATE_DIR}" \
  TIANGONG_DOCKER_BINDING_VOLUME="${BINDING_VOLUME}" \
  TIANGONG_WINDOWS_ACL_VERIFIED=1 \
  TIANGONG_COORDINATION_CONTROL_ENDPOINT="http://${COORD_CONTAINER}:8780/v1/coordination/admit" \
  TIANGONG_COORDINATION_CONTROL_TOKEN="${CONTROL_TOKEN}" \
  bash "${INJECT_LEADER}" >"${STATE_DIR}/inject-leader.log" 2>&1 || fail LEADER_BINDING_INJECTION

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
