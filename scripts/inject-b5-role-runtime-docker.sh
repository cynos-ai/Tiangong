#!/usr/bin/env bash
set -Eeuo pipefail

# AgentTeams v1.2.2 does not expose Worker environment/runtime bindings in its
# public manifest. This narrow deployment-owned adapter adds only the B5 route
# contract to one already-running Worker, recreating the exact supported
# single-auth-volume topology. It is deliberately not part of the model/tool
# surface and never prints the inherited environment.

readonly CONTAINER="${TIANGONG_B5_WORKER_CONTAINER:-}"
readonly ROLE="${TIANGONG_B5_ROLE_ID:-}"
readonly DOCKER_COMMAND="${TIANGONG_DOCKER_COMMAND:-docker}"
readonly NETWORK="${TIANGONG_AGENTTEAMS_NETWORK:-agentteams-net}"
readonly OWNER="${TIANGONG_DEPLOYMENT_OWNER:-tiangong-deployment}"
readonly COMPONENT="${TIANGONG_B5_INJECTION_COMPONENT:-b5-role-runtime-injection}"
readonly DOCKER_TEMP_DIR="${TIANGONG_DOCKER_TEMP_DIR:-}"
readonly COORDINATION_ENDPOINT="${TIANGONG_B5_COORDINATION_CONTROL_ENDPOINT:-}"
readonly COORDINATION_TOKEN="${TIANGONG_B5_COORDINATION_CONTROL_TOKEN:-}"
readonly ROUTING_REQUIRED="1"

tmp_dir=''
inspect_file=''
env_file=''
docker_error_file=''
backup=''
new_started=0
owns_tmp_dir=0

