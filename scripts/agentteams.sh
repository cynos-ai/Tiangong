#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly ENV_FILE="${REPO_ROOT}/.env"
readonly RUNTIME_ROOT="${REPO_ROOT}/.runtime/agentteams"
readonly GENERATED_ENV_FILE="${RUNTIME_ROOT}/manager.env"
readonly WORKSPACE_DIR="${RUNTIME_ROOT}/manager"
readonly HOST_SHARE_DIR="${RUNTIME_ROOT}/host-share"
readonly DATA_VOLUME="tiangong-agentteams-data"
readonly SUPPORTED_VERSION="v1.2.2"
readonly INSTALLER_SHA256="8ef28c5bf239a0af2d6b57b946ecee977bf39e6c874cd786b85c7bd094668f9d"
readonly UNINSTALL_CONFIRMATION="delete-tiangong-agentteams-data"

ACTION="${1:-help}"
SERVICE="${2:-manager}"

log() {
  printf '[Tiangong] %s\n' "$*"
}

warn() {
  printf '[Tiangong] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[Tiangong] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/agentteams.sh <command>

Commands:
  init       Create .env from .env.example without overwriting existing config
  up         Install or upgrade the pinned local AgentTeams stack
  start      Start an existing stopped stack without reinstalling
  stop       Stop AgentTeams containers without deleting data
  status     Show containers and local endpoints
  verify     Run local service and Manager readiness checks
  config     Print the effective non-secret configuration
  provider-check
             Validate the provider/model route without changing the stack
  logs       Follow logs (manager by default; pass controller as the second argument)
  login      Print the Element login URL and credential file location
  uninstall  Delete the stack and generated data; requires an explicit target confirmation
  help       Show this help
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

is_allowed_config_key() {
  case "$1" in
    AGENTTEAMS_VERSION|AGENTTEAMS_LANGUAGE|AGENTTEAMS_LLM_PROVIDER|AGENTTEAMS_OPENAI_BASE_URL|AGENTTEAMS_DEFAULT_MODEL|AGENTTEAMS_LLM_API_KEY|AGENTTEAMS_ADMIN_USER|AGENTTEAMS_ADMIN_PASSWORD|AGENTTEAMS_PORT_GATEWAY|AGENTTEAMS_PORT_CONSOLE|AGENTTEAMS_PORT_ELEMENT_WEB|AGENTTEAMS_PORT_MANAGER_CONSOLE|AGENTTEAMS_PORT_DASHBOARD|AGENTTEAMS_MANAGER_RUNTIME|AGENTTEAMS_DEFAULT_WORKER_RUNTIME|AGENTTEAMS_MATRIX_E2EE|AGENTTEAMS_WORKER_IDLE_TIMEOUT|AGENTTEAMS_DASHBOARD|AGENTTEAMS_DASHBOARD_VERSION|AGENTTEAMS_DASHBOARD_IMAGE) return 0 ;;
    *) return 1 ;;
  esac
}

clear_agentteams_environment() {
  local name
  while IFS= read -r name; do
    unset "${name}"
  done < <(compgen -A variable AGENTTEAMS_ || true)
}

