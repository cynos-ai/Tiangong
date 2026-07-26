#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  printf 'Usage:\n' >&2
  printf '  %s members CONFIG_PATH ROOM_ID EXPECTED_USER_IDS ABSENT_USER_IDS\n' "$0" >&2
  printf '  %s event-visible CONFIG_PATH ROOM_ID EXPECTED_SENDER EXPECTED_USER NONCE\n' "$0" >&2
  exit 2
}

MODE="${1:-}"
case "${MODE}" in
  members)
    (($# == 5)) || usage
    readonly CONFIG_PATH="$2"
    readonly ROOM_ID="$3"
    readonly EXPECTED_USER_IDS="$4"
    readonly ABSENT_USER_IDS="$5"
    ;;
  event-visible)
    (($# == 6)) || usage
    readonly CONFIG_PATH="$2"
    readonly ROOM_ID="$3"
    readonly EXPECTED_SENDER="$4"
    readonly EXPECTED_USER="$5"
    readonly NONCE="$6"
    ;;
  *) usage ;;
esac

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

authed_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "${access_token}" | \
    curl --fail --silent --show-error --max-time 30 -K - "$@"
}

check_user_ids() {
  local joined="$1" expectation="$2" values="$3" user_id
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

if [[ "${MODE}" == members ]]; then
  joined="$(authed_curl "${homeserver}/_matrix/client/v3/rooms/${room_path}/joined_members")"
  check_user_ids "${joined}" expected "${EXPECTED_USER_IDS}"
  check_user_ids "${joined}" absent "${ABSENT_USER_IDS}"
  printf 'matrix_peer_team_room_topology=pass\n'
  exit 0
fi

for user_id in "${EXPECTED_SENDER}" "${EXPECTED_USER}"; do
  [[ "${user_id}" =~ ^@[^:[:space:]]+:[^[:space:]]+$ ]] || {
    printf 'ERROR: invalid Matrix event visibility user ID.\n' >&2
    exit 1
  }
done
[[ "${NONCE}" =~ ^[0-9a-f-]{36}$ ]] || {
  printf 'ERROR: invalid Matrix event visibility nonce.\n' >&2
  exit 1
}
messages="$(authed_curl \
  "${homeserver}/_matrix/client/v3/rooms/${room_path}/messages?dir=b&limit=64")"
jq -e \
  --arg sender "${EXPECTED_SENDER}" \
  --arg user "${EXPECTED_USER}" \
  --arg nonce "${NONCE}" '
    [.chunk[] | select(
      .type == "m.room.message" and
      .sender == $sender and
      ((.content.body // "") | contains("TG_PEER_PING nonce=" + $nonce)) and
      ((.content.body // "") | contains($user)) and
      (((.content["m.mentions"].user_ids // []) | index($user)) != null)
    )] | length == 1
  ' <<<"${messages}" >/dev/null || {
    printf 'ERROR: expected peer ping is not visible to the target Worker account.\n' >&2
    exit 1
  }
printf 'matrix_peer_ping_visible_to_target_account=pass\n'
