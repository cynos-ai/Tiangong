#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly TEAM_NAME="tiangong-team-smoke"
readonly LEADER_NAME="tiangong-team-smoke-leader"
readonly MATRIX_DOMAIN="${AGENTTEAMS_MATRIX_DOMAIN:-}"
readonly HOMESERVER="${AGENTTEAMS_MATRIX_URL%/}"
readonly ADMIN_USER="${AGENTTEAMS_ADMIN_USER:-}"

for command in curl jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'ERROR: missing required command: %s\n' "${command}" >&2
    exit 1
  }
done
[[ -n "${HOMESERVER}" && -n "${MATRIX_DOMAIN}" && -n "${ADMIN_USER}" && \
   -n "${AGENTTEAMS_ADMIN_PASSWORD:-}" ]] || {
  printf 'ERROR: controller Matrix cleanup environment is incomplete.\n' >&2
  exit 1
}

password="${AGENTTEAMS_ADMIN_PASSWORD}"
login_body="$(jq -cn --arg user "${ADMIN_USER}" --arg password "${password}" \
  '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password}')"
login_response="$(printf '%s' "${login_body}" | curl --fail --silent --show-error --max-time 30 \
  -H 'Content-Type: application/json' --data-binary @- \
  "${HOMESERVER}/_matrix/client/v3/login")"
access_token="$(jq -r '.access_token // empty' <<<"${login_response}")"
[[ -n "${access_token}" ]] || {
  printf 'ERROR: Matrix cleanup login did not return a token.\n' >&2
  exit 1
}

clear_sensitive() {
  local status=$?
  set +e
  if [[ -n "${access_token:-}" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "${access_token}" | \
      curl --silent --show-error --output /dev/null --max-time 15 -K - \
      -X POST "${HOMESERVER}/_matrix/client/v3/logout" >/dev/null 2>&1 || true
  fi
  access_token=""
  password=""
  login_body=""
  login_response=""
  exit "${status}"
}
trap clear_sensitive EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

aliases=(
  "team:#agentteams-team-${TEAM_NAME}:${MATRIX_DOMAIN}"
  "leader_dm:#agentteams-leader-dm-${LEADER_NAME}:${MATRIX_DOMAIN}"
)
for entry in "${aliases[@]}"; do
  label="${entry%%:*}"
  alias="${entry#*:}"
  encoded="$(printf '%s' "${alias}" | jq -sRr @uri)"
  code="$(printf 'header = "Authorization: Bearer %s"\n' "${access_token}" | \
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 30 -K - -X DELETE \
    "${HOMESERVER}/_matrix/client/v3/directory/room/${encoded}")"
  [[ "${code}" == "200" || "${code}" == "404" ]] || {
    printf 'ERROR: Matrix alias cleanup failed for %s (HTTP %s).\n' "${label}" "${code}" >&2
    exit 1
  }
  printf 'matrix_alias_%s_cleanup=pass\n' "${label}"
done