load_dotenv() {
  local line line_number=0 key value first last
  declare -A seen=()

  while IFS= read -r line || [[ -n "${line}" ]]; do
    ((line_number += 1))
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" == *=* ]] || die "Invalid ${ENV_FILE}:${line_number}; expected KEY=VALUE."

    key="${line%%=*}"
    value="${line#*=}"
    [[ "${key}" =~ ^[A-Z][A-Z0-9_]*$ ]] || \
      die "Invalid key in ${ENV_FILE}:${line_number}: ${key}"
    is_allowed_config_key "${key}" || \
      die "Unsupported key in ${ENV_FILE}:${line_number}: ${key}"
    [[ -z "${seen[${key}]:-}" ]] || \
      die "Duplicate key in ${ENV_FILE}:${line_number}: ${key}"
    seen["${key}"]=1

    if [[ -n "${value}" ]]; then
      first="${value:0:1}"
      last="${value: -1}"
      if [[ "${first}" == "'" || "${first}" == '"' ]]; then
        [[ "${last}" == "${first}" && ${#value} -ge 2 ]] || \
          die "Unterminated quoted value in ${ENV_FILE}:${line_number}."
        value="${value:1:${#value}-2}"
      fi
    fi
    export "${key}=${value}"
  done <"${ENV_FILE}"
}

validate_port() {
  local name="$1" value="$2" numeric
  [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} must be an integer port, got '${value}'."
  numeric=$((10#${value}))
  ((numeric >= 1 && numeric <= 65535)) || die "${name} is outside 1..65535: ${value}."
}

validate_config() {
  [[ "${AGENTTEAMS_VERSION}" == "${SUPPORTED_VERSION}" ]] || \
    die "Unsupported AGENTTEAMS_VERSION=${AGENTTEAMS_VERSION}; this bootstrap is pinned to ${SUPPORTED_VERSION}."
  [[ "${AGENTTEAMS_MATRIX_E2EE}" =~ ^[01]$ ]] || \
    die "AGENTTEAMS_MATRIX_E2EE must be 0 or 1."
  [[ "${AGENTTEAMS_DASHBOARD}" =~ ^[01]$ ]] || \
    die "AGENTTEAMS_DASHBOARD must be 0 or 1."
  [[ "${AGENTTEAMS_WORKER_IDLE_TIMEOUT}" =~ ^[0-9]+$ ]] || \
    die "AGENTTEAMS_WORKER_IDLE_TIMEOUT must be a non-negative integer."
  case "${AGENTTEAMS_MANAGER_RUNTIME}" in
    copaw|openclaw) ;;
    *) die "Unsupported Manager runtime: ${AGENTTEAMS_MANAGER_RUNTIME}" ;;
  esac
  case "${AGENTTEAMS_DEFAULT_WORKER_RUNTIME}" in
    copaw|openclaw|hermes|openhuman|qwenpaw) ;;
    *) die "Unsupported default Worker runtime: ${AGENTTEAMS_DEFAULT_WORKER_RUNTIME}" ;;
  esac

  local name value
  declare -A used_ports=()
  for name in AGENTTEAMS_PORT_GATEWAY AGENTTEAMS_PORT_CONSOLE \
    AGENTTEAMS_PORT_ELEMENT_WEB AGENTTEAMS_PORT_MANAGER_CONSOLE \
    AGENTTEAMS_PORT_DASHBOARD; do
    value="${!name}"
    validate_port "${name}" "${value}"
    value="$((10#${value}))"
    printf -v "${name}" '%s' "${value}"
    [[ -z "${used_ports[${value}]:-}" ]] || \
      die "Port ${value} is configured more than once (${used_ports[${value}]} and ${name})."
    used_ports["${value}"]="${name}"
  done
}

normalize_base_url() {
  local value="$1"
  value="${value%/}"
  [[ ! "${value}" =~ [[:space:]@] ]] || \
    die "AGENTTEAMS_OPENAI_BASE_URL must not contain whitespace or embedded credentials."
  [[ "${value}" =~ ^https?://[^/?#]+(/[^?#]*)?$ ]] || \
    die "AGENTTEAMS_OPENAI_BASE_URL must be an absolute HTTP(S) URL without query, fragment, or embedded credentials."
  printf '%s' "${value}"
}

provider_route() {
  load_config

  local provider="${AGENTTEAMS_LLM_PROVIDER}" model="${AGENTTEAMS_DEFAULT_MODEL}" \
    base_url="${AGENTTEAMS_OPENAI_BASE_URL:-}" normalized key_state route wire_api
  if [[ "${provider}" == "qwen" && -z "${base_url}" ]]; then
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1"
  fi
  normalized="$(normalize_base_url "${base_url}")"
  key_state=missing
  [[ -n "${AGENTTEAMS_LLM_API_KEY:-}" ]] && key_state=present

  case "${provider}:${normalized}:${model}" in
    qwen:https://dashscope.aliyuncs.com/compatible-mode/v1:qwen*)
      route="agentteams-qwen-native"
      wire_api="provider-managed"
      ;;
    openai-compat:https://api.deepseek.com/v1:deepseek-v4-*)
      route="codex-native-responses"
      wire_api="openai-responses"
      ;;
    openai-compat:https://coding.dashscope.aliyuncs.com/v1:qwen*)
      route="codex-opencodex-chat-bridge"
      wire_api="openai-completions"
      ;;
    *)
      die "Unsupported provider route: provider=${provider}, base_url=${normalized}, model=${model}. Use provider=qwen for DashScope native, DeepSeek Responses, or the Coding Plan Chat bridge."
      ;;
  esac

  cat <<EOF
provider=${provider}
model=${model}
base_url=${normalized}
route=${route}
wire_api=${wire_api}
credential_env=AGENTTEAMS_LLM_API_KEY
credential_state=${key_state}
mutation=none
EOF
}

load_config() {
  [[ -f "${ENV_FILE}" ]] || die "Missing ${ENV_FILE}. Run 'make init', then configure it."
  [[ ! -L "${ENV_FILE}" ]] || die "Refusing symlinked configuration file: ${ENV_FILE}"

  local mode mode_value
  mode="$(file_mode "${ENV_FILE}")"
  mode_value=$((8#${mode}))
  if (((mode_value & 077) != 0)); then
    warn "${ENV_FILE} is readable or writable by other users (mode ${mode}); run chmod 600 '${ENV_FILE}'."
  fi

  clear_agentteams_environment
  load_dotenv

  : "${AGENTTEAMS_VERSION:=${SUPPORTED_VERSION}}"
  : "${AGENTTEAMS_LANGUAGE:=zh}"
  : "${AGENTTEAMS_LLM_PROVIDER:=openai-compat}"
  : "${AGENTTEAMS_DEFAULT_MODEL:=qwen3.5-plus}"
  : "${AGENTTEAMS_ADMIN_USER:=admin}"
  : "${AGENTTEAMS_PORT_GATEWAY:=18080}"
  : "${AGENTTEAMS_PORT_CONSOLE:=18001}"
  : "${AGENTTEAMS_PORT_ELEMENT_WEB:=18088}"
  : "${AGENTTEAMS_PORT_MANAGER_CONSOLE:=18888}"
  : "${AGENTTEAMS_MANAGER_RUNTIME:=copaw}"
  : "${AGENTTEAMS_DEFAULT_WORKER_RUNTIME:=copaw}"
  : "${AGENTTEAMS_MATRIX_E2EE:=0}"
  : "${AGENTTEAMS_WORKER_IDLE_TIMEOUT:=720}"
  : "${AGENTTEAMS_DASHBOARD:=1}"
  : "${AGENTTEAMS_PORT_DASHBOARD:=13000}"

  AGENTTEAMS_LOCAL_ONLY=1
  AGENTTEAMS_ENV_FILE="${GENERATED_ENV_FILE}"
  AGENTTEAMS_DATA_DIR="${DATA_VOLUME}"
  AGENTTEAMS_WORKSPACE_DIR="${WORKSPACE_DIR}"
  AGENTTEAMS_HOST_SHARE_DIR="${HOST_SHARE_DIR}"

  export AGENTTEAMS_VERSION AGENTTEAMS_LANGUAGE
  export AGENTTEAMS_LLM_PROVIDER AGENTTEAMS_DEFAULT_MODEL
  export AGENTTEAMS_ADMIN_USER AGENTTEAMS_LOCAL_ONLY
  export AGENTTEAMS_PORT_GATEWAY AGENTTEAMS_PORT_CONSOLE
  export AGENTTEAMS_PORT_ELEMENT_WEB AGENTTEAMS_PORT_MANAGER_CONSOLE
  export AGENTTEAMS_MANAGER_RUNTIME AGENTTEAMS_DEFAULT_WORKER_RUNTIME
  export AGENTTEAMS_MATRIX_E2EE AGENTTEAMS_WORKER_IDLE_TIMEOUT
  export AGENTTEAMS_DASHBOARD AGENTTEAMS_PORT_DASHBOARD
  export AGENTTEAMS_ENV_FILE AGENTTEAMS_DATA_DIR
  export AGENTTEAMS_WORKSPACE_DIR AGENTTEAMS_HOST_SHARE_DIR
  [[ -n "${AGENTTEAMS_DASHBOARD_VERSION:-}" ]] && export AGENTTEAMS_DASHBOARD_VERSION
  [[ -n "${AGENTTEAMS_DASHBOARD_IMAGE:-}" ]] && export AGENTTEAMS_DASHBOARD_IMAGE

  validate_config
  local path
  for path in "${REPO_ROOT}/.runtime" "${RUNTIME_ROOT}" "${GENERATED_ENV_FILE}" \
    "${WORKSPACE_DIR}" "${HOST_SHARE_DIR}" "${RUNTIME_ROOT}/installers"; do
    [[ ! -L "${path}" ]] || die "Refusing symlinked runtime target: ${path}"
  done
  mkdir -p "${RUNTIME_ROOT}" "${WORKSPACE_DIR}" "${HOST_SHARE_DIR}"
}

validate_up_config() {
  [[ -n "${AGENTTEAMS_LLM_API_KEY:-}" ]] || \
    die "AGENTTEAMS_LLM_API_KEY is empty in ${ENV_FILE}."

  # An empty source value means "generate on first install". During upgrades it
  # must not override the generated value stored in the runtime env file.
  if [[ -z "${AGENTTEAMS_ADMIN_PASSWORD:-}" ]] && [[ -f "${AGENTTEAMS_ENV_FILE}" ]]; then
    unset AGENTTEAMS_ADMIN_PASSWORD
  fi

  export AGENTTEAMS_NON_INTERACTIVE=1
  # Keep an explicit upgrade-mode preference for non-interactive installs.
  export AGENTTEAMS_UPGRADE_KEEP_ALL=1
  export AGENTTEAMS_MOUNT_SOCKET=1
  export AGENTTEAMS_DOCKER_PROXY=0
}

installer_path() {
  printf '%s/installers/%s/agentteams-install.sh\n' \
    "$(dirname "${AGENTTEAMS_ENV_FILE}")" "${AGENTTEAMS_VERSION}"
}

download_installer() (
  require_command curl

  local target url actual
  target="$(installer_path)"
  url="https://raw.githubusercontent.com/agentscope-ai/AgentTeams/${AGENTTEAMS_VERSION}/install/agentteams-install.sh"
  mkdir -p "$(dirname "${target}")"
  trap 'rm -f "${target}.tmp"' EXIT INT TERM

  if [[ -f "${target}" ]] && [[ "$(sha256_file "${target}")" == "${INSTALLER_SHA256}" ]]; then
    log "Using verified cached installer: ${target}"
    printf '%s\n' "${target}"
    return
  fi

  log "Downloading AgentTeams ${AGENTTEAMS_VERSION} installer"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    "${url}" --output "${target}.tmp"
  actual="$(sha256_file "${target}.tmp")"
  [[ "${actual}" == "${INSTALLER_SHA256}" ]] || {
    rm -f "${target}.tmp"
    die "Installer checksum mismatch: expected ${INSTALLER_SHA256}, got ${actual}"
  }
  mv "${target}.tmp" "${target}"
  chmod 700 "${target}"
  printf '%s\n' "${target}"
)

init_env() {
  if [[ -e "${ENV_FILE}" ]]; then
    log "Configuration already exists: ${ENV_FILE}"
    return
  fi
  mkdir -p "$(dirname "${ENV_FILE}")"
  cp "${REPO_ROOT}/.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  log "Created ${ENV_FILE}"
  log "Set AGENTTEAMS_LLM_API_KEY, then run 'make up'."
}

container_names() {
  docker ps -a --format '{{.Names}}' \
    | grep -E '^agentteams-(controller|manager|(copaw-|hermes-)?worker-)' || true
}

generated_value() {
  local key="$1"
  awk -v key="${key}" 'index($0, key "=") == 1 {sub("^[^=]*=", ""); sub("\\r$", ""); print; exit}' \
    "${GENERATED_ENV_FILE}"
}

validate_generated_targets() {
  [[ -f "${GENERATED_ENV_FILE}" ]] || die "Missing generated ownership file: ${GENERATED_ENV_FILE}"
  [[ ! -L "${GENERATED_ENV_FILE}" && ! -L "${WORKSPACE_DIR}" ]] || \
    die "Refusing symlinked generated AgentTeams targets."

  local actual
  actual="$(generated_value AGENTTEAMS_DATA_DIR)"
  [[ "${actual}" == "${DATA_VOLUME}" ]] || \
    die "Generated data volume mismatch: expected ${DATA_VOLUME}, got '${actual}'."
  actual="$(generated_value AGENTTEAMS_WORKSPACE_DIR)"
  [[ "${actual}" == "${WORKSPACE_DIR}" ]] || \
    die "Generated workspace mismatch: expected ${WORKSPACE_DIR}, got '${actual}'."
}

validate_stack_ownership() {
  local names has_global_resources=0
  names="$(container_names)"
  [[ -n "${names}" ]] && has_global_resources=1
  docker volume inspect "${DATA_VOLUME}" >/dev/null 2>&1 && has_global_resources=1
  docker network inspect agentteams-net >/dev/null 2>&1 && has_global_resources=1

  if ((has_global_resources == 1)); then
    [[ -f "${GENERATED_ENV_FILE}" ]] || \
      die "Global AgentTeams resources already exist without Tiangong ownership metadata; refusing to modify them."
    validate_generated_targets
  elif [[ -f "${GENERATED_ENV_FILE}" ]]; then
    validate_generated_targets
  fi
}

run_installer_sanitized() {
  # The pinned upstream installer prints generated credentials in its success
  # banner. Stream only non-sensitive progress; never persist or echo the raw
  # installer output. Credentials remain solely in the owner-only env file.
  bash "$@" 2>&1 | awk '
    BEGIN { IGNORECASE = 1 }
    /密码|password|credential|api[ _-]*key|access[ _-]*token|secret/ {
      if (!redacted) print "[Tiangong] Upstream installer credential output redacted."
      redacted = 1
      next
    }
    { print }
  '
}

up() {
  require_command docker
  require_command jq
  load_config
  validate_up_config
  docker info >/dev/null 2>&1 || die "Docker daemon is not available"
  validate_stack_ownership
  warn "AgentTeams mounts the container-runtime socket; this local profile is not a host security boundary."

  local installer
  installer="$(download_installer | tail -n 1)"
  log "Installing AgentTeams ${AGENTTEAMS_VERSION} from a checksum-verified upstream script"
  run_installer_sanitized "${installer}"
  [[ -f "${AGENTTEAMS_ENV_FILE}" ]] && chmod 600 "${AGENTTEAMS_ENV_FILE}"
  recover_manager_dm_membership 30
  wait_for_readiness
  log "AgentTeams installation completed"
  print_login
}

recover_manager_dm_membership() {
  # AgentTeams CoPaw runtime can persist a sync cursor before processing the
  # controller-created admin-DM invitation. Recover only that exact invitation
  # using the authenticated Manager identity; never join an input-selected room.
  local attempts="${1:-1}" attempt resource room manager token joined sync encoded response matrix_domain
  [[ "${attempts}" =~ ^[1-9][0-9]?$ ]] || die "Invalid Manager DM recovery attempt count"
  [[ -f "${GENERATED_ENV_FILE}" && ! -L "${GENERATED_ENV_FILE}" ]] || \
    die "Manager DM recovery requires the generated owner-only environment file."
  [[ "$(stat -c '%a' "${GENERATED_ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${GENERATED_ENV_FILE}")" == "600" ]] || \
    die "Manager DM recovery requires mode 600 on the generated environment file."
  if [[ "${AGENTTEAMS_MANAGER_RUNTIME}" != "copaw" ]]; then
    log "Manager DM recovery is not required for runtime ${AGENTTEAMS_MANAGER_RUNTIME}"
    return
  fi
  token=""
  matrix_domain="${AGENTTEAMS_MATRIX_DOMAIN:-matrix-local.agentteams.io:18080}"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    resource="$(docker exec agentteams-controller agt get managers default -o json 2>/dev/null || true)"
    if ! jq -e --arg domain "${matrix_domain}" '
      .phase == "Running" and .runtime == "copaw" and
      (.welcomeSent == true or .welcomeSent == false) and
      .matrixUserID == ("@manager:" + $domain) and
      (.roomID | type == "string" and startswith("!") and endswith(":" + $domain))
    ' >/dev/null 2>&1 <<<"${resource}"; then
      sleep 2
      continue
    fi
    if [[ "$(jq -r .welcomeSent <<<"${resource}")" == "true" ]]; then
      log "Manager readiness is already complete"
      return
    fi
    if [[ -z "${token}" ]]; then
      token="$(docker inspect agentteams-manager --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | \
        awk -F= '$1 == "AGENTTEAMS_MANAGER_MATRIX_TOKEN" {sub(/^[^=]*=/, ""); print; exit}')"
      [[ "${token}" =~ ^[A-Za-z0-9._~-]{16,512}$ ]] || die "Manager container Matrix token has an invalid format."
    fi
    room="$(jq -r .roomID <<<"${resource}")"
    manager="$(jq -r .matrixUserID <<<"${resource}")"
    encoded="$(printf '%s' "${room}" | jq -sRr @uri)"
    joined="$(printf 'header = "Authorization: Bearer %s"\n' "${token}" | \
      curl --config - --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:${AGENTTEAMS_PORT_GATEWAY}/_matrix/client/v3/joined_rooms" 2>/dev/null || true)"
    if jq -e --arg room "${room}" 'any(.joined_rooms[]?; . == $room)' >/dev/null 2>&1 <<<"${joined}"; then
      log "Manager identity is already joined to its authoritative admin DM"
      return
    fi
    sync="$(printf 'header = "Authorization: Bearer %s"\n' "${token}" | \
      curl --config - --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:${AGENTTEAMS_PORT_GATEWAY}/_matrix/client/v3/sync?timeout=0&full_state=true" 2>/dev/null || true)"
    if ! jq -e --arg room "${room}" '(.rooms.invite // {}) | has($room)' >/dev/null 2>&1 <<<"${sync}"; then
      sleep 2
      continue
    fi
    response="$(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "${token}" | \
      curl --config - --fail --silent --show-error --max-time 10 --request POST --data '{}' \
      "http://127.0.0.1:${AGENTTEAMS_PORT_GATEWAY}/_matrix/client/v3/rooms/${encoded}/join")" || \
      die "Manager failed to accept its authoritative admin-DM invitation."
    [[ "$(jq -r '.room_id // empty' <<<"${response}")" == "${room}" ]] || \
      die "Manager admin-DM join response did not match the authoritative room."
    log "Recovered Manager admin-DM membership for ${manager}"
    return
  done
  die "Manager authoritative admin-DM invitation was not observable."
}

wait_for_readiness() (
  local attempt output
  output="$(mktemp)"
  trap 'rm -f "${output}"' EXIT INT TERM
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if (verify) >"${output}" 2>&1; then
      cat "${output}"
      return
    fi
    sleep 2
  done
  cat "${output}" >&2
  die "AgentTeams did not become ready within 120 seconds"
)

start_stack() {
  require_command docker
  load_config
  validate_stack_ownership
  local names=()
  mapfile -t names < <(container_names)
  ((${#names[@]} > 0)) || die "No AgentTeams containers found; run 'make up' first."

  docker start agentteams-controller >/dev/null 2>&1 || true
  sleep 2
  local name
  for name in "${names[@]}"; do
    [[ "${name}" == "agentteams-controller" ]] && continue
    docker start "${name}" >/dev/null
  done
  wait_for_readiness
  log "AgentTeams containers started"
}

stop_stack() {
  require_command docker
  load_config
  validate_stack_ownership
  local names=()
  mapfile -t names < <(container_names)
  ((${#names[@]} > 0)) || {
    log "No AgentTeams containers found"
    return
  }

  local name
  for name in "${names[@]}"; do
    [[ "${name}" == "agentteams-controller" ]] && continue
    docker stop "${name}" >/dev/null || true
  done
  docker stop agentteams-controller >/dev/null 2>&1 || true
  log "AgentTeams containers stopped; data was preserved"
}

http_status() {
  local url="$1" code
  if code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 3 --max-time 10 "${url}" 2>/dev/null)"; then
    printf '%s' "${code}"
  else
    printf 'unreachable'
  fi
}

status() {
  require_command docker
  if [[ -f "${ENV_FILE}" ]]; then
    load_config
  fi

  printf '%s\n' 'CONTAINERS'
  docker ps -a --filter 'name=agentteams-' \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
  printf '\nENDPOINTS\n'
  printf 'Element Web:       http://127.0.0.1:%s  [%s]\n' \
    "${AGENTTEAMS_PORT_ELEMENT_WEB:-18088}" \
    "$(http_status "http://127.0.0.1:${AGENTTEAMS_PORT_ELEMENT_WEB:-18088}/")"
  printf 'Gateway:           http://127.0.0.1:%s  [%s]\n' \
    "${AGENTTEAMS_PORT_GATEWAY:-18080}" \
    "$(http_status "http://127.0.0.1:${AGENTTEAMS_PORT_GATEWAY:-18080}/")"
  printf 'Higress Console:   http://127.0.0.1:%s  [%s]\n' \
    "${AGENTTEAMS_PORT_CONSOLE:-18001}" \
    "$(http_status "http://127.0.0.1:${AGENTTEAMS_PORT_CONSOLE:-18001}/")"
  printf 'Manager Console:   http://127.0.0.1:%s  [%s]\n' \
    "${AGENTTEAMS_PORT_MANAGER_CONSOLE:-18888}" \
    "$(http_status "http://127.0.0.1:${AGENTTEAMS_PORT_MANAGER_CONSOLE:-18888}/")"
  if [[ "${AGENTTEAMS_DASHBOARD:-0}" == "1" ]]; then
    printf 'Dashboard:         http://127.0.0.1:%s  [%s]\n' \
      "${AGENTTEAMS_PORT_DASHBOARD:-13000}" \
      "$(http_status "http://127.0.0.1:${AGENTTEAMS_PORT_DASHBOARD:-13000}/")"
  fi
}

verify() {
  require_command curl
  require_command docker
  load_config
  validate_stack_ownership

  local failed=0 code matrix_domain
  for container in agentteams-controller agentteams-manager; do
    if [[ "$(docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null || true)" == "true" ]]; then
      log "PASS container running: ${container}"
    else
      warn "FAIL container not running: ${container}"
      failed=1
    fi
  done

  for endpoint in \
    "element:http://127.0.0.1:${AGENTTEAMS_PORT_ELEMENT_WEB}/" \
    "console:http://127.0.0.1:${AGENTTEAMS_PORT_CONSOLE}/" \
    "manager:http://127.0.0.1:${AGENTTEAMS_PORT_MANAGER_CONSOLE}/"; do
    code="$(http_status "${endpoint#*:}")"
    if [[ "${code}" =~ ^(200|301|302|307|308)$ ]]; then
      log "PASS ${endpoint%%:*} HTTP ${code}"
    else
      warn "FAIL ${endpoint%%:*} HTTP ${code}"
      failed=1
    fi
  done

  matrix_domain="${AGENTTEAMS_MATRIX_DOMAIN:-matrix-local.agentteams.io:18080}"
  if curl --fail --silent --show-error --max-time 10 \
      -H "Host: ${matrix_domain}" \
      "http://127.0.0.1:${AGENTTEAMS_PORT_GATEWAY}/_matrix/client/versions" \
      | grep -q '"versions"'; then
    log "PASS Matrix client API"
  else
    warn "FAIL Matrix client API"
    failed=1
  fi

  if docker exec agentteams-controller curl -fsS \
      http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
    log "PASS MinIO health"
  else
    warn "FAIL MinIO health"
    failed=1
  fi

  local manager_json
  manager_json="$(docker exec agentteams-controller agt \
    get managers default -o json 2>/dev/null || true)"
  if printf '%s' "${manager_json}" | tr -d ' \r\n' | grep -q '"welcomeSent":true'; then
    log "PASS Manager ready and welcome message sent"
  else
    warn "FAIL Manager readiness"
    failed=1
  fi

  ((failed == 0)) || die "AgentTeams verification failed"
  log "All AgentTeams checks passed"
}

print_config() {
  load_config
  cat <<EOF
AGENTTEAMS_VERSION=${AGENTTEAMS_VERSION}
AGENTTEAMS_LLM_PROVIDER=${AGENTTEAMS_LLM_PROVIDER}
AGENTTEAMS_OPENAI_BASE_URL=${AGENTTEAMS_OPENAI_BASE_URL:-}
AGENTTEAMS_DEFAULT_MODEL=${AGENTTEAMS_DEFAULT_MODEL}
AGENTTEAMS_LLM_API_KEY=<redacted>
AGENTTEAMS_ADMIN_USER=${AGENTTEAMS_ADMIN_USER}
AGENTTEAMS_ADMIN_PASSWORD=<redacted-or-generated>
AGENTTEAMS_LOCAL_ONLY=${AGENTTEAMS_LOCAL_ONLY}
AGENTTEAMS_MANAGER_RUNTIME=${AGENTTEAMS_MANAGER_RUNTIME}
AGENTTEAMS_DEFAULT_WORKER_RUNTIME=${AGENTTEAMS_DEFAULT_WORKER_RUNTIME}
AGENTTEAMS_DASHBOARD=${AGENTTEAMS_DASHBOARD}
AGENTTEAMS_PORT_DASHBOARD=${AGENTTEAMS_PORT_DASHBOARD}
AGENTTEAMS_DASHBOARD_VERSION=${AGENTTEAMS_DASHBOARD_VERSION:-}
AGENTTEAMS_ENV_FILE=${AGENTTEAMS_ENV_FILE}
AGENTTEAMS_DATA_DIR=${AGENTTEAMS_DATA_DIR}
AGENTTEAMS_WORKSPACE_DIR=${AGENTTEAMS_WORKSPACE_DIR}
AGENTTEAMS_HOST_SHARE_DIR=${AGENTTEAMS_HOST_SHARE_DIR}
EOF
}

show_logs() {
  require_command docker
  load_config
  validate_stack_ownership
  case "${SERVICE}" in
    manager) docker logs --follow agentteams-manager ;;
    controller) docker logs --follow agentteams-controller ;;
    *) die "Unknown service '${SERVICE}'; use manager or controller" ;;
  esac
}

print_login() {
  cat <<EOF
Element Web: http://127.0.0.1:${AGENTTEAMS_PORT_ELEMENT_WEB}/#/login
Username:    ${AGENTTEAMS_ADMIN_USER}
Credentials: ${AGENTTEAMS_ENV_FILE}

Read the generated password locally with:
  grep '^AGENTTEAMS_ADMIN_PASSWORD=' '${AGENTTEAMS_ENV_FILE}'
EOF
}

uninstall_stack() {
  require_command docker
  load_config
  validate_stack_ownership
  validate_generated_targets

  cat <<EOF
This permanently deletes the Tiangong-owned local AgentTeams stack:
  containers: agentteams-controller, agentteams-manager, and agentteams workers
  network:    agentteams-net
  volume:     ${DATA_VOLUME}
  runtime:    ${RUNTIME_ROOT}

The source configuration ${ENV_FILE} is preserved.
EOF
  [[ "${CONFIRM:-}" == "${UNINSTALL_CONFIRMATION}" ]] || \
    die "Re-run with CONFIRM=${UNINSTALL_CONFIRMATION} to delete these exact targets."

  export AGENTTEAMS_NON_INTERACTIVE=1
  local installer remaining
  installer="$(download_installer | tail -n 1)"
  run_installer_sanitized "${installer}" uninstall

  remaining="$(container_names)"
  [[ -z "${remaining}" ]] || die "Uninstall left AgentTeams containers behind: ${remaining//$'\n'/, }"
  if docker volume inspect "${DATA_VOLUME}" >/dev/null 2>&1; then
    die "Uninstall left Docker volume ${DATA_VOLUME} behind; generated files were preserved for investigation."
  fi

  rm -rf -- "${RUNTIME_ROOT}"
  log "Removed Tiangong AgentTeams generated state; preserved ${ENV_FILE}."
}

case "${ACTION}" in
  init) init_env ;;
  up) up ;;
  start) start_stack ;;
  stop) stop_stack ;;
  status) status ;;
  verify) verify ;;
  recover-manager-readiness) load_config; validate_stack_ownership; recover_manager_dm_membership 1 ;;
  config) print_config ;;
  provider-check) provider_route ;;
  logs) show_logs ;;
  login) load_config; print_login ;;
  uninstall) uninstall_stack ;;
  help|-h|--help) usage ;;
  *) usage; die "Unknown command: ${ACTION}" ;;
esac
