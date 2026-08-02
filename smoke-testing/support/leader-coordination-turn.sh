#!/usr/bin/env bash
# Send a coordination prompt to the Leader over Matrix (formatted-body mention)
# and poll for the LEADER_DONE reply. Runs inside the manager container, which
# holds the Matrix credentials. Usage: ROOM_ID LEADER_USER_ID NONCE PROJECT_ID
set -Eeuo pipefail
(($# == 4)) || { printf 'Usage: %s ROOM_ID LEADER_USER_ID NONCE PROJECT_ID\n' "$0" >&2; exit 2; }
readonly ROOM_ID="$1" LEADER_UID="$2" NONCE="$3" PROJECT_ID="$4"
CFG="${HOME}/openclaw.json"
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${CFG}")"; homeserver="${homeserver%/}"
token="$(jq -r '.channels.matrix.accessToken // empty' "${CFG}")"
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
localpart="${LEADER_UID%%:*}"
PROMPT="${localpart} You are the Tiangong Team Leader. Use your tools to do exactly this, then report:
1. Call team_create_project with projectId \"${PROJECT_ID}\" and roleBindings {designer:\"tiangong-designer-smoke\", implementor:\"tiangong-impl-smoke\", assessor:\"tiangong-assess-smoke\", operator:\"tiangong-op-smoke\"}.
2. Call team_dispatch_task with projectId \"${PROJECT_ID}\", taskId \"design-1\", taskKind \"design\", revisionIndex 0, assignee \"tiangong-designer-smoke\".
Reply with LEADER_DONE and a one-line summary."
FORMATTED="<a href=\"https://matrix.to/#/${LEADER_UID}\">${localpart}</a> ${PROMPT#${localpart} }"
body="$(jq -cn --arg b "${PROMPT}" --arg fb "${FORMATTED}" --arg u "${LEADER_UID}" \
  '{msgtype:"m.text",body:$b,format:"org.matrix.custom.html",formatted_body:$fb,"m.mentions":{user_ids:[$u]}}')"
curl --fail --silent --show-error --max-time 30 -X PUT -H "Authorization: Bearer ${token}" \
  -H 'Content-Type: application/json' --data-binary "${body}" \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/tiangong-leader-${NONCE}" >/dev/null
printf 'leader_prompt_sent=%s\n' "${PROJECT_ID}"
since="$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer ${token}" \
  "${homeserver}/_matrix/client/v3/sync?timeout=0" | jq -r '.next_batch')"
for i in $(seq 1 40); do
  q="$(printf '%s' "${since}" | jq -sRr @uri)"
  resp="$(curl --fail --silent --show-error --max-time 45 -H "Authorization: Bearer ${token}" \
    "${homeserver}/_matrix/client/v3/sync?since=${q}&timeout=20000")"
  since="$(printf '%s' "${resp}" | jq -r '.next_batch')"
  msgs="$(printf '%s' "${resp}" | jq -r --arg room "${ROOM_ID}" --arg leader "${LEADER_UID}" '
    .rooms.join[$room].timeline.events[]?
    | select(.type=="m.room.message" and .sender==$leader) | .content.body // empty' 2>/dev/null || true)"
  if [[ -n "${msgs}" ]]; then printf '%s\n' "${msgs}"; exit 0; fi
  printf '[%d] polling...\n' "${i}" >&2
done
printf 'leader_response_timeout=1\n' >&2
exit 1