fail() {
  printf 'b5_role_runtime_injection=fail code=%s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  set +e
  if ((owns_tmp_dir == 1)); then
    [[ -n "${tmp_dir}" ]] && rm -rf -- "${tmp_dir}"
  else
    [[ -z "${inspect_file}" ]] || rm -f -- "${inspect_file}" "${env_file}" "${docker_error_file}"
  fi
  if ((status != 0)) && [[ -n "${backup}" ]]; then
    if ((new_started == 1)); then "${DOCKER_COMMAND}" rm --force "${CONTAINER}" >/dev/null 2>&1 || true; fi
    if "${DOCKER_COMMAND}" container inspect "${backup}" >/dev/null 2>&1; then
      "${DOCKER_COMMAND}" rename "${backup}" "${CONTAINER}" >/dev/null 2>&1 || true
      "${DOCKER_COMMAND}" start "${CONTAINER}" >/dev/null 2>&1 || true
    fi
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

require_command() { command -v "$1" >/dev/null 2>&1 || fail "${2:-COMMAND_NOT_FOUND}"; }
valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }
valid_role() { [[ "$1" =~ ^(leader|designer|implementor|assessor|operator)$ ]]; }
valid_volume_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }
valid_endpoint() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/v1/coordination/admit$ ]] || return 1
  local port="${BASH_REMATCH[1]#?}"
  [[ -z "${port}" || ${#port} -le 5 ]]
}
valid_token() {
  [[ "$1" =~ ^[^[:space:][:cntrl:]]+$ ]] || return 1
  (( ${#1} >= 16 && ${#1} <= 512 ))
}
docker_host_path() {
  local path="$1"
  if command -v wslpath >/dev/null 2>&1 && [[ "${path}" == /* ]]; then
    wslpath -w "${path}"
  elif command -v cygpath >/dev/null 2>&1 && [[ "${path}" == /* ]]; then
    cygpath -w "${path}"
  else
    printf '%s\n' "${path}"
  fi
}

require_command "${DOCKER_COMMAND}"
require_command jq
[[ -n "${CONTAINER}" ]] || fail WORKER_CONTAINER_REQUIRED
[[ -n "${ROLE}" ]] || fail ROLE_REQUIRED
valid_name "${CONTAINER}" || fail WORKER_CONTAINER_INVALID
valid_role "${ROLE}" || fail ROLE_INVALID
valid_endpoint "${COORDINATION_ENDPOINT}" || fail COORDINATION_ENDPOINT_REQUIRED
valid_token "${COORDINATION_TOKEN}" || fail COORDINATION_TOKEN_REQUIRED

if [[ "${ROLE}" == implementor ]]; then
  readonly CODEX_RUNTIME=1
  readonly RUNTIME_LANE=openclaw-canary
  readonly CANARY_REQUIRED=1
  readonly CANARY_ADMISSION=local
  readonly OPENCLAW_RUNTIME=codex
  readonly CODEX_PROVIDER="${TIANGONG_B5_CODEX_PROVIDER:-agentteams-gateway}"
  # Match the pinned local AgentTeams fixture. A deployment using a different
  # model must pass TIANGONG_B5_CODEX_MODEL explicitly so OpenClaw metadata and
  # the Codex preflight cannot silently diverge.
  readonly CODEX_MODEL="${TIANGONG_B5_CODEX_MODEL:-deepseek-v4-flash}"
  readonly CODEX_CACHE_URL="${TIANGONG_B5_CODEX_CAPABILITY_CACHE_URL:-http://tiangong-codex-capability-cache:8788}"
else
  readonly CODEX_RUNTIME=0
  readonly RUNTIME_LANE=''
  readonly CANARY_REQUIRED=0
  readonly CANARY_ADMISSION=''
  readonly OPENCLAW_RUNTIME=pi
  readonly CODEX_PROVIDER=''
  readonly CODEX_MODEL=''
  readonly CODEX_CACHE_URL=''
fi

if [[ "${ROLE}" == implementor ]]; then
  [[ "${CODEX_PROVIDER}" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || fail CODEX_PROVIDER_INVALID
  [[ "${CODEX_MODEL}" =~ ^[A-Za-z0-9._:/-]{1,128}$ ]] || fail CODEX_MODEL_INVALID
  [[ "${CODEX_CACHE_URL}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/-]*)?$ ]] || fail CODEX_CACHE_URL_INVALID
fi

if [[ -n "${DOCKER_TEMP_DIR}" ]]; then
  [[ -d "${DOCKER_TEMP_DIR}" && ! -L "${DOCKER_TEMP_DIR}" ]] || fail INVALID_DOCKER_TEMP_DIR
  tmp_dir="${DOCKER_TEMP_DIR}"
else
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tiangong-b5-role-injection.XXXXXX")"
  owns_tmp_dir=1
fi
chmod 700 "${tmp_dir}"
inspect_file="${tmp_dir}/.tiangong-b5-role-inspect.$$"
env_file="${tmp_dir}/.tiangong-b5-role-env.$$"
docker_error_file="${tmp_dir}/.tiangong-b5-role-docker-error.$$"
"${DOCKER_COMMAND}" inspect "${CONTAINER}" 2>/dev/null | tr -d '\r' >"${inspect_file}" || fail WORKER_NOT_FOUND
if [[ "${TIANGONG_INJECTION_DEBUG:-0}" == 1 ]]; then
  printf 'b5_role_runtime_injection_debug=inspect_exists=%s inspect_bytes=%s\n' \
    "$([[ -f "${inspect_file}" ]] && printf 1 || printf 0)" "$(wc -c <"${inspect_file}" 2>/dev/null || printf 0)" >&2
fi

running="$(jq -r '.[0].State.Running // false' "${inspect_file}")"
if [[ "${running}" != true ]]; then
  [[ "${TIANGONG_B5_ALLOW_STOPPED:-0}" == 1 ]] || fail WORKER_NOT_RUNNING
  [[ "$(jq -r '.[0].State.Paused // false' "${inspect_file}")" == false ]] || fail WORKER_PAUSED
fi
[[ "$(jq -r '.[0].Name // empty' "${inspect_file}")" == "/${CONTAINER}" ]] || fail WORKER_IDENTITY_MISMATCH
member_id="$(jq -r '.[0].Config.Env[]? | select(startswith("AGENTTEAMS_WORKER_NAME=")) | split("=")[1]' "${inspect_file}" | head -n 1)"
valid_name "${member_id}" || fail WORKER_MEMBER_ID_MISSING
image="$(jq -r '.[0].Config.Image // empty' "${inspect_file}")"
entrypoint_count="$(jq -r '.[0].Config.Entrypoint | if type == "array" then length else 0 end' "${inspect_file}")"
[[ -n "${image}" && "${entrypoint_count}" == 1 ]] || fail UNSUPPORTED_WORKER_ENTRYPOINT
entrypoint="$(jq -r '.[0].Config.Entrypoint[0]' "${inspect_file}")"
working_dir="$(jq -r '.[0].Config.WorkingDir // empty' "${inspect_file}")"
user="$(jq -r '.[0].Config.User // empty' "${inspect_file}")"

host_config='.[0].HostConfig'
[[ "$(jq -r "${host_config}.NetworkMode // empty" "${inspect_file}")" == "${NETWORK}" ]] || fail UNSUPPORTED_NETWORK
[[ "$(jq -r "${host_config}.Privileged // false" "${inspect_file}")" == false ]] || fail UNSUPPORTED_PRIVILEGED
[[ "$(jq -r "${host_config}.Devices | if type == \"array\" then length else 0 end" "${inspect_file}")" == 0 ]] || fail UNSUPPORTED_DEVICES
[[ "$(jq -r "${host_config}.Tmpfs | if type == \"object\" then length else 0 end" "${inspect_file}")" == 0 ]] || fail UNSUPPORTED_TMPFS
[[ "$(jq -r "${host_config}.Ulimits | if type == \"array\" then length else 0 end" "${inspect_file}")" == 0 ]] || fail UNSUPPORTED_ULIMITS
[[ "$(jq -r "${host_config}.AutoRemove // false" "${inspect_file}")" == false ]] || fail UNSUPPORTED_AUTO_REMOVE
while IFS= read -r resource; do
  [[ -z "${resource}" ]] || fail UNSUPPORTED_RESOURCE_LIMIT
done < <(jq -r "${host_config} | [ .Memory, .MemorySwap, .NanoCpus, .CpuShares, .CpuQuota, .CpuPeriod, .CpusetCpus, .CpusetMems, .PidsLimit ] | .[] | select(. != null and . != 0 and . != \"\")" "${inspect_file}")

# The v1.2.2 Worker shape we can safely recreate has exactly one AgentTeams
# auth volume and no other mount. Refuse a richer topology rather than silently
# dropping a workspace, binding file, or security mount.
bind_count="$(jq -r "${host_config}.Binds | if type == \"array\" then length else 0 end" "${inspect_file}")"
mount_count="$(jq -r "${host_config}.Mounts | if type == \"array\" then length else 0 end" "${inspect_file}")"
auth_source=''
if [[ "${bind_count}" == 1 && "${mount_count}" == 0 ]]; then
  auth_bind="$(jq -r "${host_config}.Binds[0] // empty" "${inspect_file}")"
  [[ "${auth_bind}" == *:/var/run/secrets/agentteams ]] || fail WORKER_AUTH_VOLUME_MISSING
  auth_source="${auth_bind%%:*}"
elif [[ "${bind_count}" == 0 && "${mount_count}" == 1 ]]; then
  auth_source="$(jq -r "${host_config}.Mounts[0] | select(.Type == \"volume\" and .Target == \"/var/run/secrets/agentteams\") | .Name // .Source // empty" "${inspect_file}")"
  [[ -n "${auth_source}" ]] || fail WORKER_AUTH_VOLUME_MISSING
elif [[ "${bind_count}" == 1 && "${mount_count}" == 1 ]]; then
  # Docker Desktop reports a named bind both in Config.Binds and Config.Mounts.
  auth_bind="$(jq -r "${host_config}.Binds[0] // empty" "${inspect_file}")"
  mount_target="$(jq -r "${host_config}.Mounts[0].Target // empty" "${inspect_file}")"
  mount_name="$(jq -r "${host_config}.Mounts[0].Name // empty" "${inspect_file}")"
  [[ "${auth_bind}" == *:/var/run/secrets/agentteams && "${mount_target}" == /var/run/secrets/agentteams ]] || fail WORKER_AUTH_VOLUME_MISSING
  auth_source="${mount_name:-${auth_bind%%:*}}"
else
  fail UNSUPPORTED_MOUNTS
fi
valid_volume_name "${auth_source}" || fail INVALID_AUTH_VOLUME

# Preserve all non-routing environment entries through an owner-only file.
# Values are never echoed, placed in command arguments, or included in output.
jq -r '.[0].Config.Env[]?
  | select((split("=")[0]) as $key |
      ($key == "TIANGONG_ROLE_ID" or
       $key == "TIANGONG_RUNTIME_ROLE_ROUTING_REQUIRED" or
       $key == "TIANGONG_CODEX_RUNTIME" or
       $key == "TIANGONG_RUNTIME_LANE" or
       $key == "TIANGONG_CANARY_REQUIRED" or
       $key == "TIANGONG_CANARY_ADMISSION" or
       $key == "TIANGONG_MEMBER_COORDINATION_ENABLED" or
       $key == "TIANGONG_MEMBER_ID" or
       $key == "TIANGONG_COORDINATION_CONTROL_ENDPOINT" or
       $key == "TIANGONG_COORDINATION_CONTROL_TOKEN" or
       $key == "OPENCLAW_AGENT_RUNTIME" or
       $key == "OPENCLAW_AGENT_HARNESS_FALLBACK" or
       ($key | startswith("TIANGONG_CODEX_"))) | not)' "${inspect_file}" >"${env_file}"
printf 'TIANGONG_ROLE_ID=%s\nTIANGONG_RUNTIME_ROLE_ROUTING_REQUIRED=%s\nTIANGONG_CODEX_RUNTIME=%s\nOPENCLAW_AGENT_HARNESS_FALLBACK=none\nOPENCLAW_AGENT_RUNTIME=%s\nOPENCLAW_CODEX_DISCOVERY_LIVE=%s\nCODEX_HOME=/root/.codex\n' \
  "${ROLE}" "${ROUTING_REQUIRED}" "${CODEX_RUNTIME}" "${OPENCLAW_RUNTIME}" "${CODEX_RUNTIME}" >>"${env_file}"
printf 'TIANGONG_MEMBER_ID=%s\nTIANGONG_COORDINATION_CONTROL_ENDPOINT=%s\nTIANGONG_COORDINATION_CONTROL_TOKEN=%s\n' \
  "${member_id}" "${COORDINATION_ENDPOINT}" "${COORDINATION_TOKEN}" >>"${env_file}"
if [[ "${ROLE}" == leader ]]; then
  printf 'TIANGONG_MEMBER_COORDINATION_ENABLED=0\n' >>"${env_file}"
else
  printf 'TIANGONG_MEMBER_COORDINATION_ENABLED=1\n' >>"${env_file}"
fi
if [[ -n "${RUNTIME_LANE}" ]]; then
  printf 'TIANGONG_RUNTIME_LANE=%s\nTIANGONG_CANARY_REQUIRED=%s\nTIANGONG_CANARY_ADMISSION=%s\n' \
    "${RUNTIME_LANE}" "${CANARY_REQUIRED}" "${CANARY_ADMISSION}" >>"${env_file}"
  printf 'TIANGONG_CODEX_PROVIDER=%s\nTIANGONG_CODEX_MODEL=%s\nTIANGONG_CODEX_CREDENTIAL_SOURCE=agentteams-consumer-token\nTIANGONG_CODEX_TRANSPORT=auto\nTIANGONG_CODEX_BRIDGE=auto\nTIANGONG_CODEX_CAPABILITY_CACHE_PATH=/var/lib/tiangong-capabilities/codex.json\nTIANGONG_CODEX_CAPABILITY_CACHE_URL=%s\nTIANGONG_CODEX_CAPABILITY_CACHE_SHARED=1\n' \
    "${CODEX_PROVIDER}" "${CODEX_MODEL}" "${CODEX_CACHE_URL}" >>"${env_file}"
fi
chmod 600 "${env_file}"
# Docker Desktop reads the file through the Windows host when this script runs
# under WSL; allow the host projection to observe the just-created file.
sleep 1

run_args=(--detach --name "${CONTAINER}" --network "${NETWORK}" --env-file "$(docker_host_path "${env_file}")")
[[ -n "${working_dir}" ]] && run_args+=(--workdir "${working_dir}")
[[ -n "${user}" ]] && run_args+=(--user "${user}")
[[ "$(jq -r "${host_config}.ReadonlyRootfs // false" "${inspect_file}")" == true ]] && run_args+=(--read-only)
while IFS= read -r cap; do cap="${cap//$'\r'/}"; [[ -n "${cap}" ]] && run_args+=(--cap-add "${cap}"); done < <(jq -r "${host_config}.CapAdd // [] | .[]" "${inspect_file}")
while IFS= read -r cap; do cap="${cap//$'\r'/}"; [[ -n "${cap}" ]] && run_args+=(--cap-drop "${cap}"); done < <(jq -r "${host_config}.CapDrop // [] | .[]" "${inspect_file}")
while IFS= read -r security_opt; do security_opt="${security_opt//$'\r'/}"; [[ -n "${security_opt}" ]] && run_args+=(--security-opt "${security_opt}"); done < <(jq -r "${host_config}.SecurityOpt // [] | .[]" "${inspect_file}")
if [[ "$(jq -r "${host_config}.Init // false" "${inspect_file}")" == true ]]; then run_args+=(--init); fi
restart_name="$(jq -r "${host_config}.RestartPolicy.Name // \"no\"" "${inspect_file}")"
restart_count="$(jq -r "${host_config}.RestartPolicy.MaximumRetryCount // 0" "${inspect_file}")"
case "${restart_name}" in
  ''|no) ;;
  always|unless-stopped) run_args+=(--restart "${restart_name}") ;;
  on-failure)
    [[ "${restart_count}" =~ ^[0-9]+$ ]] || fail UNSUPPORTED_RESTART_POLICY
    if ((restart_count > 0)); then run_args+=(--restart "on-failure:${restart_count}"); else run_args+=(--restart on-failure); fi
    ;;
  *) fail UNSUPPORTED_RESTART_POLICY ;;
esac
run_args+=(--volume "${auth_source}:/var/run/secrets/agentteams")
while IFS= read -r host_mapping; do host_mapping="${host_mapping//$'\r'/}"; [[ -n "${host_mapping}" ]] && run_args+=(--publish "${host_mapping}"); done < <(
  jq -r "${host_config}.PortBindings // {} | to_entries[] | .key as \$container | .value[] | ((if (.HostIp // \"\") == \"\" then \"\" else .HostIp + \":\" end) + .HostPort + \":\" + \$container)" "${inspect_file}"
)
while IFS= read -r exposed; do exposed="${exposed//$'\r'/}"; [[ -n "${exposed}" ]] && run_args+=(--expose "${exposed}"); done < <(jq -r '.[0].Config.ExposedPorts // {} | keys[]' "${inspect_file}")
while IFS= read -r extra_host; do extra_host="${extra_host//$'\r'/}"; [[ -n "${extra_host}" ]] && run_args+=(--add-host "${extra_host}"); done < <(jq -r "${host_config}.ExtraHosts // [] | .[]" "${inspect_file}")
shm_size="$(jq -r "${host_config}.ShmSize // 0" "${inspect_file}")"
[[ "${shm_size}" =~ ^[0-9]+$ ]] && ((shm_size > 0)) && run_args+=(--shm-size "${shm_size}")
while IFS= read -r label; do label="${label//$'\r'/}"; [[ -n "${label}" ]] && run_args+=(--label "${label}"); done < <(jq -r '.[0].Config.Labels // {} | to_entries[] | "\(.key)=\(.value)"' "${inspect_file}")
run_args+=(--label "io.tiangong.owner=${OWNER}" --label "io.tiangong.component=${COMPONENT}" --label 'io.tiangong.schema=1')

backup="${CONTAINER}.tiangong-b5-injection.$(date +%s).$$"
"${DOCKER_COMMAND}" rename "${CONTAINER}" "${backup}" >/dev/null 2>&1 || fail WORKER_RENAME_FAILED
"${DOCKER_COMMAND}" stop --time 30 "${backup}" >/dev/null 2>&1 || fail WORKER_STOP_FAILED
mapfile -t cmd_args < <(jq -r '.[0].Config.Cmd[]?' "${inspect_file}")
if ! MSYS_NO_PATHCONV=1 "${DOCKER_COMMAND}" run "${run_args[@]}" --entrypoint "${entrypoint}" "${image}" "${cmd_args[@]}" >/dev/null 2>"${docker_error_file}"; then
  if [[ "${TIANGONG_INJECTION_DEBUG:-0}" == 1 ]]; then
    printf 'b5_role_runtime_injection_debug=env_file_exists=%s host_env_file=%s\n' \
      "$([[ -f "${env_file}" ]] && printf 1 || printf 0)" "$(docker_host_path "${env_file}")" >&2
    printf 'b5_role_runtime_injection_debug=run_args ' >&2
    printf '%s ' "${run_args[@]}" | sed 's/TIANGONG_CODEX_[A-Z_]*=[^ ]*/TIANGONG_CODEX_REDACTED/g' >&2
    printf '\n' >&2
    tr '\r\n' '  ' <"${docker_error_file}" | cut -c 1-512 >&2
  fi
  fail WORKER_RECREATE_FAILED
fi
new_started=1

# Check the route from inside the new process namespace without exposing any
# environment value. This is the same code path used by the OpenClaw wrapper.
MSYS_NO_PATHCONV=1 "${DOCKER_COMMAND}" exec "${CONTAINER}" node --input-type=module -e '
  const { runtimeRouteFromEnvironment } = await import("/opt/tiangong-worker/agent/runtime-routing.mjs");
  const route = runtimeRouteFromEnvironment(process.env);
  console.log(`b5_route=pass role=${route.roleId} runtime=${route.runtime} fallback=${route.fallback} digest=${route.routeDigest}`);
' >/dev/null 2>&1 || fail ROUTE_VERIFY_FAILED

"${DOCKER_COMMAND}" rm "${backup}" >/dev/null 2>&1 || fail OLD_WORKER_CLEANUP_FAILED
backup=''
printf 'b5_role_runtime_injection=pass container=%s role=%s runtime=%s\n' "${CONTAINER}" "${ROLE}" \
  "$([[ "${ROLE}" == implementor ]] && printf codex-app-server || printf openclaw-built-in)"
