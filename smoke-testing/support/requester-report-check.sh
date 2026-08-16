#!/usr/bin/env bash
# Verify that the authenticated requester can read exactly one durable terminal
# report from the bound Leader in the requester's personal room. Runs inside an
# AgentTeams container and never prints Matrix credentials
# or message content.
# Usage: ROOM_ID LEADER_USER_ID PROJECT_ID DISPOSITION
set -Eeuo pipefail

(($# == 4)) || {
  printf 'Usage: %s ROOM_ID LEADER_USER_ID PROJECT_ID DISPOSITION\n' "$0" >&2
  exit 2
}
readonly ROOM_ID="$1" LEADER_UID="$2" PROJECT_ID="$3" DISPOSITION="$4"
[[ "${DISPOSITION}" =~ ^(DELIVERED|FAILED_SAFE|RECOVERY_REQUIRED)$ ]] || {
  printf 'requester_report_invalid_disposition=1\n' >&2
  exit 2
}
CFG="${OPENCLAW_CONFIG:-${HOME}/openclaw.json}"
if [[ ! -f "${CFG}" && -n "${AGENTTEAMS_WORKER_NAME:-}" ]]; then
  CFG="/root/agentteams-fs/agents/${AGENTTEAMS_WORKER_NAME}/openclaw.json"
fi
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${CFG}")"
homeserver="${homeserver%/}"
token="$(jq -r '.channels.matrix.accessToken // empty' "${CFG}")"
[[ -n "${homeserver}" && -n "${token}" ]] || {
  printf 'requester_report_matrix_config_unavailable=1\n' >&2
  exit 1
}
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
readonly NEEDLE="Tiangong Project terminal: project=${PROJECT_ID} disposition=${DISPOSITION}."

for _ in $(seq 1 120); do
  response="$(curl --fail --silent --show-error --max-time 30 \
    -H "Authorization: Bearer ${token}" \
    "${homeserver}/_matrix/client/v3/rooms/${room_path}/messages?dir=b&limit=200")"
  count="$(jq -r --arg leader "${LEADER_UID}" --arg needle "${NEEDLE}" '
    [.chunk[]?
      | select(.type == "m.room.message" and .sender == $leader)
      | select((.content.body // "") | contains($needle))]
    | length
  ' <<<"${response}")"
  if [[ "${count}" == 1 ]]; then
    printf 'leader_smoke_requester_matrix_report=pass\n'
    exit 0
  fi
  [[ "${count}" == 0 ]] || {
    printf 'requester_report_duplicate_count=%s\n' "${count}" >&2
    exit 1
  }
  sleep 3
done
printf 'requester_report_matrix_timeout=1\n' >&2
exit 1
