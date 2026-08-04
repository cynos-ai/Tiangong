#!/usr/bin/env bash

# Bound the Docker-pause test driver. This is not a Worker runtime API: it is
# used only by focused/full smoke orchestration while an exact Worker waits for
# an externally prepared broker. A paused OpenClaw process cannot receive a
# Matrix turn, and an overlong pause can invalidate its gateway connection.

set -Eeuo pipefail
umask 077

usage() {
  printf 'Usage: %s <container> <worker-name> <budget-seconds> <ready-file>\n' "$0" >&2
}

die() {
  printf 'pause_worker_until_file=fail code=%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 4 || $# -eq 5 ]] || { usage; die INVALID_ARGUMENTS; }

readonly CONTAINER="$1"
readonly WORKER_NAME="$2"
readonly BUDGET_SECONDS="$3"
readonly READY_FILE="$4"
readonly START_FILE="${5:-}"
readonly WORKER_NAME_PATTERN='^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
readonly CONTAINER_PATTERN='^agentteams-[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
readonly READY_FILE_PATTERN='^/tmp/tiangong-smoke-[A-Za-z0-9_.-]{1,96}$'

[[ "${CONTAINER}" =~ ${CONTAINER_PATTERN} ]] || die INVALID_CONTAINER
[[ "${WORKER_NAME}" =~ ${WORKER_NAME_PATTERN} ]] || die INVALID_WORKER_NAME
[[ "${BUDGET_SECONDS}" =~ ^[0-9]+$ ]] || die INVALID_BUDGET
((10#${BUDGET_SECONDS} >= 1 && 10#${BUDGET_SECONDS} <= 120)) || die INVALID_BUDGET
[[ "${READY_FILE}" =~ ${READY_FILE_PATTERN} ]] || die INVALID_READY_FILE
[[ ! -e "${READY_FILE}" && ! -L "${READY_FILE}" ]] || die READY_FILE_ALREADY_EXISTS
if [[ -n "${START_FILE}" ]]; then
  [[ "${START_FILE}" =~ ${READY_FILE_PATTERN} ]] || die INVALID_START_FILE
  [[ "${START_FILE}" != "${READY_FILE}" ]] || die START_AND_READY_FILE_IDENTICAL
  [[ ! -e "${START_FILE}" && ! -L "${START_FILE}" ]] || die START_FILE_ALREADY_EXISTS
fi

command -v docker >/dev/null 2>&1 || die DOCKER_UNAVAILABLE
command -v jq >/dev/null 2>&1 || die JQ_UNAVAILABLE

marker_is_ready() {
  local path="$1"
  [[ -f "${path}" && ! -L "${path}" ]] &&
    [[ "$(head -c 128 "${path}" 2>/dev/null)" == "ready=pass" ]]
}

wait_for_start_marker() {
  [[ -n "${START_FILE}" ]] || return 0
  printf 'pause_worker=waiting_for_start budget_seconds=%s\n' "${BUDGET_SECONDS}"
  for ((elapsed = 0; elapsed < 10#${BUDGET_SECONDS}; elapsed += 1)); do
    if marker_is_ready "${START_FILE}"; then
      return 0
    fi
    sleep 1
  done
  die START_TIMEOUT
}

inspect_worker() {
  local inspected
  inspected="$(docker inspect "${CONTAINER}" 2>/dev/null)" || die WORKER_INSPECT_FAILED
  jq -e --arg container "/${CONTAINER}" --arg worker "${WORKER_NAME}" '
    type == "array" and length == 1 and
    .[0].Name == $container and
    .[0].State.Running == true and
    .[0].State.Paused == false and
    any(.[0].Config.Env[]?; . == ("AGENTTEAMS_WORKER_NAME=" + $worker))
  ' >/dev/null <<<"${inspected}" || die WORKER_IDENTITY_MISMATCH
}

wait_for_start_marker
inspect_worker

paused=0
cleanup_failed=0
unpause_worker() {
  if ((paused == 1)); then
    if docker unpause "${CONTAINER}" >/dev/null 2>&1; then
      paused=0
    else
      cleanup_failed=1
      printf 'pause_worker_until_file=fail code=UNPAUSE_FAILED\n' >&2
    fi
  fi
}
# shellcheck disable=SC2317,SC2329
interrupt_worker() {
  unpause_worker
  exit 130
}
trap 'unpause_worker' EXIT
trap 'interrupt_worker' INT TERM

docker pause "${CONTAINER}" >/dev/null 2>&1 || die PAUSE_FAILED
paused=1
printf 'pause_worker=active container=%s budget_seconds=%s\n' "${CONTAINER}" "${BUDGET_SECONDS}"

for ((elapsed = 0; elapsed < 10#${BUDGET_SECONDS}; elapsed += 1)); do
  if marker_is_ready "${READY_FILE}"; then
    unpause_worker
    ((cleanup_failed == 0)) || exit 1
    printf 'pause_worker_until_file=pass container=%s elapsed_seconds=%s\n' "${CONTAINER}" "${elapsed}"
    exit 0
  fi
  sleep 1
done

unpause_worker
((cleanup_failed == 0)) || exit 1
printf 'pause_worker_until_file=fail code=READINESS_TIMEOUT container=%s budget_seconds=%s\n' \
  "${CONTAINER}" "${BUDGET_SECONDS}" >&2
exit 1
