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

# Keep recovery turns small. Coding Plan models are more reliable when a
# Matrix resume does not combine result inspection, a durable decision, and a
# new dispatch in one model response. Markers are the only result oracle; no
# model prose is persisted or printed.
send_step() {
  local step="$1" marker="$2" prompt_text="$3" prompt formatted body since q resp msgs i
  prompt="${localpart} ${prompt_text} Reply with ${marker} and a one-line summary after the requested tool call(s) complete."
  formatted="<a href=\"https://matrix.to/#/${LEADER_UID}\">${localpart}</a> ${prompt#"${localpart} "}"
  body="$(jq -cn --arg b "${prompt}" --arg fb "${formatted}" --arg u "${LEADER_UID}" \
    '{msgtype:"m.text",body:$b,format:"org.matrix.custom.html",formatted_body:$fb,"m.mentions":{user_ids:[$u]}}')"
  since="$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer ${token}" \
    "${homeserver}/_matrix/client/v3/sync?timeout=0" | jq -r '.next_batch')"
  curl --fail --silent --show-error --max-time 30 -X PUT -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' --data-binary "${body}" \
    "${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/tiangong-leader-followup-${PHASE}-${step}-${NONCE}" >/dev/null
  printf 'leader_followup_prompt_sent phase=%s step=%s\n' "${PHASE}" "${step}"
  for i in $(seq 1 40); do
    q="$(printf '%s' "${since}" | jq -sRr @uri)"
    resp="$(curl --fail --silent --show-error --max-time 45 -H "Authorization: Bearer ${token}" \
      "${homeserver}/_matrix/client/v3/sync?since=${q}&timeout=20000")"
    since="$(printf '%s' "${resp}" | jq -r '.next_batch')"
    msgs="$(printf '%s' "${resp}" | jq -r --arg room "${ROOM_ID}" --arg leader "${LEADER_UID}" \
      '.rooms.join[$room].timeline.events[]? | select(.type=="m.room.message" and .sender==$leader) | .content.body // empty' 2>/dev/null || true)"
    if grep -Fq "${marker}" <<<"${msgs}"; then return 0; fi
    printf '[%s:%d] polling...\n' "${step}" "${i}" >&2
  done
  printf 'leader_followup_timeout phase=%s step=%s\n' "${PHASE}" "${step}" >&2
  return 1
}

if [[ "${PHASE}" == design ]]; then
  send_step check LEADER_RESULT_CHECKED \
    "You are the Tiangong Team Leader resuming the bound project. Call team_check_result with taskId \"${DESIGN_TASK_ID}\"."
  send_step decide LEADER_DECISION_DONE \
    "Call team_check_result with taskId \"${DESIGN_TASK_ID}\". If its result is present, call team_decide_task with taskId \"${DESIGN_TASK_ID}\", decision \"accept\", and the returned resultDigest."
  send_step dispatch LEADER_FOLLOWUP_DONE \
    "Call team_dispatch_task with projectId \"${PROJECT_ID}\", taskId \"${IMPLEMENT_TASK_ID}\", taskKind \"implement\", revisionIndex 0, assignee \"${IMPLEMENTOR}\", objective \"Implement the accepted design and report any missing executable prerequisite as a bounded blocker.\""
else
  send_step check LEADER_RESULT_CHECKED \
    "You are the Tiangong Team Leader resuming the bound project after the Implementor handoff. Call team_check_result with taskId \"${IMPLEMENT_TASK_ID}\"."
  send_step decide LEADER_DECISION_DONE \
    "Call team_check_result with taskId \"${IMPLEMENT_TASK_ID}\". Then call team_decide_task with taskId \"${IMPLEMENT_TASK_ID}\" and decision \"blocked\", including the resultDigest only if the current result has one."
  send_step report LEADER_FOLLOWUP_DONE \
    "Call team_report with projectId \"${PROJECT_ID}\", disposition \"RECOVERY_REQUIRED\", and a concise bounded summary of the blocker."
fi
printf 'leader_followup=pass phase=%s\n' "${PHASE}"
