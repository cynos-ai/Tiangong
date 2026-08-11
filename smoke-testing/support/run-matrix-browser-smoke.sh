#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly SERVER="${SCRIPT_DIR}/run-matrix-browser-smoke.mjs"
readonly STATE_ROOT="${REPO_ROOT}/.runtime"
readonly STATE_DIR="${STATE_ROOT}/matrix-browser-p0"
readonly PID_FILE="${STATE_DIR}/server.pid"
readonly SERVER_RECORD="${STATE_DIR}/server.json"
readonly SERVER_LOG="${STATE_DIR}/server.log"
readonly SERVER_ERROR="${STATE_DIR}/server.error.log"

log() {
  printf '[Tiangong] %s\n' "$*"
}

die() {
  printf '[Tiangong] ERROR: %s\n' "$*" >&2
  exit 1
}

require_assets() {
  command -v node >/dev/null 2>&1 || die 'node is required.'
  command -v curl >/dev/null 2>&1 || die 'curl is required.'
  command -v jq >/dev/null 2>&1 || die 'jq is required.'
  [[ -f "${SERVER}" && ! -L "${SERVER}" ]] || die "Missing or symlinked server: ${SERVER}"
  node --check "${SERVER}"
}

read_pid() {
  [[ -f "${PID_FILE}" ]] || return 1
  local pid
  pid="$(cat "${PID_FILE}")"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${pid}"
}

server_is_running() {
  local pid
  pid="$(read_pid 2>/dev/null || true)"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

start() {
  require_assets
  if [[ -e "${STATE_DIR}" ]]; then
    if server_is_running; then
      die "A Matrix browser probe is already running under ${STATE_DIR}."
    fi
    die "Stale Matrix browser probe state exists under ${STATE_DIR}; run stop after inspecting it."
  fi
  [[ ! -L "${STATE_ROOT}" ]] || die "Refusing to use symlinked runtime state root: ${STATE_ROOT}"
  umask 077
  mkdir -p -- "${STATE_ROOT}"
  mkdir -m 700 "${STATE_DIR}"
  node "${SERVER}" serve --port 0 >"${SERVER_LOG}" 2>"${SERVER_ERROR}" &
  local pid=$!
  printf '%s\n' "${pid}" >"${PID_FILE}"
  for _ in $(seq 1 100); do
    if [[ -s "${SERVER_LOG}" ]]; then
      break
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      cat "${SERVER_ERROR}" >&2 || true
      die 'Matrix browser probe server exited before readiness.'
    fi
    sleep 0.1
  done
  [[ -s "${SERVER_LOG}" ]] || die 'Matrix browser probe server did not publish readiness.'
  jq -e '(.url | type == "string") and (.runId | type == "string")' "${SERVER_LOG}" >/dev/null || {
    die 'Matrix browser probe server published an invalid readiness record.'
  }
  jq -c . "${SERVER_LOG}" >"${SERVER_RECORD}"
  local url
  url="$(jq -r '.url' "${SERVER_RECORD}")"
  curl --fail --silent --max-time 5 "${url%/}/health" | jq -e '.status == "ready"' >/dev/null || {
    die 'Matrix browser probe server health check failed.'
  }
  log "Browser URL: ${url}"
  log 'Open the URL in the supported browser session, wait for the pass/fail result, then run status.'
}

status() {
  require_assets
  server_is_running || die 'Matrix browser probe server is not running.'
  local url
  url="$(jq -r '.url' "${SERVER_RECORD}" 2>/dev/null || true)"
  [[ -n "${url}" && "${url}" != null ]] || die 'Matrix browser probe record is invalid.'
  curl --fail --silent --max-time 10 "${url%/}/status" | jq .
}

stop() {
  require_assets
  local pid
  pid="$(read_pid 2>/dev/null || true)"
  [[ -n "${pid}" ]] || {
    [[ ! -e "${STATE_DIR}" ]] && log 'Matrix browser probe is already stopped.' && return 0
    die 'Matrix browser probe state has no valid server PID.'
  }
  kill -0 "${pid}" 2>/dev/null || die 'Matrix browser probe server is not running; refusing to remove state without cleanup proof.'
  kill -TERM "${pid}" || die 'Failed to signal Matrix browser probe cleanup.'
  for _ in $(seq 1 300); do
    kill -0 "${pid}" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "${pid}" 2>/dev/null && die 'Matrix browser probe did not finish cleanup; refusing to remove state.'
  rm -rf -- "${STATE_DIR}"
  [[ ! -e "${STATE_DIR}" ]] || die 'Matrix browser probe state cleanup failed.'
  log 'Matrix browser probe server stopped; its exact owned resources were cleaned by the server.'
}

usage() {
  printf '%s\n' \
    'Usage: run-matrix-browser-smoke.sh {start|status|stop}' \
    '' \
    'start  Create one disposable probe server and print its browser URL.' \
    'status Read the bounded browser/Matrix result without credentials.' \
    'stop   Signal cleanup, wait for completion, and remove the exact local state.'
}

case "${1:-}" in
  start) start ;;
  status) status ;;
  stop) stop ;;
  *) usage >&2; exit 2 ;;
esac
