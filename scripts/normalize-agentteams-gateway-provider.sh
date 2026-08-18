#!/usr/bin/env bash
set -Eeuo pipefail

# AgentTeams v1.2.2 passes an OpenAI-compatible Base URL containing /v1 to
# Higress AI Proxy, which appends the request API path again.  The resulting
# /v1/v1/... request is a provider-side 404.  This deployment-owned repair
# keeps the Worker-facing gateway URL unchanged, but stores the provider
# service root (without a trailing /v1) in Higress.  Provider credentials are
# read only inside the controller container and never cross this script's
# stdout, argv, or host filesystem.

readonly ACTION="${1:-normalize}"
readonly CONTROLLER="${TIANGONG_GATEWAY_CONTROLLER_CONTAINER:-agentteams-controller}"
readonly DOCKER_COMMAND="${TIANGONG_DOCKER_COMMAND:-docker}"
readonly PROVIDER_ID="${TIANGONG_GATEWAY_PROVIDER_ID:-openai-compat}"
readonly SNAPSHOT_ID="${TIANGONG_GATEWAY_PROVIDER_SNAPSHOT_ID:-}"
readonly CONSOLE_URL="${TIANGONG_GATEWAY_CONSOLE_URL:-http://127.0.0.1:8001}"

fail() {
  printf 'agentteams_gateway_provider=fail code=%s\n' "$1" >&2
  exit 1
}

valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }
valid_snapshot() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; }

command -v "${DOCKER_COMMAND}" >/dev/null 2>&1 || fail DOCKER_COMMAND_MISSING
valid_name "${CONTROLLER}" || fail CONTROLLER_INVALID
valid_name "${PROVIDER_ID}" || fail PROVIDER_INVALID
[[ "${ACTION}" == normalize || "${ACTION}" == restore ]] || fail ACTION_INVALID
[[ -n "${SNAPSHOT_ID}" ]] || fail SNAPSHOT_REQUIRED
valid_snapshot "${SNAPSHOT_ID}" || fail SNAPSHOT_INVALID

