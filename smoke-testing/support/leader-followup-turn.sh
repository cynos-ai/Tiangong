#!/usr/bin/env bash
# Wake the native OpenClaw Leader for the next bounded coordination action.
# Runs inside an authenticated Team Worker container. The caller chooses the
# deterministic phase so the smoke oracle can prove a real Matrix resume,
# without placing a second model loop in Tiangong.
set -Eeuo pipefail
(($# == 8)) || {
  printf 'Usage: %s ROOM_ID LEADER_USER_ID NONCE PHASE PROJECT_ID DESIGN_TASK_ID IMPLEMENT_TASK_ID IMPLEMENTOR\n' "$0" >&2
  exit 2
}
readonly ROOM_ID="$1" LEADER_UID="$2" NONCE="$3" PHASE="$4" PROJECT_ID="$5" DESIGN_TASK_ID="$6" IMPLEMENT_TASK_ID="$7" IMPLEMENTOR="$8"
[[ "${PHASE}" == design || "${PHASE}" == implement ]] || { printf 'followup_phase_invalid=1\n' >&2; exit 2; }
CFG="${OPENCLAW_CONFIG:-${HOME}/openclaw.json}"
if [[ ! -f "${CFG}" && -n "${AGENTTEAMS_WORKER_NAME:-}" ]]; then
  CFG="/root/agentteams-fs/agents/${AGENTTEAMS_WORKER_NAME}/openclaw.json"
fi
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${CFG}")"; homeserver="${homeserver%/}"
token="$(jq -r '.channels.matrix.accessToken // empty' "${CFG}")"
[[ -n "${homeserver}" && -n "${token}" ]] || { printf 'leader_matrix_config_unavailable=1\n' >&2; exit 1; }
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
localpart="${LEADER_UID%%:*}"
if [[ "${PHASE}" == design ]]; then
  PROMPT="${localpart} You are the Tiangong Team Leader resuming the bound project. Call team_check_result with taskId \"${DESIGN_TASK_ID}\". If the current design result is present, call team_decide_task with taskId \"${DESIGN_TASK_ID}\", decision \"accept\", and its resultDigest; then call team_dispatch_task with projectId \"${PROJECT_ID}\", taskId \"${IMPLEMENT_TASK_ID}\", taskKind \"implement\", revisionIndex 0, assignee \"${IMPLEMENTOR}\", objective \"Implement the accepted design and report any missing executable prerequisite as a bounded blocker.\". Reply with LEADER_FOLLOWUP_DONE and a one-line summary."
else
  PROMPT="${localpart} You are the Tiangong Team Leader resuming the bound project after the Implementor handoff. Call team_check_result with taskId \"${IMPLEMENT_TASK_ID}\". Then call team_decide_task with taskId \"${IMPLEMENT_TASK_ID}\" and decision \"blocked\" (include the resultDigest only if the current result has one). Finally call team_report with projectId \"${PROJECT_ID}\", disposition \"RECOVERY_REQUIRED\", and a concise bounded summary of the blocker. Reply with LEADER_FOLLOWUP_DONE and a one-line summary."
fi
FORMATTED="<a href=\"https://matrix.to/#/${LEADER_UID}\">${localpart}</a> ${PROMPT#"${localpart} "}"
body="$(jq -cn --arg b "${PROMPT}" --arg fb "${FORMATTED}" --arg u "${LEADER_UID}" \
  '{msgtype:"m.text",body:$b,format:"org.matrix.custom.html",formatted_body:$fb,"m.mentions":{user_ids:[$u]}}')"
since="$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer ${token}" \
  "${homeserver}/_matrix/client/v3/sync?timeout=0" | jq -r '.next_batch')"
curl --fail --silent --show-error --max-time 30 -X PUT -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/json' --data-binary "${body}" \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/tiangong-leader-followup-${PHASE}-${NONCE}" >/dev/null
printf 'leader_followup_prompt_sent phase=%s\n' "${PHASE}"
for i in $(seq 1 40); do
  q="$(printf '%s' "${since}" | jq -sRr @uri)"
  resp="$(curl --fail --silent --show-error --max-time 45 -H "Authorization: Bearer ${token}" \
    "${homeserver}/_matrix/client/v3/sync?since=${q}&timeout=20000")"
  since="$(printf '%s' "${resp}" | jq -r '.next_batch')"
  msgs="$(printf '%s' "${resp}" | jq -r --arg room "${ROOM_ID}" --arg leader "${LEADER_UID}" \
    '.rooms.join[$room].timeline.events[]? | select(.type=="m.room.message" and .sender==$leader) | .content.body // empty' 2>/dev/null || true)"
  if grep -Fq LEADER_FOLLOWUP_DONE <<<"${msgs}"; then
    printf 'leader_followup=pass phase=%s\n' "${PHASE}"
    exit 0
  fi
  printf '[%d] polling...\n' "${i}" >&2
done
printf 'leader_followup_timeout phase=%s\n' "${PHASE}" >&2
exit 1
