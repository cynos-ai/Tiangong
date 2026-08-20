#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly MANAGER="${TIANGONG_AGENTTEAMS_MANAGER_CONTAINER:-agentteams-manager}"
readonly WORKER_NAME="${TIANGONG_MEMBER_ID:-}"
readonly CONTAINER="${TIANGONG_MEMBER_WORKER_CONTAINER:-agentteams-worker-${WORKER_NAME}}"
readonly TARGET_MODEL="${TIANGONG_MEMBER_MODEL:-}"
readonly TARGET_REVISION="${TIANGONG_MEMBER_REVISION:-}"
readonly DOCKER="${TIANGONG_DOCKER_COMMAND:-docker}"
manager_stopped=0

cleanup() {
  local status=$?
  if ((manager_stopped == 1)); then ${DOCKER} start "${MANAGER}" >/dev/null 2>&1 || true; fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

fail() { printf 'member_model_reconcile=fail code=%s\n' "$1" >&2; exit 1; }
valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }
valid_model() { [[ "$1" =~ ^[A-Za-z0-9._:/-]{1,128}$ ]]; }
valid_revision() { [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]]; }

command -v "${DOCKER}" >/dev/null 2>&1 || fail DOCKER_NOT_FOUND
command -v jq >/dev/null 2>&1 || fail JQ_NOT_FOUND
valid_name "${WORKER_NAME}" || fail MEMBER_ID_INVALID
valid_name "${CONTAINER}" || fail WORKER_CONTAINER_INVALID
valid_model "${TARGET_MODEL}" || fail TARGET_MODEL_INVALID
valid_revision "${TARGET_REVISION}" || fail TARGET_REVISION_INVALID

resource="$(${DOCKER} exec "${MANAGER}" agt get workers "${WORKER_NAME}" -o json 2>/dev/null)" || fail WORKER_RESOURCE_NOT_FOUND
current_resource_model="$(jq -r '.model // .spec.model // empty' <<<"${resource}")"
valid_model "${current_resource_model}" || fail RESOURCE_MODEL_INVALID
old_container_id="$(${DOCKER} inspect --format '{{.Id}}' "${CONTAINER}" 2>/dev/null)" || fail WORKER_CONTAINER_NOT_FOUND
current_revision="$(${DOCKER} inspect "${CONTAINER}" | jq -r '.[0].Config.Env[]? | select(startswith("TIANGONG_MEMBER_REVISION=")) | split("=")[1]' | head -n 1)"
current_revision="${current_revision:-0}"
[[ "${current_revision}" =~ ^[0-9]+$ ]] || fail CURRENT_REVISION_INVALID
if ((TARGET_REVISION < current_revision)); then fail REVISION_ROLLBACK_FORBIDDEN; fi

if [[ "${current_resource_model}" != "${TARGET_MODEL}" ]]; then
  ${DOCKER} exec "${MANAGER}" agt update worker --name "${WORKER_NAME}" --model "${TARGET_MODEL}" >/dev/null || fail CONTROL_PLANE_UPDATE_FAILED
fi
for _ in $(seq 1 60); do
  resource="$(${DOCKER} exec "${MANAGER}" agt get workers "${WORKER_NAME}" -o json 2>/dev/null || true)"
  [[ "$(jq -r '.model // .spec.model // empty' <<<"${resource}" 2>/dev/null)" == "${TARGET_MODEL}" ]] && break
  sleep 1
done
[[ "$(jq -r '.model // .spec.model // empty' <<<"${resource}" 2>/dev/null)" == "${TARGET_MODEL}" ]] || fail CONTROL_PLANE_MODEL_TIMEOUT

# A control-plane model update alone is insufficient in AgentTeams v1.2.2.
# Remove only this explicitly named Worker container so the official controller
# recreates it from the updated Worker resource. No volume or Team is deleted.
marker="tiangong-old-session-${old_container_id:0:16}"
${DOCKER} exec "${CONTAINER}" sh -c 'umask 077; : >"/tmp/$1"' sh "${marker}" >/dev/null || fail OLD_SESSION_MARKER_FAILED
${DOCKER} rm --force "${CONTAINER}" >/dev/null || fail STALE_WORKER_REMOVE_FAILED
${DOCKER} exec "${MANAGER}" agt update worker --name "${WORKER_NAME}" --state Stopped >/dev/null || fail CONTROL_PLANE_STOP_FAILED
for _ in $(seq 1 60); do
  phase="$(${DOCKER} exec "${MANAGER}" agt get workers "${WORKER_NAME}" -o json 2>/dev/null | jq -r '.phase // empty' 2>/dev/null || true)"
  [[ "${phase}" == Stopped ]] && break
  sleep 1
