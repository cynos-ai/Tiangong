#!/usr/bin/env bash
set -Eeuo pipefail

# Probe the AgentTeams REST/agt boundary without ever carrying a real
# credential. The probe is opt-in and uses containerManaged=false so a
# dropped accessEntries field cannot accidentally start a Worker.

readonly MANAGER_CONTAINER="${TIANGONG_AGENTTEAMS_MANAGER_CONTAINER:-}"
readonly PROBE_NAME="${TIANGONG_AGENTTEAMS_PROBE_NAME:-tiangong-admission-probe}"
readonly PROBE_MODEL="${TIANGONG_AGENTTEAMS_PROBE_MODEL:-tiangong-admission-probe-model}"
readonly PROBE_SERVICE="${TIANGONG_AGENTTEAMS_PROBE_SERVICE:-object-storage}"
readonly PROBE_SCOPE="${TIANGONG_AGENTTEAMS_PROBE_SCOPE:-{\"bucketRef\":\"workspace\",\"prefix\":\"agents/probe/*\"}}"
WORK_DIR="$(mktemp -d)"
readonly WORK_DIR
readonly MANIFEST="${WORK_DIR}/${PROBE_NAME}.yaml"
readonly REMOTE_MANIFEST="/tmp/${PROBE_NAME}.yaml"

cleanup_failed=0
created=0
cleanup() {
  set +e
  if [[ -n "${MANAGER_CONTAINER}" ]]; then
    if (( created )); then
      docker exec "${MANAGER_CONTAINER}" agt delete worker "${PROBE_NAME}" >/dev/null 2>&1 || true
    fi
    docker exec "${MANAGER_CONTAINER}" rm -f "${REMOTE_MANIFEST}" >/dev/null 2>&1 || true
    if (( created )); then
      for _ in $(seq 1 20); do
        if ! docker exec "${MANAGER_CONTAINER}" agt get workers "${PROBE_NAME}" -o json >/dev/null 2>&1; then
          break
        fi
        sleep 0.5
      done
      if docker exec "${MANAGER_CONTAINER}" agt get workers "${PROBE_NAME}" -o json >/dev/null 2>&1; then
        cleanup_failed=1
      fi
    fi
  fi
  rm -rf "${WORK_DIR}"
  if (( cleanup_failed )); then
    printf 'agentteams_worker_admission=fail code=CLEANUP_INCOMPLETE\n' >&2
    exit 1
  fi
}
trap cleanup EXIT INT TERM

fail() { printf 'agentteams_worker_admission=fail code=%s\n' "$1" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "${2:-COMMAND_NOT_FOUND}"; }

require_command docker
require_command jq
[[ -n "${MANAGER_CONTAINER}" ]] || fail MANAGER_CONTAINER_REQUIRED
[[ "${PROBE_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$ ]] || fail PROBE_NAME_INVALID
[[ "${PROBE_MODEL}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]] || fail PROBE_MODEL_INVALID
[[ "${PROBE_SERVICE}" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || fail PROBE_SERVICE_INVALID
(( ${#PROBE_SCOPE} <= 4096 )) || fail PROBE_SCOPE_TOO_LARGE
printf '%s' "${PROBE_SCOPE}" | jq -e 'type == "object"' >/dev/null || fail PROBE_SCOPE_INVALID

if docker exec "${MANAGER_CONTAINER}" agt get workers "${PROBE_NAME}" -o json >/dev/null 2>&1; then
  fail PROBE_RESOURCE_EXISTS
fi

cat >"${MANIFEST}" <<EOF
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: ${PROBE_NAME}
spec:
  model: ${PROBE_MODEL}
  runtime: openclaw
  containerManaged: false
  state: Stopped
  accessEntries:
    - service: ${PROBE_SERVICE}
      permissions: ["read"]
      scope: ${PROBE_SCOPE}
EOF

docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${REMOTE_MANIFEST}" >/dev/null || fail MANIFEST_COPY_FAILED
docker exec "${MANAGER_CONTAINER}" agt apply -f "${REMOTE_MANIFEST}" >/dev/null || fail APPLY_REJECTED
created=1

resource="$(docker exec "${MANAGER_CONTAINER}" agt get workers "${PROBE_NAME}" -o json 2>/dev/null || true)"
[[ -n "${resource}" ]] || fail WORKER_READ_FAILED

if ! jq -e --arg service "${PROBE_SERVICE}" --argjson scope "${PROBE_SCOPE}" '
  (.accessEntries | type == "array" and length == 1) and
  (.accessEntries[0].service == $service) and
  (.accessEntries[0].permissions == ["read"]) and
  (.accessEntries[0].scope == $scope)
' <<<"${resource}" >/dev/null; then
  fail ACCESS_ENTRIES_DROPPED
fi

printf 'agentteams_worker_admission=pass worker=%s service=%s\n' "${PROBE_NAME}" "${PROBE_SERVICE}"
