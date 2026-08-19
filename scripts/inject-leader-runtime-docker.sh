#!/usr/bin/env bash
set -Eeuo pipefail

# AgentTeams v1.2.2 has no REST fields for Tiangong Leader binding/env/mount
# injection. This deployment-owned escape hatch supports only the pinned
# single-auth-volume Worker topology, recreates one exact container with a
# read-only binding mount and short Coordination token, then verifies it.

readonly CONTAINER="${TIANGONG_LEADER_WORKER_CONTAINER:-}"
readonly BINDING_FILE="${TIANGONG_LEADER_RUNTIME_BINDING_FILE:-}"
readonly DOCKER_BINDING_FILE="${TIANGONG_DOCKER_BINDING_FILE:-${BINDING_FILE}}"
readonly DOCKER_BINDING_VOLUME="${TIANGONG_DOCKER_BINDING_VOLUME:-}"
readonly DOCKER_COMMAND="${TIANGONG_DOCKER_COMMAND:-docker}"
readonly ROTATE_EXISTING="${TIANGONG_LEADER_INJECTION_ROTATE:-0}"
readonly ENDPOINT="${TIANGONG_COORDINATION_CONTROL_ENDPOINT:-}"
readonly CONTROL_TOKEN="${TIANGONG_COORDINATION_CONTROL_TOKEN:-}"
readonly BINDING_TARGET="${TIANGONG_LEADER_RUNTIME_BINDING_TARGET:-/run/tiangong-leader/leader-binding.json}"
readonly NETWORK="${TIANGONG_AGENTTEAMS_NETWORK:-agentteams-net}"
readonly OWNER="${TIANGONG_DEPLOYMENT_OWNER:-tiangong-deployment}"
readonly COMPONENT="${TIANGONG_LEADER_INJECTION_COMPONENT:-leader-runtime-injection}"
readonly DOCKER_TEMP_DIR="${TIANGONG_DOCKER_TEMP_DIR:-}"
readonly GATEWAY_URL="${TIANGONG_AGENTTEAMS_AI_GATEWAY_URL:-http://aigw-local.agentteams.io:8080}"

tmp_dir=''
inspect_file=''
env_file=''
docker_error_file=''
backup=''
new_started=0
owns_tmp_dir=0