done
[[ "${phase}" == Stopped ]] || fail CONTROL_PLANE_STOP_TIMEOUT
${DOCKER} exec "${MANAGER}" agt update worker --name "${WORKER_NAME}" --state Running >/dev/null || fail CONTROL_PLANE_START_FAILED
new_container_id=''
for _ in $(seq 1 180); do
  new_container_id="$(${DOCKER} inspect --format '{{.Id}}' "${CONTAINER}" 2>/dev/null || true)"
  running="$(${DOCKER} inspect --format '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || true)"
  if [[ -n "${new_container_id}" && "${new_container_id}" != "${old_container_id}" && "${running}" == true ]]; then break; fi
  sleep 1
done
[[ -n "${new_container_id}" && "${new_container_id}" != "${old_container_id}" ]] || fail WORKER_RECREATE_TIMEOUT
if ${DOCKER} exec "${CONTAINER}" test -e "/tmp/${marker}"; then fail OLD_SESSION_SURVIVED; fi

actual_model=''
for _ in $(seq 1 120); do
  actual_model="$(${DOCKER} exec "${CONTAINER}" sh -lc 'jq -r ".agents.defaults.model.primary // empty" "$HOME/openclaw.json" 2>/dev/null' 2>/dev/null || true)"
  [[ "${actual_model}" == "agentteams-gateway/${TARGET_MODEL}" ]] && break
  sleep 1
done
[[ "${actual_model}" == "agentteams-gateway/${TARGET_MODEL}" ]] || fail OPENCLAW_MODEL_TIMEOUT

${DOCKER} stop --time 30 "${MANAGER}" >/dev/null || fail MANAGER_STOP_FAILED
manager_stopped=1
TIANGONG_MEMBER_WORKER_CONTAINER="${CONTAINER}" \
TIANGONG_MEMBER_ID="${WORKER_NAME}" \
TIANGONG_MEMBER_MODEL="${TARGET_MODEL}" \
TIANGONG_MEMBER_REVISION="${TARGET_REVISION}" \
  bash "${SCRIPT_DIR}/inject-member-runtime-docker.sh" >/dev/null || fail MEMBER_CONFIG_INJECTION_FAILED
${DOCKER} start "${MANAGER}" >/dev/null || fail MANAGER_START_FAILED
manager_stopped=0

final_container_id="$(${DOCKER} inspect --format '{{.Id}}' "${CONTAINER}" 2>/dev/null)" || fail FINAL_WORKER_MISSING
[[ "${final_container_id}" != "${old_container_id}" ]] || fail OLD_CONTAINER_STILL_BOUND
final_revision="$(${DOCKER} inspect "${CONTAINER}" | jq -r '.[0].Config.Env[]? | select(startswith("TIANGONG_MEMBER_REVISION=")) | split("=")[1]' | head -n 1)"
[[ "${final_revision}" == "${TARGET_REVISION}" ]] || fail MEMBER_REVISION_MISMATCH
if ${DOCKER} exec "${CONTAINER}" test -e "/tmp/${marker}"; then fail OLD_SESSION_SURVIVED; fi
for _ in $(seq 1 60); do
  ${DOCKER} exec "${MANAGER}" agt get workers "${WORKER_NAME}" -o json >/dev/null 2>&1 && break
  sleep 1
done
${DOCKER} exec "${MANAGER}" agt get workers "${WORKER_NAME}" -o json >/dev/null 2>&1 || fail MANAGER_NOT_READY
sleep 5
stable_container_id="$(${DOCKER} inspect --format '{{.Id}}' "${CONTAINER}" 2>/dev/null)" || fail FINAL_WORKER_MISSING
[[ "${stable_container_id}" == "${final_container_id}" ]] || fail CONTROLLER_REPLACED_INJECTED_WORKER
stable_revision="$(${DOCKER} inspect "${CONTAINER}" | jq -r '.[0].Config.Env[]? | select(startswith("TIANGONG_MEMBER_REVISION=")) | split("=")[1]' | head -n 1)"
[[ "${stable_revision}" == "${TARGET_REVISION}" ]] || fail CONTROLLER_RESTORED_STALE_BINDING

printf 'member_model_reconcile=pass worker=%s model=%s revision=%s container_recreated=yes old_session_invalidated=yes old_binding_invalidated=yes\n' \
  "${WORKER_NAME}" "${TARGET_MODEL}" "${TARGET_REVISION}"
