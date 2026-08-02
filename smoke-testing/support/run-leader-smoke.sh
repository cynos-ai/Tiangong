#!/usr/bin/env bash
# Gate 3 leader-half roundtrip: drive a real Matrix -> pi coordination turn
# through the tiangong-worker-leader image and verify the Leader writes the
# immutable project + design-task bindings (TransitionPolicy-gated) plus the
# hash-chained coordination Evidence.
#
# This is a focused transport/coordination spike, not a Full smoke: it proves
# the Leader half (create project + dispatch design). The worker half
# (implementor/assessor/operator response, submit, accept) and cross-worker
# agentteams-sync are out of scope here.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly WORKER_NAME="tiangong-leader-smoke"
readonly CONTAINER_NAME="agentteams-worker-${WORKER_NAME}"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/leader-smoke-worker.yaml"
readonly MANAGER_MANIFEST="/tmp/tiangong-leader-smoke-worker.yaml"
readonly MANAGER_TURN="/tmp/tiangong-leader-turn.sh"
readonly TURN_SCRIPT="${SCRIPT_DIR}/leader-coordination-turn.sh"
PROJECT_ID="demo-$(head -c 4 /proc/sys/kernel/random/uuid)"
created=0

log() { printf '[Tiangong] %s\n' "$*"; }
die() { printf '[Tiangong] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT INT TERM
  set +e
  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_MANIFEST}" "${MANAGER_TURN}" >/dev/null 2>&1 || cleanup_failed=1
  if ((created == 1)); then
    log "Deleting temporary Leader ${WORKER_NAME}"
    docker exec "${MANAGER_CONTAINER}" agt delete worker "${WORKER_NAME}" >/dev/null 2>&1 || cleanup_failed=1
    for _ in $(seq 1 60); do
      if ! docker exec "${MANAGER_CONTAINER}" agt get workers "${WORKER_NAME}" -o json >/dev/null 2>&1 && \
          ! docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"; then break; fi
      sleep 1
    done
    docker exec "${CONTROLLER_CONTAINER}" sh -c \
      'rm -rf "/root/agentteams-fs/agents/'"${WORKER_NAME}"'" "/root/agentteams-fs/shared/tiangong" 2>/dev/null; mc rm --recursive --force "agentteams/agentteams-storage/agents/'"${WORKER_NAME}"'" >/dev/null 2>&1' 2>/dev/null || true
  fi
  ((cleanup_failed == 0)) && printf 'leader_smoke_cleanup=pass\n' || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for cmd in docker jq; do command -v "$cmd" >/dev/null 2>&1 || die "Missing $cmd"; done
docker info >/dev/null 2>&1 || die "Docker daemon unavailable"
docker inspect "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}" >/dev/null 2>&1 || die "AgentTeams containers missing"
[[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}')" == "true" ]] || die "${MANAGER_CONTAINER} not running"
docker exec "${MANAGER_CONTAINER}" agt get workers "${WORKER_NAME}" -o json >/dev/null 2>&1 && die "Reserved Leader ${WORKER_NAME} already exists"
[[ -x "${TURN_SCRIPT}" ]] || die "Missing ${TURN_SCRIPT}"

log "Building tiangong-worker-leader:dev"
"${REPO_ROOT}/scripts/build-worker-image.sh" >/dev/null

docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
log "Creating Leader ${WORKER_NAME}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_MANIFEST}"
created=1
for _ in $(seq 1 80); do
  phase="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${WORKER_NAME}" -o json 2>/dev/null | jq -r '.phase // empty' || true)"
  [[ "${phase}" == "Running" ]] && break
  [[ "${phase}" == "Failed" ]] && die "Leader entered Failed phase"
  sleep 3
done
[[ "${phase}" == "Running" ]] || die "Leader did not reach Running"

room_id="$(docker exec "${CONTAINER_NAME}" printenv AGENTTEAMS_WORKER_ROOM_ID)"
leader_uid="$(docker exec "${CONTAINER_NAME}" jq -r '.channels.matrix.userId // empty' \
  "/root/agentteams-fs/agents/${WORKER_NAME}/openclaw.json")"
[[ -n "${room_id}" && -n "${leader_uid}" ]] || die "Leader Matrix identity incomplete"
for _ in $(seq 1 45); do
  if docker exec "${CONTAINER_NAME}" openclaw health >/dev/null 2>&1 &&
     docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq "[matrix] joined room ${room_id}" &&
     docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq "worker/${WORKER_NAME} reported ready"; then
    break
  fi
  sleep 2
done

log "Driving Matrix -> Leader coordination turn (project ${PROJECT_ID})"
docker cp "${TURN_SCRIPT}" "${MANAGER_CONTAINER}:${MANAGER_TURN}"
nonce="$(cat /proc/sys/kernel/random/uuid)"
turn_output="$(docker exec "${MANAGER_CONTAINER}" "${MANAGER_TURN}" "${room_id}" "${leader_uid}" "${nonce}" "${PROJECT_ID}")"
printf '%s\n' "${turn_output}"
grep -Fq 'LEADER_DONE' <<<"${turn_output}" || die "Leader did not report LEADER_DONE"

log "Verifying immutable bindings on the shared filesystem"
project_binding="/root/agentteams-fs/shared/tiangong/projects/${PROJECT_ID}/project-binding.json"
task_binding="/root/agentteams-fs/shared/tiangong/tasks/design-1/task-binding.json"
docker exec "${CONTAINER_NAME}" test -f "${project_binding}" || die "Project binding missing"
docker exec "${CONTAINER_NAME}" test -f "${task_binding}" || die "Design task binding missing"
team_leader="$(docker exec "${CONTAINER_NAME}" jq -r '.roleBindings.team_leader' "${project_binding}")"
[[ "${team_leader}" == "${WORKER_NAME}" ]] || die "team_leader is ${team_leader}, expected ${WORKER_NAME}"
task_kind="$(docker exec "${CONTAINER_NAME}" jq -r '.taskKind' "${task_binding}")"
[[ "${task_kind}" == "design" ]] || die "taskKind is ${task_kind}, expected design"

log "Verifying hash-chained coordination Evidence"
evidence_file="$(docker exec "${CONTAINER_NAME}" sh -c 'find /root/agentteams-fs/agents/'"${WORKER_NAME}"'/.tiangong -path "*evidence*events.jsonl" -type f 2>/dev/null | head -1')"
[[ -n "${evidence_file}" ]] || die "Evidence chain missing"
docker exec "${CONTAINER_NAME}" jq -es 'any(.[]; .type == "team.project.created")' "${evidence_file}" >/dev/null || die "project.created evidence missing"
docker exec "${CONTAINER_NAME}" jq -es 'any(.[]; .type == "team.task.dispatched")' "${evidence_file}" >/dev/null || die "task.dispatched evidence missing"

printf 'leader_smoke_team_leader_bound=pass\n'
printf 'leader_smoke_design_task_dispatched=pass\n'
printf 'leader_smoke_coordination_evidence=pass\n'
printf 'leader_smoke_roundtrip=pass\n'
