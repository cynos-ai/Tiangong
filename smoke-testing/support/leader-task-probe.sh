#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 9)); then
  printf 'Usage: %s ROOM_ID LEADER_USER_ID NONCE PROJECT_ID TASK_ID DESIGNER IMPLEMENTOR ASSESSOR OPERATOR\n' "$0" >&2
  exit 2
fi

readonly ROOM_ID="$1"
readonly LEADER_USER_ID="$2"
readonly NONCE="$3"
readonly PROJECT_ID="$4"
readonly TASK_ID="$5"
readonly DESIGNER="$6"
readonly IMPLEMENTOR="$7"
readonly ASSESSOR="$8"
readonly OPERATOR="$9"
readonly REPLY_MARKER="TIANGONG_B4_LEADER_DONE_${NONCE}"
readonly CONFIG_PATH="${HOME}/openclaw.json"

[[ "${ROOM_ID}" =~ ^![^[:space:]]+$ ]] || exit 2
[[ "${LEADER_USER_ID}" =~ ^@[^:[:space:]]+:[^[:space:]]+$ ]] || exit 2
[[ "${NONCE}" =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || exit 2
[[ -f "${CONFIG_PATH}" ]] || { printf 'leader_task_probe=fail code=CONFIG_MISSING\n' >&2; exit 1; }

homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${CONFIG_PATH}")"
access_token="$(jq -r '.channels.matrix.accessToken // empty' "${CONFIG_PATH}")"
[[ -n "${homeserver}" && -n "${access_token}" ]] || {
  printf 'leader_task_probe=fail code=MATRIX_CONFIG_INCOMPLETE\n' >&2
  exit 1
}
homeserver="${homeserver%/}"
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
since="$(curl --fail --silent --show-error --max-time 30 \
  -H "Authorization: Bearer ${access_token}" \
  "${homeserver}/_matrix/client/v3/sync?timeout=0" | jq -r '.next_batch // empty')"
[[ -n "${since}" ]] || { printf 'leader_task_probe=fail code=SYNC_CURSOR_MISSING\n' >&2; exit 1; }

localpart="${LEADER_USER_ID%%:*}"
prompt="${localpart} You are the Tiangong Team Leader. Use your tools to do exactly this: call team_create_project with projectId ${PROJECT_ID} and roleBindings {designer:${DESIGNER}, implementor:${IMPLEMENTOR}, assessor:${ASSESSOR}, operator:${OPERATOR}}; then call team_dispatch_task with projectId ${PROJECT_ID}, taskId ${TASK_ID}, taskKind design, revisionIndex 0, assignee ${DESIGNER}, objective 'Define the exact bounded implementation and independent verification commands for the runner-isolation fixture.' Reply with ${REPLY_MARKER} and no other prefix."
formatted="<a href=\"https://matrix.to/#/${LEADER_USER_ID}\">${localpart}</a> ${prompt#"${localpart} "}"
body="$(jq -cn --arg b "${prompt}" --arg fb "${formatted}" --arg u "${LEADER_USER_ID}" \
  '{msgtype:"m.text",body:$b,format:"org.matrix.custom.html",formatted_body:$fb,"m.mentions":{user_ids:[$u]}}')"
transaction="tiangong-b4-leader-${NONCE}"
transaction_path="$(printf '%s' "${transaction}" | jq -sRr @uri)"
curl --fail --silent --show-error --max-time 30 -X PUT \
  -H "Authorization: Bearer ${access_token}" -H 'Content-Type: application/json' \
  --data-binary "${body}" \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/${transaction_path}" >/dev/null

for _ in $(seq 1 60); do
  cursor="$(printf '%s' "${since}" | jq -sRr @uri)"
  response="$(curl --fail --silent --show-error --max-time 30 \
    -H "Authorization: Bearer ${access_token}" \
    "${homeserver}/_matrix/client/v3/sync?since=${cursor}&timeout=10000")"
  match="$(printf '%s' "${response}" | jq -r --arg room "${ROOM_ID}" --arg leader "${LEADER_USER_ID}" --arg marker "${REPLY_MARKER}" '
    .rooms.join[$room].timeline.events[]?
    | select(.type == "m.room.message" and .sender == $leader)
    | .content.body // ""
    | select(startswith($marker))
    | $marker
  ' | tail -n 1)"
  if [[ "${match}" == "${REPLY_MARKER}" ]]; then
    printf 'leader_task_probe=pass marker=%s\n' "${REPLY_MARKER}"
    exit 0
  fi
  since="$(printf '%s' "${response}" | jq -r '.next_batch // empty')"
  [[ -n "${since}" ]] || { printf 'leader_task_probe=fail code=SYNC_CURSOR_LOST\n' >&2; exit 1; }
done

printf 'leader_task_probe=fail code=REPLY_TIMEOUT\n' >&2
exit 1
