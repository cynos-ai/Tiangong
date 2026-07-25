#!/usr/bin/env bash
set -Eeuo pipefail

if (($# < 4 || $# > 5)); then
  printf 'Usage: %s request|approve|replay ROOM_ID WORKER_USER_ID NONCE [APPROVAL_ID]\n' "$0" >&2
  exit 2
fi

readonly ACTION="$1"
readonly ROOM_ID="$2"
readonly WORKER_USER_ID="$3"
readonly NONCE="$4"
readonly APPROVAL_ID="${5:-}"
readonly MANAGER_CONFIG="${HOME}/openclaw.json"
readonly TARGET="approval-probe-${NONCE}.txt"

case "${ACTION}" in
  request) [[ -z "${APPROVAL_ID}" ]] || exit 2 ;;
  approve|replay) [[ "${APPROVAL_ID}" =~ ^approval-[0-9a-f]{24}$ ]] || exit 2 ;;
  *) exit 2 ;;
esac

for command in curl jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'ERROR: missing required command: %s\n' "${command}" >&2
    exit 1
  }
done
[[ -f "${MANAGER_CONFIG}" ]] || {
  printf 'ERROR: Manager Matrix configuration not found.\n' >&2
  exit 1
}

homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${MANAGER_CONFIG}")"
access_token="$(jq -r '.channels.matrix.accessToken // empty' "${MANAGER_CONFIG}")"
trap 'access_token=""' EXIT
[[ -n "${homeserver}" && -n "${access_token}" ]] || exit 1
homeserver="${homeserver%/}"
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
worker_localpart="${WORKER_USER_ID%%:*}"

initial_sync="$(curl --fail --silent --show-error --max-time 30 \
  -H "Authorization: Bearer ${access_token}" \
  "${homeserver}/_matrix/client/v3/sync?timeout=0")"
since="$(jq -r '.next_batch // empty' <<<"${initial_sync}")"
[[ -n "${since}" ]] || exit 1

if [[ "${ACTION}" == request ]]; then
  body="${worker_localpart} Use the write tool exactly once to write exactly ${NONCE} (with no trailing newline) to ${TARGET}. Do not call any other tool and do not claim success before the tool executes."
  formatted_body="<a href=\"https://matrix.to/#/${WORKER_USER_ID}\">${worker_localpart}</a> Use the write tool exactly once to write exactly ${NONCE} (with no trailing newline) to ${TARGET}. Do not call any other tool and do not claim success before the tool executes."
else
  body="${worker_localpart} APPROVE ${APPROVAL_ID}"
  formatted_body="<a href=\"https://matrix.to/#/${WORKER_USER_ID}\">${worker_localpart}</a> APPROVE ${APPROVAL_ID}"
fi
request_body="$(jq -cn \
  --arg body "${body}" \
  --arg formatted_body "${formatted_body}" \
  --arg worker "${WORKER_USER_ID}" \
  '{msgtype:"m.text",body:$body,format:"org.matrix.custom.html",formatted_body:$formatted_body,"m.mentions":{user_ids:[$worker]}}')"
transaction_id="tiangong-approval-${ACTION}-${NONCE}-$(date +%s%N)"
transaction_path="$(printf '%s' "${transaction_id}" | jq -sRr @uri)"
curl --fail --silent --show-error --max-time 30 \
  -X PUT \
  -H "Authorization: Bearer ${access_token}" \
  -H 'Content-Type: application/json' \
  --data-binary "${request_body}" \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/${transaction_path}" \
  >/dev/null

for _ in $(seq 1 30); do
  since_query="$(printf '%s' "${since}" | jq -sRr @uri)"
  sync_response="$(curl --fail --silent --show-error --max-time 20 \
    -H "Authorization: Bearer ${access_token}" \
    "${homeserver}/_matrix/client/v3/sync?since=${since_query}&timeout=10000")"
  if [[ "${ACTION}" == request ]]; then
    response_body="$(jq -r \
      --arg room "${ROOM_ID}" \
      --arg worker "${WORKER_USER_ID}" \
      --arg target "Target: ${TARGET}" \
      '[.rooms.join[$room].timeline.events[]?
        | select(.type == "m.room.message" and .sender == $worker)
        | .content.body
        | select(startswith("Approval required; the tool has not executed."))
        | select(contains($target))] | last // ""' <<<"${sync_response}")"
    if [[ -n "${response_body}" ]]; then
      approval_id="$(awk -F': ' '$1 == "Approval ID" { print $2 }' <<<"${response_body}" | tail -n 1)"
      [[ "${approval_id}" =~ ^approval-[0-9a-f]{24}$ ]] || {
        printf 'ERROR: approval response did not contain a valid identifier.\n%s\n' \
          "${response_body}" >&2
        exit 1
      }
      printf 'approval_id=%s\n' "${approval_id}"
      printf 'matrix_write_pending=pass\n'
      exit 0
    fi
  else
    expected="Approved and executed ${APPROVAL_ID}: write ${TARGET}."
    if [[ "${ACTION}" == replay ]]; then
      expected+=" The prior completed result was replayed; no duplicate execution occurred."
    fi
    response_event="$(jq -r \
      --arg room "${ROOM_ID}" \
      --arg worker "${WORKER_USER_ID}" \
      --arg expected "${expected}" \
      '.rooms.join[$room].timeline.events[]?
        | select(.type == "m.room.message" and .sender == $worker and .content.body == $expected)
        | .event_id' <<<"${sync_response}" | tail -n 1)"
    if [[ -n "${response_event}" ]]; then
      printf 'matrix_event=%s\n' "${response_event}"
      printf 'matrix_write_%s=pass\n' "${ACTION}"
      exit 0
    fi
  fi
  since="$(jq -r '.next_batch // empty' <<<"${sync_response}")"
  [[ -n "${since}" ]] || exit 1
done

printf 'ERROR: timed out waiting for Matrix approval response (%s).\n' "${ACTION}" >&2
exit 1