"${DOCKER_COMMAND}" inspect "${CONTROLLER}" >/dev/null 2>&1 || fail CONTROLLER_NOT_FOUND
[[ "$("${DOCKER_COMMAND}" inspect "${CONTROLLER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]] || fail CONTROLLER_NOT_RUNNING

# Feed the helper through stdin so the controller's admin password and
# provider token remain inside the controller process boundary.
"${DOCKER_COMMAND}" exec -i "${CONTROLLER}" bash -s -- \
  "${ACTION}" "${PROVIDER_ID}" "${SNAPSHOT_ID}" "${CONSOLE_URL}" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

action="$1"
provider_id="$2"
snapshot_id="$3"
console_url="$4"
snapshot_file="/tmp/tiangong-gateway-provider-${snapshot_id}.json"
umask 077

fail_remote() {
  printf 'agentteams_gateway_provider=fail code=%s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail_remote CONTROLLER_CURL_MISSING
command -v jq >/dev/null 2>&1 || fail_remote CONTROLLER_JQ_MISSING

login() {
  local status
  status="$(curl -sS -c /tmp/tiangong-gateway-provider-cookie \
    -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg u "${AGENTTEAMS_ADMIN_USER:?}" --arg p "${AGENTTEAMS_ADMIN_PASSWORD:?}" '{username:$u,password:$p}')" \
    -o /dev/null -w '%{http_code}' "${console_url}/session/login")" || fail_remote CONSOLE_LOGIN
  [[ "${status}" == 200 || "${status}" == 201 ]] || fail_remote CONSOLE_LOGIN
}

api_get() {
  curl -sS -f -b /tmp/tiangong-gateway-provider-cookie "$1"
}

api_put() {
  local endpoint="$1" payload="$2" status
  status="$(curl -sS -b /tmp/tiangong-gateway-provider-cookie \
    -X PUT -H 'Content-Type: application/json' --data-binary "${payload}" \
    -o /dev/null -w '%{http_code}' "${endpoint}")" || fail_remote CONSOLE_UPDATE
  [[ "${status}" == 200 || "${status}" == 201 ]] || fail_remote CONSOLE_UPDATE
}

login

if [[ "${action}" == restore ]]; then
  [[ -s "${snapshot_file}" ]] || fail_remote SNAPSHOT_NOT_FOUND
  provider="$(jq -c '.provider' "${snapshot_file}")" || fail_remote SNAPSHOT_INVALID
  service="$(jq -c '.service' "${snapshot_file}")" || fail_remote SNAPSHOT_INVALID
  api_put "${console_url}/v1/ai/providers/${provider_id}" "${provider}"
  api_put "${console_url}/v1/service-sources/${provider_id}" "${service}"
  rm -f -- "${snapshot_file}" /tmp/tiangong-gateway-provider-cookie
  printf 'agentteams_gateway_provider=restore pass provider=%s\n' "${provider_id}"
  exit 0
fi

provider_response="$(api_get "${console_url}/v1/ai/providers/${provider_id}")" || fail_remote PROVIDER_NOT_FOUND
service_response="$(api_get "${console_url}/v1/service-sources/${provider_id}")" || fail_remote SERVICE_SOURCE_NOT_FOUND
provider="$(jq -c '.data // .' <<<"${provider_response}")" || fail_remote PROVIDER_INVALID
service="$(jq -c '.data // .' <<<"${service_response}")" || fail_remote SERVICE_SOURCE_INVALID
original_url="$(jq -r '.rawConfigs.openaiCustomUrl // empty' <<<"${provider}")"
[[ -n "${original_url}" ]] || fail_remote PROVIDER_URL_MISSING

# Always retain a rollback point, including a no-op normalization. The smoke
# driver can therefore call restore unconditionally without guessing whether
# the provider needed a change.
printf '%s\n' "$(jq -cn --argjson provider "${provider}" --argjson service "${service}" '{provider:$provider,service:$service}')" >"${snapshot_file}"

# Only normalize the exact OpenAI-compatible /v1 suffix.  Other provider
# paths (for example /compatible-mode/v1) are intentionally preserved by the
# same rule because Higress needs the service root and appends /v1 itself.
if [[ "${original_url}" =~ ^(https?://[^/@?#[:space:]]+)(/v1)/?$ ]]; then
  normalized_url="${BASH_REMATCH[1]}"
elif [[ "${original_url}" =~ ^https?://[^/@?#[:space:]]+/?$ ]]; then
  normalized_url="${original_url%/}"
else
  printf 'agentteams_gateway_provider=skip provider=%s reason=url_shape\n' "${provider_id}"
  exit 0
fi

authority="${normalized_url#*://}"
scheme="${normalized_url%%://*}"
host="${authority%%:*}"
port="${authority#*:}"
if [[ "${port}" == "${authority}" ]]; then
  [[ "${scheme}" == https ]] && port=443 || port=80
fi
[[ "${host}" =~ ^[A-Za-z0-9.-]+$ ]] || fail_remote PROVIDER_HOST_INVALID
[[ "${port}" =~ ^[0-9]{1,5}$ ]] || fail_remote PROVIDER_PORT_INVALID

if [[ "${original_url}" == "${normalized_url}" ]]; then
  printf 'agentteams_gateway_provider=skip provider=%s reason=already_normalized\n' "${provider_id}"
  exit 0
fi

updated_provider="$(jq -c --arg url "${normalized_url}" '.rawConfigs.openaiCustomUrl=$url' <<<"${provider}")"
updated_service="$(jq -c --arg host "${host}" --arg scheme "${scheme}" --argjson port "${port}" '.domain=$host | .protocol=$scheme | .port=$port' <<<"${service}")"
api_put "${console_url}/v1/ai/providers/${provider_id}" "${updated_provider}"
api_put "${console_url}/v1/service-sources/${provider_id}" "${updated_service}"

verified_provider="$(api_get "${console_url}/v1/ai/providers/${provider_id}" | jq -r '.data.rawConfigs.openaiCustomUrl // .rawConfigs.openaiCustomUrl // empty')"
verified_service="$(api_get "${console_url}/v1/service-sources/${provider_id}" | jq -r '.data.domain // .domain // empty')"
[[ "${verified_provider}" == "${normalized_url}" && "${verified_service}" == "${host}" ]] || fail_remote PROVIDER_VERIFY
rm -f -- /tmp/tiangong-gateway-provider-cookie
printf 'agentteams_gateway_provider=normalize pass provider=%s\n' "${provider_id}"
REMOTE_SCRIPT
