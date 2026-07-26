#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 4)); then
  printf 'Usage: %s CONFIG_PATH ROOM_ID EXPECTED_USER_IDS ABSENT_USER_IDS\n' "$0" >&2
  exit 2
fi

readonly CONFIG_PATH="$1"
readonly ROOM_ID="$2"
readonly EXPECTED_USER_IDS="$3"
readonly ABSENT_USER_IDS="$4"

[[ -f "${CONFIG_PATH}" && ! -L "${CONFIG_PATH}" ]] || {
  printf 'ERROR: Matrix configuration is missing or symlinked.\n' >&2
  exit 1
}
for command in curl jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'ERROR: missing required command: %s\n' "${command}" >&2
    exit 1
  }
done

homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${CONFIG_PATH}")"
access_token="$(jq -r '.channels.matrix.accessToken // empty' "${CONFIG_PATH}")"
trap 'access_token=""' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ -n "${homeserver}" && -n "${access_token}" && -n "${ROOM_ID}" ]] || {
  printf 'ERROR: Matrix room observation inputs are incomplete.\n' >&2
  exit 1
}
homeserver="${homeserver%/}"
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
joined="$(printf 'header = "Authorization: Bearer %s"\n' "${access_token}" | \
  curl --fail --silent --show-error --max-time 30 -K - \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/joined_members")"

check_user_ids() {
  local expectation="$1" values="$2" user_id
  [[ -n "${values}" ]] || return 0
  IFS=',' read -r -a user_ids <<<"${values}"
  for user_id in "${user_ids[@]}"; do
    [[ "${user_id}" =~ ^@[^:[:space:]]+:[^[:space:]]+$ ]] || {
      printf 'ERROR: invalid Matrix user ID in %s set.\n' "${expectation}" >&2
      return 1
    }
    if [[ "${expectation}" == expected ]]; then
      jq -e --arg user "${user_id}" '.joined[$user] != null' <<<"${joined}" >/dev/null || {
        printf 'ERROR: expected Matrix member is absent: %s\n' "${user_id}" >&2
        return 1
      }
    else
      jq -e --arg user "${user_id}" '.joined[$user] == null' <<<"${joined}" >/dev/null || {
        printf 'ERROR: forbidden Matrix member is present: %s\n' "${user_id}" >&2
        return 1
      }
    fi
  done
}

check_user_ids expected "${EXPECTED_USER_IDS}"
check_user_ids absent "${ABSENT_USER_IDS}"
printf 'matrix_peer_team_room_topology=pass\n'
