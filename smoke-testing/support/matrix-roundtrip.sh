#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 4)); then
  printf 'Usage: %s ROOM_ID WORKER_USER_ID NONCE READ_TARGET\n' "$0" >&2
  exit 2
fi

readonly ROOM_ID="$1"
readonly WORKER_USER_ID="$2"
readonly NONCE="$3"
readonly READ_TARGET="$4"
readonly MANAGER_CONFIG="${HOME}/openclaw.json"
readonly EXPECTED_RESPONSE="TIANGONG_MATRIX_PI:${NONCE}"

[[ "${READ_TARGET}" =~ ^matrix-read-probe-[0-9a-f-]+\.txt$ ]] || {
  printf 'ERROR: invalid read target.\n' >&2
  exit 2
}

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
manager_user_id="$(jq -r '.channels.matrix.userId // empty' "${MANAGER_CONFIG}")"
trap 'access_token=""' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ -n "${homeserver}" && -n "${access_token}" && -n "${manager_user_id}" ]] || {
  printf 'ERROR: Manager Matrix configuration is incomplete.\n' >&2
  exit 1
}
homeserver="${homeserver%/}"
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"

initial_sync="$(curl --fail --silent --show-error --max-time 30 \
  -H "Authorization: Bearer ${access_token}" \
  "${homeserver}/_matrix/client/v3/sync?timeout=0")"
since="$(jq -r '.next_batch // empty' <<<"${initial_sync}")"
[[ -n "${since}" ]] || {
  printf 'ERROR: Matrix initial sync did not return a cursor.\n' >&2
  exit 1
}

worker_localpart="${WORKER_USER_ID%%:*}"
request_body="$(jq -cn \
  --arg body "${worker_localpart} Use the read tool exactly once to read ${READ_TARGET}. Then reply with exactly ${EXPECTED_RESPONSE} and no other text." \
  --arg formatted_body "<a href=\"https://matrix.to/#/${WORKER_USER_ID}\">${worker_localpart}</a> Use the read tool exactly once to read ${READ_TARGET}. Then reply with exactly ${EXPECTED_RESPONSE} and no other text." \
  --arg worker "${WORKER_USER_ID}" \
  '{
    msgtype:"m.text",
    body:$body,
    format:"org.matrix.custom.html",
    formatted_body:$formatted_body,
    "m.mentions":{user_ids:[$worker]}
  }')"
transaction_id="tiangong-matrix-smoke-${NONCE}"
transaction_path="$(printf '%s' "${transaction_id}" | jq -sRr @uri)"

curl --fail --silent --show-error --max-time 30 \
  -X PUT \
  -H "Authorization: Bearer ${access_token}" \
  -H 'Content-Type: application/json' \
  --data-binary "${request_body}" \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/${transaction_path}" \
  >/dev/null

for _ in $(seq 1 24); do
  since_query="$(printf '%s' "${since}" | jq -sRr @uri)"
  sync_response="$(curl --fail --silent --show-error --max-time 20 \
    -H "Authorization: Bearer ${access_token}" \
    "${homeserver}/_matrix/client/v3/sync?since=${since_query}&timeout=10000")"
  response_event_id="$(jq -r \
    --arg room "${ROOM_ID}" \
    --arg worker "${WORKER_USER_ID}" \
    --arg expected "${EXPECTED_RESPONSE}" \
    '.rooms.join[$room].timeline.events[]?
      | select(.type == "m.room.message" and .sender == $worker and .content.body == $expected)
      | .event_id' <<<"${sync_response}" | tail -n 1)"
  if [[ -n "${response_event_id}" ]]; then
    printf 'matrix_event=%s\n' "${response_event_id}"
    printf 'matrix_to_pi_response=pass\n'
    exit 0
  fi
  since="$(jq -r '.next_batch // empty' <<<"${sync_response}")"
  [[ -n "${since}" ]] || {
    printf 'ERROR: Matrix sync lost its cursor.\n' >&2
    exit 1
  }
done

printf 'ERROR: timed out waiting for the pi response in Matrix.\n' >&2
exit 1