fail() {
  printf 'leader_runtime_injection=fail code=%s\n' "$1" >&2
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
regular_binding() {
  local mode path="$1"
  [[ -n "${path}" && -f "${path}" && ! -L "${path}" ]] || return 1
  mode="$(stat -c '%a' "${path}" 2>/dev/null || stat -f '%Lp' "${path}")"
  if [[ "${mode}" == 600 || "${mode}" == 400 ]]; then return 0; fi
  [[ "${TIANGONG_WINDOWS_ACL_VERIFIED:-0}" == 1 ]] || return 1
  local host_path acl
  if [[ "${OSTYPE:-}" =~ ^(msys|cygwin) ]] && command -v icacls >/dev/null 2>&1; then
    host_path="$(docker_host_path "${path}")"
    acl="$(icacls "${host_path}" 2>/dev/null || true)"
  elif [[ "${OSTYPE:-}" == linux* ]] && command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
    # WSL mounts expose Windows ACLs as a broad synthetic mode. Query the
    # actual ACL through PowerShell before accepting an owner-attested file.
    host_path="$(wslpath -w "${path}")"
    host_path="${host_path//\\//}"
    acl="$(powershell.exe -NoProfile -NonInteractive -Command "Get-Acl -LiteralPath '${host_path}' | Select-Object -ExpandProperty Access | Out-String" 2>/dev/null | tr -d '\r' || true)"
  else
    return 1
  fi
  [[ -n "${acl}" ]] || return 1
  # Inherited ACL markers are normal on Windows; reject only broad principals
  # that would make a credential-bearing binding readable by unrelated users.
  ! grep -Eiq 'Everyone|Authenticated Users|BUILTIN\\Users' <<<"${acl}"
}
valid_endpoint() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/v1/coordination/admit$ ]] || return 1
  local port="${BASH_REMATCH[1]#?}"
  [[ -z "${port}" || ${#port} -le 5 ]]
}
valid_token() {
  [[ "$1" =~ ^[^[:space:][:cntrl:]]+$ ]] || return 1
  (( ${#1} >= 16 && ${#1} <= 512 ))
}
valid_gateway_url() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]
}
docker_host_path() {
  # Docker Desktop on Windows cannot resolve a WSL /tmp path through the
  # daemon unless it is converted to a \\wsl.localhost UNC path. Keep native
  # Windows and Unix paths untouched when the conversion helpers are absent.
  local path="$1" docker_binary docker_binary_real
  docker_binary="$(command -v "${DOCKER_COMMAND}" 2>/dev/null || true)"
  docker_binary_real="$(readlink -f "${docker_binary}" 2>/dev/null || printf '%s' "${docker_binary}")"
  if command -v cygpath >/dev/null 2>&1 && [[ "${OSTYPE:-}" =~ ^(msys|cygwin) && "${path}" == /* ]]; then
    cygpath -w "${path}"
  elif [[ "${docker_binary_real}" == *.exe ]] && command -v wslpath >/dev/null 2>&1 && [[ "${path}" == /* ]]; then
    wslpath -w "${path}"
  else
    printf '%s\n' "${path}"
  fi
}
valid_volume_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]
}

require_command "${DOCKER_COMMAND}"
require_command jq
[[ -n "${CONTAINER}" ]] || fail WORKER_CONTAINER_REQUIRED
[[ -n "${BINDING_FILE}" ]] || fail BINDING_FILE_REQUIRED
[[ -n "${ENDPOINT}" ]] || fail CONTROL_ENDPOINT_REQUIRED
[[ -n "${CONTROL_TOKEN}" ]] || fail CONTROL_TOKEN_REQUIRED
[[ "${ROTATE_EXISTING}" == 0 || "${ROTATE_EXISTING}" == 1 ]] || fail INVALID_ROTATE_FLAG
[[ "${BINDING_TARGET}" == /* && "${BINDING_TARGET}" != *$'\n'* && "${BINDING_TARGET}" != *$'\r'* ]] || fail INVALID_BINDING_TARGET
regular_binding "${BINDING_FILE}" || fail INVALID_BINDING_FILE
if [[ "${DOCKER_BINDING_FILE}" =~ ^[A-Za-z]:/ ]]; then
  [[ "${DOCKER_BINDING_FILE}" != *$'\n'* && "${DOCKER_BINDING_FILE}" != *$'\r'* ]] || fail DOCKER_BINDING_FILE_INVALID
else
  [[ -f "${DOCKER_BINDING_FILE}" && ! -L "${DOCKER_BINDING_FILE}" ]] || fail DOCKER_BINDING_FILE_NOT_FOUND
fi
if [[ -n "${DOCKER_BINDING_VOLUME}" ]]; then
  valid_volume_name "${DOCKER_BINDING_VOLUME}" || fail INVALID_BINDING_VOLUME
  "${DOCKER_COMMAND}" volume inspect "${DOCKER_BINDING_VOLUME}" >/dev/null 2>&1 || fail BINDING_VOLUME_NOT_FOUND
fi
valid_endpoint "${ENDPOINT}" || fail INVALID_CONTROL_ENDPOINT
valid_token "${CONTROL_TOKEN}" || fail INVALID_CONTROL_TOKEN
valid_gateway_url "${GATEWAY_URL}" || fail INVALID_GATEWAY_URL
gateway_domain="${GATEWAY_URL#*://}"
gateway_domain="${gateway_domain%%:*}"

if [[ -n "${DOCKER_TEMP_DIR}" ]]; then
  [[ -d "${DOCKER_TEMP_DIR}" && ! -L "${DOCKER_TEMP_DIR}" ]] || fail INVALID_DOCKER_TEMP_DIR
  tmp_dir="${DOCKER_TEMP_DIR}"
else
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tiangong-leader-injection.XXXXXX")"
  owns_tmp_dir=1
fi
chmod 700 "${tmp_dir}"
inspect_file="${tmp_dir}/.tiangong-leader-inspect.$$"
env_file="${tmp_dir}/.tiangong-leader-env.$$"
docker_error_file="${tmp_dir}/.tiangong-leader-docker-error.$$"
"${DOCKER_COMMAND}" inspect "${CONTAINER}" 2>/dev/null | sed 's/\r//g' >"${inspect_file}" || fail WORKER_NOT_FOUND

running="$(jq -r '.[0].State.Running // false' "${inspect_file}")"
[[ "${running}" == true ]] || fail WORKER_NOT_RUNNING
actual_name="$(jq -r '.[0].Name // empty' "${inspect_file}")"
[[ "${actual_name}" == "/${CONTAINER}" ]] || fail WORKER_IDENTITY_MISMATCH
image="$(jq -r '.[0].Config.Image // empty' "${inspect_file}")"
entrypoint_count="$(jq -r '.[0].Config.Entrypoint | if type == "array" then length else 0 end' "${inspect_file}")"
[[ -n "${image}" && "${entrypoint_count}" == 1 ]] || fail UNSUPPORTED_WORKER_ENTRYPOINT
entrypoint="$(jq -r '.[0].Config.Entrypoint[0]' "${inspect_file}")"
working_dir="$(jq -r '.[0].Config.WorkingDir // empty' "${inspect_file}")"
user="$(jq -r '.[0].Config.User // empty' "${inspect_file}")"

host_config='.[0].HostConfig'
[[ "$(jq -r "${host_config}.NetworkMode // empty" "${inspect_file}")" == "${NETWORK}" ]] || fail UNSUPPORTED_NETWORK
[[ "$(jq -r "${host_config}.Privileged // false" "${inspect_file}")" == false ]] || fail UNSUPPORTED_PRIVILEGED
[[ "$(jq -r "${host_config}.ReadonlyRootfs // false" "${inspect_file}")" == false ]] || fail UNSUPPORTED_ROOTFS
bind_count="$(jq -r "${host_config}.Binds | if type == \"array\" then length else 0 end" "${inspect_file}")"
mount_count="$(jq -r "${host_config}.Mounts | if type == \"array\" then length else 0 end" "${inspect_file}")"
[[ "$(jq -r "${host_config}.Devices | if type == \"array\" then length else 0 end" "${inspect_file}")" == 0 ]] || fail UNSUPPORTED_DEVICES
# Recreating a Worker must not silently drop its hardening or resource boundary.
# Preserve the security flags below and reject non-default limits that this
# narrow adapter does not know how to reproduce exactly.
while IFS= read -r resource; do
  [[ -z "${resource}" ]] || fail UNSUPPORTED_RESOURCE_LIMIT
done < <(jq -r "${host_config} | [ .Memory, .MemorySwap, .NanoCpus, .CpuShares, .CpuQuota, .CpuPeriod, .CpusetCpus, .CpusetMems, .PidsLimit ] | .[] | select(. != null and . != 0 and . != \"\")" "${inspect_file}")
[[ "$(jq -r "${host_config}.Tmpfs | if type == \"object\" then length else 0 end" "${inspect_file}")" == 0 ]] || fail UNSUPPORTED_TMPFS
[[ "$(jq -r "${host_config}.Ulimits | if type == \"array\" then length else 0 end" "${inspect_file}")" == 0 ]] || fail UNSUPPORTED_ULIMITS
[[ "$(jq -r "${host_config}.AutoRemove // false" "${inspect_file}")" == false ]] || fail UNSUPPORTED_AUTO_REMOVE
auth_source=''
if [[ "${bind_count}" == 1 && "${mount_count}" == 0 ]]; then
  auth_bind="$(jq -r "${host_config}.Binds[0] // empty" "${inspect_file}")"
  [[ "${auth_bind}" == *:/var/run/secrets/agentteams ]] || fail WORKER_AUTH_VOLUME_MISSING
  auth_source="${auth_bind%%:*}"
elif [[ "${bind_count}" == 0 && "${mount_count}" == 1 ]]; then
  auth_source="$(jq -r "${host_config}.Mounts[0] | select(.Type == \"volume\" and .Target == \"/var/run/secrets/agentteams\") | .Source // empty" "${inspect_file}")"
  [[ -n "${auth_source}" ]] || fail WORKER_AUTH_VOLUME_MISSING
elif [[ "${bind_count}" == 0 && "${mount_count}" == 2 && "${ROTATE_EXISTING}" == 1 ]]; then
  auth_source="$(jq -r "${host_config}.Mounts[] | select(.Type == \"volume\" and .Target == \"/var/run/secrets/agentteams\") | .Source // empty" "${inspect_file}")"
  [[ -n "${auth_source}" ]] || fail WORKER_AUTH_VOLUME_MISSING
  binding_parent="${BINDING_TARGET%/*}"
  MSYS_NO_PATHCONV=1 jq -e --arg parent "${binding_parent}" '
    ([.[0].HostConfig.Mounts[]? | select(.Target == "/var/run/secrets/agentteams")] | length == 1) and
    ([.[0].HostConfig.Mounts[]? | select(.Target == $parent and (.ReadOnly == true or .RW == false) and .Type == "volume")] | length == 1)
  ' <"${inspect_file}" >/dev/null || {
    fail EXISTING_BINDING_MOUNT_UNSUPPORTED
  }
elif [[ "${bind_count}" == 1 && "${mount_count}" == 1 ]]; then
  # Docker Desktop reports a named auth volume in both Config.Binds and
  # Config.Mounts. Accept only the exact duplicate; never drop a second mount.
  auth_bind="$(jq -r "${host_config}.Binds[0] // empty" "${inspect_file}")"
  mount_target="$(jq -r "${host_config}.Mounts[0].Target // empty" "${inspect_file}")"
  mount_name="$(jq -r "${host_config}.Mounts[0].Name // empty" "${inspect_file}")"
  [[ "${auth_bind}" == *:/var/run/secrets/agentteams && "${mount_target}" == /var/run/secrets/agentteams ]] || fail WORKER_AUTH_VOLUME_MISSING
  auth_source="${mount_name:-${auth_bind%%:*}}"
else
  fail UNSUPPORTED_MOUNTS
fi

if jq -e '
  .[0].Config.Env
  | any(.[]?; startswith("TIANGONG_LEADER_RUNTIME_BINDING_FILE="))
' "${inspect_file}" >/dev/null; then
  [[ "${ROTATE_EXISTING}" == 1 ]] || fail EXISTING_TIANTGONG_INJECTION
fi
if jq -e '
  .[0].Config.Env
  | any(.[]?; startswith("TIANGONG_COORDINATION_DATABASE_URL=") or startswith("TIANGONG_COORDINATION_MATRIX_TOKEN="))
' "${inspect_file}" >/dev/null; then
  fail WORKER_HAS_FORBIDDEN_COORDINATION_SECRET
fi

# Reuse the existing environment through a mode-0600 temporary env-file so
# secrets do not appear in the docker command line or in script output.
jq -r '.[0].Config.Env[]?
  | select(startswith("TIANGONG_LEADER_RUNTIME_BINDING_FILE=") | not)
  | select(startswith("TIANGONG_COORDINATION_CONTROL_ENDPOINT=") | not)
  | select(startswith("TIANGONG_COORDINATION_CONTROL_TOKEN=") | not)
  | select(startswith("AGENTTEAMS_AI_GATEWAY_URL=") | not)
  | select(startswith("AGENTTEAMS_AI_GATEWAY_DOMAIN=") | not)' "${inspect_file}" | while IFS= read -r line; do
  line="${line%$'\r'}"
  [[ "${line}" != *$'\r'* ]] || fail WORKER_ENV_NEWLINE
  printf '%s\n' "${line}"
done >"${env_file}"
{
  printf 'TIANGONG_LEADER_RUNTIME_BINDING_FILE=%s\n' "${BINDING_TARGET}"
  printf 'TIANGONG_COORDINATION_CONTROL_ENDPOINT=%s\n' "${ENDPOINT}"
  printf 'TIANGONG_COORDINATION_CONTROL_TOKEN=%s\n' "${CONTROL_TOKEN}"
  printf 'AGENTTEAMS_AI_GATEWAY_URL=%s\n' "${GATEWAY_URL}"
  printf 'AGENTTEAMS_AI_GATEWAY_DOMAIN=%s\n' "${gateway_domain}"
} >>"${env_file}"
chmod 600 "${env_file}"
sleep 1

run_args=(--detach --name "${CONTAINER}" --network "${NETWORK}" --env-file "$(docker_host_path "${env_file}")")
[[ -n "${working_dir}" ]] && run_args+=(--workdir "${working_dir}")
[[ -n "${user}" ]] && run_args+=(--user "${user}")
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
run_args+=(--mount "type=volume,source=${auth_source},destination=/var/run/secrets/agentteams")
if [[ -n "${DOCKER_BINDING_VOLUME}" ]]; then
  binding_parent="${BINDING_TARGET%/*}"
  run_args+=(--mount "type=volume,source=${DOCKER_BINDING_VOLUME},destination=${binding_parent},readonly")
else
  run_args+=(--mount "type=bind,src=$(docker_host_path "${DOCKER_BINDING_FILE}"),dst=${BINDING_TARGET},readonly")
fi
while IFS= read -r host_mapping; do host_mapping="${host_mapping//$'\r'/}"; run_args+=(--publish "${host_mapping}"); done < <(
  jq -r "${host_config}.PortBindings // {} | to_entries[] | .key as \$container | .value[] | ((if (.HostIp // \"\") == \"\" then \"\" else .HostIp + \":\" end) + .HostPort + \":\" + \$container)" "${inspect_file}"
)
while IFS= read -r exposed; do exposed="${exposed//$'\r'/}"; run_args+=(--expose "${exposed}"); done < <(jq -r '.[0].Config.ExposedPorts // {} | keys[]' "${inspect_file}")
while IFS= read -r extra_host; do extra_host="${extra_host//$'\r'/}"; run_args+=(--add-host "${extra_host}"); done < <(jq -r "${host_config}.ExtraHosts // [] | .[]" "${inspect_file}")
shm_size="$(jq -r "${host_config}.ShmSize // 0" "${inspect_file}")"
[[ "${shm_size}" =~ ^[0-9]+$ ]] && ((shm_size > 0)) && run_args+=(--shm-size "${shm_size}")
while IFS= read -r label; do label="${label//$'\r'/}"; run_args+=(--label "${label}"); done < <(jq -r '.[0].Config.Labels // {} | to_entries[] | "\(.key)=\(.value)"' "${inspect_file}")
run_args+=(--label "io.tiangong.owner=${OWNER}" --label "io.tiangong.component=${COMPONENT}" --label 'io.tiangong.schema=1')

backup="${CONTAINER}.tiangong-injection.$(date +%s).$$"
"${DOCKER_COMMAND}" rename "${CONTAINER}" "${backup}" >/dev/null 2>&1 || fail WORKER_RENAME_FAILED
"${DOCKER_COMMAND}" stop --time 30 "${backup}" >/dev/null 2>&1 || fail WORKER_STOP_FAILED

mapfile -t cmd_args < <(jq -r '.[0].Config.Cmd[]?' "${inspect_file}")
if ! MSYS_NO_PATHCONV=1 "${DOCKER_COMMAND}" run "${run_args[@]}" --entrypoint "${entrypoint}" "${image}" "${cmd_args[@]}" >/dev/null 2>"${docker_error_file}"; then
  if [[ "${TIANGONG_INJECTION_DEBUG:-0}" == 1 ]]; then
    printf 'docker_run_args=' >&2
    printf '%s ' "${run_args[@]}" | sed 's/TIANGONG_COORDINATION_CONTROL_TOKEN=[^ ]*/TIANGONG_COORDINATION_CONTROL_TOKEN=REDACTED/g' >&2
    printf '\n' >&2
    tr '\r\n' '  ' <"${docker_error_file}" | cut -c 1-512 >&2
  fi
  fail WORKER_RECREATE_FAILED
fi
new_started=1

if ! TIANGONG_LEADER_WORKER_CONTAINER="${CONTAINER}" \
  TIANGONG_LEADER_RUNTIME_BINDING_FILE="${BINDING_FILE}" \
  TIANGONG_COORDINATION_CONTROL_ENDPOINT="${ENDPOINT}" \
  TIANGONG_LEADER_RUNTIME_BINDING_TARGET="${BINDING_TARGET}" \
  TIANGONG_DOCKER_BINDING_VOLUME="${DOCKER_BINDING_VOLUME}" \
  TIANGONG_DOCKER_COMMAND="${DOCKER_COMMAND}" \
  MSYS_NO_PATHCONV=1 bash "$(dirname "${BASH_SOURCE[0]}")/verify-leader-runtime-injection.sh" >/dev/null; then
  fail INJECTION_VERIFY_FAILED
fi

"${DOCKER_COMMAND}" rm "${backup}" >/dev/null 2>&1 || fail OLD_WORKER_CLEANUP_FAILED
backup=''
printf 'leader_runtime_injection=pass container=%s endpoint=%s\n' "${CONTAINER}" "${ENDPOINT}"
