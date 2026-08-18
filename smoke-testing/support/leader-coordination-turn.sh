#!/usr/bin/env bash
# Send a coordination prompt to the Leader over Matrix (formatted-body mention)
# and poll for the LEADER_DONE reply. Runs inside an authenticated AgentTeams
# container, which holds the Matrix credentials. Usage:
# ROOM_ID LEADER_USER_ID NONCE PROJECT_ID TASK_ID DESIGNER IMPLEMENTOR ASSESSOR OPERATOR
set -Eeuo pipefail
(($# == 9)) || { printf 'Usage: %s ROOM_ID LEADER_USER_ID NONCE PROJECT_ID TASK_ID DESIGNER IMPLEMENTOR ASSESSOR OPERATOR\n' "$0" >&2; exit 2; }
readonly ROOM_ID="$1" LEADER_UID="$2" NONCE="$3" PROJECT_ID="$4" TASK_ID="$5"
readonly DESIGNER="$6" IMPLEMENTOR="$7" ASSESSOR="$8" OPERATOR="$9"
CFG="${OPENCLAW_CONFIG:-${HOME}/openclaw.json}"
if [[ ! -f "${CFG}" && -n "${AGENTTEAMS_WORKER_NAME:-}" ]]; then
  CFG="/root/agentteams-fs/agents/${AGENTTEAMS_WORKER_NAME}/openclaw.json"
fi
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${CFG}")"; homeserver="${homeserver%/}"
token="$(jq -r '.channels.matrix.accessToken // empty' "${CFG}")"
[[ -n "${homeserver}" && -n "${token}" ]] || { printf 'leader_matrix_config_unavailable=1\n' >&2; exit 1; }
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
localpart="${LEADER_UID%%:*}"
PROMPT="${localpart} You are the Tiangong Team Leader. Use your tools to do exactly this in order: call team_create_project with projectId \"${PROJECT_ID}\" and roleBindings {designer:\"${DESIGNER}\", implementor:\"${IMPLEMENTOR}\", assessor:\"${ASSESSOR}\", operator:\"${OPERATOR}\"}; then call team_dispatch_task with projectId \"${PROJECT_ID}\", taskId \"${TASK_ID}\", taskKind \"design\", revisionIndex 0, assignee \"${DESIGNER}\", objective \"Give a concise protocol-smoke design claim and independent verification commands for the runner-isolation fixture. This is a coordination-only smoke: the Designer must not create, modify, or upload files, must not write AgentTeams-reserved shared/tasks files such as result.md, spec.md, task-binding.json, or result-envelope.json, and must submit only through team_submit_result with no artifactRefs or evidenceRefs.\"; reply with LEADER_DONE and a one-line summary."
FORMATTED="<a href=\"https://matrix.to/#/${LEADER_UID}\">${localpart}</a> ${PROMPT#"${localpart}" }"
body="$(jq -cn --arg b "${PROMPT}" --arg fb "${FORMATTED}" --arg u "${LEADER_UID}" \
  '{msgtype:"m.text",body:$b,format:"org.matrix.custom.html",formatted_body:$fb,"m.mentions":{user_ids:[$u]}}')"
since="$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer ${token}" \
  "${homeserver}/_matrix/client/v3/sync?timeout=0" | jq -r '.next_batch')"
curl --fail --silent --show-error --max-time 30 -X PUT -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/json' --data-binary "${body}" \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/tiangong-leader-${NONCE}" >/dev/null
printf 'leader_prompt_sent=%s\n' "${PROJECT_ID}"
for i in $(seq 1 40); do
  q="$(printf '%s' "${since}" | jq -sRr @uri)"
  resp="$(curl --fail --silent --show-error --max-time 45 -H "Authorization: Bearer ${token}" \
    "${homeserver}/_matrix/client/v3/sync?since=${q}&timeout=20000")"
  since="$(printf '%s' "${resp}" | jq -r '.next_batch')"
  msgs="$(printf '%s' "${resp}" | jq -r --arg room "${ROOM_ID}" --arg leader "${LEADER_UID}" '
    .rooms.join[$room].timeline.events[]?
    | select(.type=="m.room.message" and .sender==$leader) | .content.body // empty' 2>/dev/null || true)"
  if grep -Fq LEADER_DONE <<<"${msgs}"; then printf '%s\n' "${msgs}"; exit 0; fi
  printf '[%d] polling...\n' "${i}" >&2
done
printf 'leader_response_timeout=1\n' >&2
exit 1
