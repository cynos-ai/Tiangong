#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker:dev"
readonly STOCK_LEADER_IMAGE="higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-copaw-worker:v1.2.0-beta.1"
readonly MODEL="qwen3.5-plus"
readonly TEAM_NAME="tiangong-peer-smoke"
readonly LEADER_NAME="tiangong-peer-smoke-leader"
readonly COORDINATOR_NAME="tiangong-peer-smoke-coordinator"
readonly ENGINEER_NAME="tiangong-peer-smoke-engineer"
readonly LEADER_CONTAINER="agentteams-worker-${LEADER_NAME}"
readonly COORDINATOR_CONTAINER="agentteams-worker-${COORDINATOR_NAME}"
readonly ENGINEER_CONTAINER="agentteams-worker-${ENGINEER_NAME}"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/peer-mention-smoke-team.yaml"
readonly BUILD_WORKER_IMAGE="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly PEER_ROUNDTRIP="${SCRIPT_DIR}/matrix-peer-roundtrip.sh"
readonly ROOM_MEMBERS="${SCRIPT_DIR}/matrix-peer-room-members.sh"
readonly ALIAS_HELPER="${SCRIPT_DIR}/matrix-peer-aliases.sh"
readonly OTLP_RECEIVER="${SCRIPT_DIR}/otlp-smoke-receiver.mjs"
readonly OTLP_CONTAINER="tiangong-peer-smoke-otel"
readonly OTLP_NETWORK_ALIAS="tiangong-otel-collector"
readonly OTLP_ENDPOINT="http://${OTLP_NETWORK_ALIAS}:4318/v1/traces"
readonly OTLP_DATA_DIRECTORY="${REPO_ROOT}/.runtime/peer-smoke-observability"
readonly OTLP_SPANS_FILE="${OTLP_DATA_DIRECTORY}/spans.jsonl"
readonly MANAGER_MANIFEST="/tmp/tiangong-peer-smoke-team.yaml"
readonly CONTROLLER_PEER_ROUNDTRIP="/tmp/tiangong-peer-roundtrip.sh"
readonly CONTROLLER_ALIAS_HELPER="/tmp/tiangong-peer-aliases.sh"
readonly COORDINATOR_ROOM_MEMBERS="/tmp/tiangong-peer-room-members.sh"
readonly ENGINEER_ROOM_MEMBERS="/tmp/tiangong-peer-room-members.sh"
readonly SMOKE_MODE="${TIANGONG_PEER_SMOKE_MODE:-full}"
owned_resources=0
otlp_owned=0

log() {
  printf '[Tiangong] %s\n' "$*"
}

die() {
  printf '[Tiangong] ERROR: %s\n' "$*" >&2
  exit 1
}

team_json() {
  docker exec "${MANAGER_CONTAINER}" hiclaw get teams "${TEAM_NAME}" -o json 2>/dev/null
}

member_json() {
  docker exec "${MANAGER_CONTAINER}" hiclaw get workers "$1" -o json 2>/dev/null
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

remote_prefix_has_objects() {
  docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive \
    "agentteams/agentteams-storage/$1/" 2>/dev/null | grep -q .
}

reserved_storage_absent() {
  local prefix mirror_root
  for prefix in \
    "agents/${LEADER_NAME}" \
    "agents/${COORDINATOR_NAME}" \
    "agents/${ENGINEER_NAME}" \
    "teams/${TEAM_NAME}"; do
    if remote_prefix_has_objects "${prefix}"; then
      return 1
    fi
  done
  for mirror_root in \
    "/root/hiclaw-fs/agents/${LEADER_NAME}" \
    "/root/hiclaw-fs/agents/${COORDINATOR_NAME}" \
    "/root/hiclaw-fs/agents/${ENGINEER_NAME}" \
    "/root/hiclaw-fs/teams/${TEAM_NAME}"; do
    if docker exec "${CONTROLLER_CONTAINER}" test -e "${mirror_root}" || \
       docker exec "${MANAGER_CONTAINER}" test -e "${mirror_root}"; then
      return 1
    fi
  done
}

purge_reserved_storage() {
  local prefix mirror_root failed=0
  for prefix in \
    "agents/${LEADER_NAME}" \
    "agents/${COORDINATOR_NAME}" \
    "agents/${ENGINEER_NAME}" \
    "teams/${TEAM_NAME}"; do
    docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
      "agentteams/agentteams-storage/${prefix}/" >/dev/null 2>&1 || failed=1
  done
  for mirror_root in \
    "/root/hiclaw-fs/agents/${LEADER_NAME}" \
    "/root/hiclaw-fs/agents/${COORDINATOR_NAME}" \
    "/root/hiclaw-fs/agents/${ENGINEER_NAME}" \
    "/root/hiclaw-fs/teams/${TEAM_NAME}"; do
    docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "${mirror_root}" >/dev/null 2>&1 || failed=1
    docker exec "${MANAGER_CONTAINER}" rm -rf -- "${mirror_root}" >/dev/null 2>&1 || failed=1
  done
  ((failed == 0))
}

wait_for_worker_channel() {
  local container="$1" member="$2" room_id="$3" since="$4" logs
  for _ in $(seq 1 90); do
    logs="$(docker logs --since "${since}" "${container}" 2>&1 || true)"
    if [[ "$(docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null)" == true ]] && \
       docker exec "${container}" openclaw health >/dev/null 2>&1 && \
       grep -Fq "[matrix] joined room ${room_id}" <<<"${logs}" && \
       grep -Fq "worker/${member} reported ready" <<<"${logs}"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

assert_worker_runtime() {
  local member="$1" container="$2" resource actual_image
  resource="$(member_json "${member}")" || die "Worker ${member} is not observable."
  [[ "$(jq -r '.phase // empty' <<<"${resource}")" == Running ]] || \
    die "Worker ${member} is not Running."
  [[ "$(jq -r '.runtime // empty' <<<"${resource}")" == openclaw ]] || \
    die "Worker ${member} did not retain runtime=openclaw."
  [[ "$(jq -r '.image // empty' <<<"${resource}")" == "${IMAGE}" ]] || \
    die "Worker ${member} did not retain the explicit image."
  [[ "$(jq -r '.role // empty' <<<"${resource}")" == worker ]] || \
    die "Worker ${member} is not an ordinary Team Worker."
  [[ "$(jq -r '.team // empty' <<<"${resource}")" == "${TEAM_NAME}" ]] || \
    die "Worker ${member} has the wrong Team identity."
  [[ "$(docker inspect "${container}" --format '{{.State.Running}}')" == true ]] || \
    die "Container ${container} is not running."
  actual_image="$(docker inspect "${container}" --format '{{.Config.Image}}')"
  [[ "${actual_image}" == "${IMAGE}" ]] || \
    die "Expected ${IMAGE}, got ${actual_image} for ${member}."
  [[ "$(docker exec "${container}" printenv AGENTTEAMS_WORKER_ROLE)" == worker ]] || \
    die "Worker ${member} did not receive platform role=worker."
  [[ "$(docker exec "${container}" printenv AGENTTEAMS_WORKER_NAME)" == "${member}" ]] || \
    die "Worker identity environment is wrong for ${member}."
  [[ "$(docker exec "${container}" printenv OPENCLAW_AGENT_RUNTIME)" == tiangong-pi ]] || \
    die "Tiangong Harness is not selected for ${member}."
  [[ "$(docker exec "${container}" printenv TIANGONG_OTEL_EXPORTER_ENDPOINT)" == "${OTLP_ENDPOINT}" ]] || \
    die "Worker observability endpoint is not the owned smoke receiver for ${member}."
}

assert_peer_policy() {
  local container="$1" member="$2" peer_id="$3" leader_id="$4" admin_id="$5"
  local config="/root/hiclaw-fs/agents/${member}/openclaw.json" status
  for _ in $(seq 1 30); do
    if docker exec "${container}" jq -e \
      --arg peer "${peer_id}" \
      --arg leader "${leader_id}" \
      --arg admin "${admin_id}" '
        (.channels.matrix.groupAllowFrom | index($peer)) != null and
        (.channels.matrix.groupAllowFrom | index($leader)) != null and
        (.channels.matrix.groupAllowFrom | index($admin)) != null and
        .channels.matrix.groups["*"].requireMention == true
      ' "${config}" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  status="$(docker exec "${container}" jq -c \
    --arg peer "${peer_id}" \
    --arg leader "${leader_id}" \
    --arg admin "${admin_id}" '
      {
        allowCount:(.channels.matrix.groupAllowFrom | length),
        peerAllowed:((.channels.matrix.groupAllowFrom | index($peer)) != null),
        leaderAllowed:((.channels.matrix.groupAllowFrom | index($leader)) != null),
        adminAllowed:((.channels.matrix.groupAllowFrom | index($admin)) != null),
        requireMention:(.channels.matrix.groups["*"].requireMention == true)
      }
    ' "${config}")"
  printf '[Tiangong] Peer policy status for %s: %s\n' "${member}" "${status}" >&2
  die "Matrix peer mention policy is incomplete for ${member}."
}

peer_policy_digest() {
  local container="$1" member="$2"
  local config="/root/hiclaw-fs/agents/${member}/openclaw.json"
  docker exec "${container}" jq -cS '
    {
      groupAllowFrom:.channels.matrix.groupAllowFrom,
      requireMention:.channels.matrix.groups["*"].requireMention
    }
  ' "${config}" | sha256sum | cut -d ' ' -f 1
}

matrix_channel_status() {
  local container="$1"
  docker exec "${container}" bash -lc '
    set -euo pipefail
    openclaw channels status --json 2>/dev/null | jq -ce '\''
      (.channelAccounts.matrix // []) as $accounts |
      if ($accounts | length) != 1 then error("unexpected Matrix account count")
      else $accounts[0] | {
        running,
        connected,
        restartPending,
        healthState,
        lastStartAt,
        lastConnectedAt,
        lastEventAt
      } end
    '\''
  '
}

matrix_channel_is_ready() {
  jq -e '
    .running == true and
    .connected == true and
    .restartPending == false and
    .healthState == "healthy" and
    (.lastStartAt | type) == "number" and
    (.lastConnectedAt | type) == "number" and
    (.lastEventAt | type) == "number" and
    .lastConnectedAt >= .lastStartAt and
    .lastEventAt >= .lastStartAt
  ' >/dev/null
}

assert_peer_channel_stable() {
  local container="$1" member="$2"
  local policy_before policy_after status_before status_after
  for _ in $(seq 1 12); do
    policy_before="$(peer_policy_digest "${container}" "${member}")" || {
      sleep 2
      continue
    }
    status_before="$(matrix_channel_status "${container}")" || {
      sleep 2
      continue
    }
    if ! matrix_channel_is_ready <<<"${status_before}"; then
      sleep 2
      continue
    fi
    sleep 10
    policy_after="$(peer_policy_digest "${container}" "${member}")" || continue
    status_after="$(matrix_channel_status "${container}")" || continue
    if [[ "${policy_after}" == "${policy_before}" ]] && \
       matrix_channel_is_ready <<<"${status_after}" && \
       [[ "$(jq -r '.lastStartAt' <<<"${status_after}")" == \
          "$(jq -r '.lastStartAt' <<<"${status_before}")" ]]; then
      printf 'peer_%s_matrix_active_channel=%s\n' \
        "${member##*-}" "${status_after}"
      return 0
    fi
  done
  status_after="$(matrix_channel_status "${container}" 2>/dev/null || printf '{"observable":false}')"
  printf '[Tiangong] Matrix channel did not stabilize for %s: %s\n' \
    "${member}" "${status_after}" >&2
  return 1
}

harness_snapshot() {
  local container="$1"
  if ! docker exec "${container}" test -f /tmp/tiangong-pi-harness.last-run; then
    printf 'absent\n'
    return
  fi
  docker exec "${container}" stat -c '%y:%s' /tmp/tiangong-pi-harness.last-run
}

assert_harness() {
  local container="$1" member="$2" baseline="$3" marker current
  current="$(harness_snapshot "${container}")"
  [[ "${current}" != "${baseline}" ]] || die "Harness marker did not change for ${member}."
  marker="$(docker exec "${container}" cat /tmp/tiangong-pi-harness.last-run)" || \
    die "Harness marker is absent for ${member}."
  grep -Fqx 'harness=tiangong-pi' <<<"${marker}" || die "Wrong Harness for ${member}."
  grep -Fqx 'provider=agentteams-gateway' <<<"${marker}" || die "Wrong provider for ${member}."
  grep -Fqx "model=${MODEL}" <<<"${marker}" || die "Wrong model for ${member}."
  grep -Fqx 'status=pass' <<<"${marker}" || die "Harness turn failed for ${member}."
  printf 'peer_%s_harness=pass\n' "${member##*-}"
}

assert_nonce_persisted() {
  local container="$1" member="$2" nonce="$3" state_root matches
  state_root="/root/hiclaw-fs/agents/${member}/.tiangong/runtime/sessions"
  matches="$(docker exec "${container}" grep -RlF --include='*.jsonl' \
    "${nonce}" "${state_root}" 2>/dev/null || true)"
  [[ -n "${matches}" ]] || die "Persistent session for ${member} does not contain the probe nonce."
}

probe_output_value() {
  local output="$1" key="$2" line
  line="$(grep -m1 -F "${key}=" <<<"${output}" || true)"
  [[ -n "${line}" ]] || return 1
  printf '%s\n' "${line#*=}"
}

observability_turn_digest() {
  local event_id="$1"
  printf 'tiangong-observability:turn\0matrix:%s' "${event_id}" | \
    sha256sum | cut -c 1-24
}

trace_summary() {
  local event_id="$1" digest
  digest="$(observability_turn_digest "${event_id}")"
  [[ -f "${OTLP_SPANS_FILE}" ]] || {
    printf '[]\n'
    return
  }
  jq -cs --arg digest "${digest}" '[.[] | select(
    .attributes["tiangong.turn.id"] == $digest
  ) | {
    name,
    phase:(.attributes["tiangong.phase"] // null),
    outcome:(.attributes["tiangong.operation.outcome"] // null),
    errorType:(.attributes["error.type"] // null),
    statusCode
  }]' "${OTLP_SPANS_FILE}" 2>/dev/null || printf '[]\n'
}

assert_trace_complete() {
  local event_id="$1" label="$2" digest
  digest="$(observability_turn_digest "${event_id}")"
  for _ in $(seq 1 30); do
    if [[ -f "${OTLP_SPANS_FILE}" ]] && jq -se --arg digest "${digest}" 'any(.[];
      .name == "tiangong.harness.attempt" and
      .attributes["tiangong.turn.id"] == $digest and
      .attributes["tiangong.operation.outcome"] == "complete" and
      .statusCode == 1
    )' "${OTLP_SPANS_FILE}" >/dev/null; then
      printf 'peer_%s_observability=pass\n' "${label}"
      return 0
    fi
    sleep 1
  done
  printf '[Tiangong] Sanitized trace summary for %s: %s\n' \
    "${label}" "$(trace_summary "${event_id}")" >&2
  return 1
}

stock_session_snapshot() {
  docker exec "${LEADER_CONTAINER}" bash -lc '
    set -euo pipefail
    root="/root/.copaw-worker/$1/.copaw"
    if [[ ! -d "${root}" ]]; then
      printf "0:%s\n" "$(printf empty | sha256sum | cut -d " " -f 1)"
      exit 0
    fi
    count="$(find "${root}" -type f -path "*/sessions/*" | wc -l | tr -d " ")"
    digest="$(find "${root}" -type f -path "*/sessions/*" -print0 | sort -z | \
      xargs -0 -r sha256sum | sha256sum | cut -d " " -f 1)"
    printf "%s:%s\n" "${count}" "${digest}"
  ' _ "${LEADER_NAME}"
}

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT INT TERM
  set +e

  if ((otlp_owned == 1)); then
    if container_exists "${OTLP_CONTAINER}"; then
      docker rm --force "${OTLP_CONTAINER}" >/dev/null 2>&1 || cleanup_failed=1
    fi
    rm -rf -- "${OTLP_DATA_DIRECTORY}" || cleanup_failed=1
    ! container_exists "${OTLP_CONTAINER}" || cleanup_failed=1
    [[ ! -e "${OTLP_DATA_DIRECTORY}" ]] || cleanup_failed=1
  fi

  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_MANIFEST}" >/dev/null 2>&1 || cleanup_failed=1
  if container_exists "${COORDINATOR_CONTAINER}"; then
    docker exec "${COORDINATOR_CONTAINER}" rm -f \
      "${COORDINATOR_ROOM_MEMBERS}" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if container_exists "${ENGINEER_CONTAINER}"; then
    docker exec "${ENGINEER_CONTAINER}" rm -f \
      "${ENGINEER_ROOM_MEMBERS}" >/dev/null 2>&1 || cleanup_failed=1
  fi

  if ((owned_resources == 1)); then
    log "Deleting temporary Team ${TEAM_NAME}"
    docker exec "${MANAGER_CONTAINER}" hiclaw delete team "${TEAM_NAME}" >/dev/null 2>&1 || cleanup_failed=1
    for _ in $(seq 1 120); do
      if ! team_json >/dev/null 2>&1 && \
         ! member_json "${LEADER_NAME}" >/dev/null 2>&1 && \
         ! member_json "${COORDINATOR_NAME}" >/dev/null 2>&1 && \
         ! member_json "${ENGINEER_NAME}" >/dev/null 2>&1 && \
         ! container_exists "${LEADER_CONTAINER}" && \
         ! container_exists "${COORDINATOR_CONTAINER}" && \
         ! container_exists "${ENGINEER_CONTAINER}"; then
        break
      fi
      sleep 1
    done
    if team_json >/dev/null 2>&1 || \
       member_json "${LEADER_NAME}" >/dev/null 2>&1 || \
       member_json "${COORDINATOR_NAME}" >/dev/null 2>&1 || \
       member_json "${ENGINEER_NAME}" >/dev/null 2>&1 || \
       container_exists "${LEADER_CONTAINER}" || \
       container_exists "${COORDINATOR_CONTAINER}" || \
       container_exists "${ENGINEER_CONTAINER}"; then
      printf '[Tiangong] ERROR: temporary peer Team cleanup did not finish.\n' >&2
      cleanup_failed=1
    fi
    docker exec "${CONTROLLER_CONTAINER}" "${CONTROLLER_ALIAS_HELPER}" delete || cleanup_failed=1
    purge_reserved_storage || cleanup_failed=1
    reserved_storage_absent || cleanup_failed=1
  fi

  docker exec "${CONTROLLER_CONTAINER}" rm -f \
    "${CONTROLLER_PEER_ROUNDTRIP}" "${CONTROLLER_ALIAS_HELPER}" >/dev/null 2>&1 || cleanup_failed=1
  docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_MANIFEST}" || cleanup_failed=1
  docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_PEER_ROUNDTRIP}" || cleanup_failed=1
  docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_ALIAS_HELPER}" || cleanup_failed=1
  ((cleanup_failed == 0)) || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${SMOKE_MODE}" == full || "${SMOKE_MODE}" == config ]] || \
  die "TIANGONG_PEER_SMOKE_MODE must be full or config."
for command in docker jq grep awk sha256sum node curl; do
  command -v "${command}" >/dev/null 2>&1 || die "Missing required command: ${command}"
done
for path in "${MANIFEST}" "${BUILD_WORKER_IMAGE}" "${PEER_ROUNDTRIP}" \
  "${ROOM_MEMBERS}" "${ALIAS_HELPER}" "${OTLP_RECEIVER}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || die "Required smoke asset is missing or symlinked: ${path}"
done
[[ -x "${BUILD_WORKER_IMAGE}" && -x "${PEER_ROUNDTRIP}" && \
   -x "${ROOM_MEMBERS}" && -x "${ALIAS_HELPER}" ]] || \
  die "Peer smoke support scripts must be executable."
docker info >/dev/null 2>&1 || die "The Docker daemon is unavailable."
for container in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}"; do
  container_exists "${container}" || die "${container} does not exist."
  [[ "$(docker inspect "${container}" --format '{{.State.Running}}')" == true ]] || \
    die "${container} is not running."
done

for resource in "${LEADER_NAME}" "${COORDINATOR_NAME}" "${ENGINEER_NAME}"; do
  ! member_json "${resource}" >/dev/null 2>&1 || \
    die "Reserved member ${resource} already exists; refusing to replace it."
done
! team_json >/dev/null 2>&1 || die "Reserved Team ${TEAM_NAME} already exists; refusing to replace it."
for container in "${LEADER_CONTAINER}" "${COORDINATOR_CONTAINER}" "${ENGINEER_CONTAINER}"; do
  ! container_exists "${container}" || die "Reserved container ${container} already exists; refusing to replace it."
done
! container_exists "${OTLP_CONTAINER}" || \
  die "Reserved observability container ${OTLP_CONTAINER} already exists; refusing to replace it."
[[ ! -e "${OTLP_DATA_DIRECTORY}" ]] || \
  die "Reserved observability data path already exists; refusing to replace it."
reserved_storage_absent || die "Reserved peer smoke storage is not empty; refusing to replace it."
docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_MANIFEST}" || \
  die "Reserved Manager helper path already exists; refusing to replace it."
docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_PEER_ROUNDTRIP}" || \
  die "Reserved Controller round-trip helper already exists; refusing to replace it."
docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_ALIAS_HELPER}" || \
  die "Reserved Controller alias helper already exists; refusing to replace it."

docker cp "${ALIAS_HELPER}" "${CONTROLLER_CONTAINER}:${CONTROLLER_ALIAS_HELPER}"
docker exec "${CONTROLLER_CONTAINER}" "${CONTROLLER_ALIAS_HELPER}" assert-absent
TIANGONG_OTEL_EXPORTER_ENDPOINT="${OTLP_ENDPOINT}" "${BUILD_WORKER_IMAGE}"
mkdir -m 700 "${OTLP_DATA_DIRECTORY}"
otlp_owned=1
docker run --detach \
  --name "${OTLP_CONTAINER}" \
  --network agentteams-net \
  --network-alias "${OTLP_NETWORK_ALIAS}" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges=true \
  --mount "type=bind,src=${OTLP_RECEIVER},dst=/opt/tiangong-otlp-receiver.mjs,readonly" \
  --mount "type=bind,src=${OTLP_DATA_DIRECTORY},dst=/data" \
  --entrypoint node \
  "${IMAGE}" /opt/tiangong-otlp-receiver.mjs /data/spans.jsonl >/dev/null
for _ in $(seq 1 30); do
  if docker exec "${OTLP_CONTAINER}" node -e \
      'fetch("http://127.0.0.1:4318/health").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'; then
    break
  fi
  sleep 1
done
docker exec "${OTLP_CONTAINER}" node -e \
  'fetch("http://127.0.0.1:4318/health").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' || \
  die "OTLP smoke receiver did not become ready."
printf 'peer_observability_receiver=pass\n'
docker cp "${PEER_ROUNDTRIP}" "${CONTROLLER_CONTAINER}:${CONTROLLER_PEER_ROUNDTRIP}"
docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
owned_resources=1
log "Creating temporary AgentTeams Team ${TEAM_NAME}"
docker exec "${MANAGER_CONTAINER}" hiclaw apply -f "${MANAGER_MANIFEST}" || \
  die "Peer Team apply failed."

phase=''
for _ in $(seq 1 120); do
  resource="$(team_json || true)"
  phase="$(jq -r '.phase // empty' <<<"${resource}" 2>/dev/null || true)"
  case "${phase}" in
    Active) break ;;
    Failed)
      team_json | jq '{name,phase,leaderReady,readyWorkers,totalWorkers,message}' >&2 || true
      die "Peer Team entered Failed phase."
      ;;
  esac
  sleep 3
done
[[ "${phase}" == Active ]] || die "Peer Team did not reach Active within 360 seconds."
team_resource="$(team_json)"
[[ "$(jq -r '.leaderReady' <<<"${team_resource}")" == true ]] || die "Stock Leader is not ready."
[[ "$(jq -r '.readyWorkers' <<<"${team_resource}")" == 2 ]] || die "Expected two ready ordinary Workers."
[[ "$(jq -r '.totalWorkers' <<<"${team_resource}")" == 2 ]] || die "Expected exactly two ordinary Workers."
team_room_id="$(jq -r '.teamRoomID // empty' <<<"${team_resource}")"
[[ -n "${team_room_id}" ]] || die "Team Room ID is missing."

leader_resource="$(member_json "${LEADER_NAME}")"
[[ "$(jq -r '.phase // empty' <<<"${leader_resource}")" == Running ]] || die "Stock Leader is not Running."
[[ "$(jq -r '.role // empty' <<<"${leader_resource}")" == team_leader ]] || die "Stock Leader role is wrong."
[[ "$(docker inspect "${LEADER_CONTAINER}" --format '{{.State.Running}}')" == true ]] || die "Stock Leader container is not running."
actual_leader_image="$(docker inspect "${LEADER_CONTAINER}" --format '{{.Config.Image}}')"
[[ "${actual_leader_image}" == "${STOCK_LEADER_IMAGE}" ]] || \
  die "Expected pinned stock Leader image, got ${actual_leader_image}."
printf 'stock_leader_runtime=pass\n'

assert_worker_runtime "${COORDINATOR_NAME}" "${COORDINATOR_CONTAINER}"
assert_worker_runtime "${ENGINEER_NAME}" "${ENGINEER_CONTAINER}"
coordinator_resource="$(member_json "${COORDINATOR_NAME}")"
engineer_resource="$(member_json "${ENGINEER_NAME}")"
leader_user_id="$(jq -r '.matrixUserID // empty' <<<"${leader_resource}")"
coordinator_user_id="$(jq -r '.matrixUserID // empty' <<<"${coordinator_resource}")"
engineer_user_id="$(jq -r '.matrixUserID // empty' <<<"${engineer_resource}")"
coordinator_room_id="$(jq -r '.roomID // empty' <<<"${coordinator_resource}")"
engineer_room_id="$(jq -r '.roomID // empty' <<<"${engineer_resource}")"
manager_user_id="$(docker exec "${MANAGER_CONTAINER}" jq -r \
  '.channels.matrix.userId // empty' /root/manager-workspace/openclaw.json)"
admin_user="$(docker exec "${CONTROLLER_CONTAINER}" printenv AGENTTEAMS_ADMIN_USER)"
matrix_domain="$(docker exec "${CONTROLLER_CONTAINER}" printenv AGENTTEAMS_MATRIX_DOMAIN)"
admin_user_id="@${admin_user}:${matrix_domain}"
[[ -n "${leader_user_id}" && -n "${coordinator_user_id}" && -n "${engineer_user_id}" && \
   -n "${coordinator_room_id}" && -n "${engineer_room_id}" && -n "${manager_user_id}" ]] || \
  die "Peer Team Matrix identity is incomplete."

wait_for_worker_channel "${COORDINATOR_CONTAINER}" "${COORDINATOR_NAME}" "${team_room_id}" 0 || \
  die "Coordinator Worker Team Room channel did not become ready."
wait_for_worker_channel "${ENGINEER_CONTAINER}" "${ENGINEER_NAME}" "${team_room_id}" 0 || \
  die "Engineer Worker Team Room channel did not become ready."
printf 'peer_worker_runtime_and_channel_readiness=pass\n'
docker cp "${ROOM_MEMBERS}" "${COORDINATOR_CONTAINER}:${COORDINATOR_ROOM_MEMBERS}"
docker cp "${ROOM_MEMBERS}" "${ENGINEER_CONTAINER}:${ENGINEER_ROOM_MEMBERS}"
coordinator_config="/root/hiclaw-fs/agents/${COORDINATOR_NAME}/openclaw.json"
engineer_config="/root/hiclaw-fs/agents/${ENGINEER_NAME}/openclaw.json"
docker exec "${COORDINATOR_CONTAINER}" "${COORDINATOR_ROOM_MEMBERS}" members \
  "${coordinator_config}" "${team_room_id}" \
  "${admin_user_id},${leader_user_id},${coordinator_user_id},${engineer_user_id}" \
  "${manager_user_id}"
assert_peer_policy "${COORDINATOR_CONTAINER}" "${COORDINATOR_NAME}" \
  "${engineer_user_id}" "${leader_user_id}" "${admin_user_id}"
assert_peer_policy "${ENGINEER_CONTAINER}" "${ENGINEER_NAME}" \
  "${coordinator_user_id}" "${leader_user_id}" "${admin_user_id}"
printf 'matrix_peer_channel_policy=pass\n'
assert_peer_channel_stable "${COORDINATOR_CONTAINER}" "${COORDINATOR_NAME}" || \
  die "Coordinator Matrix listener did not stabilize after peer policy publication."
assert_peer_channel_stable "${ENGINEER_CONTAINER}" "${ENGINEER_NAME}" || \
  die "Engineer Matrix listener did not stabilize after peer policy publication."
printf 'matrix_peer_active_channel_stability=pass\n'
if [[ "${SMOKE_MODE}" == config ]]; then
  log "Peer mention configuration boundary passed."
  exit 0
fi

sleep 5
leader_snapshot_before="$(stock_session_snapshot)"
coordinator_harness_before="$(harness_snapshot "${COORDINATOR_CONTAINER}")"
engineer_harness_before="$(harness_snapshot "${ENGINEER_CONTAINER}")"
nonce="$(cat /proc/sys/kernel/random/uuid)"
log "Testing Coordinator -> Engineer -> Coordinator through the real Team Room"
if ! peer_output="$(docker exec "${CONTROLLER_CONTAINER}" "${CONTROLLER_PEER_ROUNDTRIP}" run \
  "${team_room_id}" "${leader_user_id}" "${coordinator_user_id}" "${engineer_user_id}" "${nonce}")"; then
  for diagnostic_container in "${COORDINATOR_CONTAINER}" "${ENGINEER_CONTAINER}"; do
    diagnostic_member="${diagnostic_container#agentteams-worker-}"
    if docker exec "${diagnostic_container}" test -f /tmp/tiangong-pi-harness.last-run; then
      printf '[Tiangong] Harness status for %s:\n' "${diagnostic_member}" >&2
      docker exec "${diagnostic_container}" grep -E \
        '^(harness|provider|model|status)=' /tmp/tiangong-pi-harness.last-run >&2 || true
    else
      printf '[Tiangong] Harness status for %s: no turn marker\n' "${diagnostic_member}" >&2
    fi
    if [[ "${diagnostic_container}" == "${COORDINATOR_CONTAINER}" ]]; then
      harness_before="${coordinator_harness_before}"
    else
      harness_before="${engineer_harness_before}"
    fi
    if [[ "$(harness_snapshot "${diagnostic_container}")" == "${harness_before}" ]]; then
      printf '[Tiangong] Harness marker changed for %s: no\n' "${diagnostic_member}" >&2
    else
      printf '[Tiangong] Harness marker changed for %s: yes\n' "${diagnostic_member}" >&2
    fi
    nonce_file_count="$(
      { docker exec "${diagnostic_container}" grep -RlF --include='*.jsonl' \
          "${nonce}" "/root/hiclaw-fs/agents/${diagnostic_member}/.tiangong/runtime/sessions" \
          2>/dev/null || true; } | wc -l | tr -d ' '
    )"
    printf '[Tiangong] Nonce-bearing session files for %s: %s\n' \
      "${diagnostic_member}" "${nonce_file_count}" >&2
  done
  if start_event_id="$(probe_output_value "${peer_output}" peer_probe_start_event)"; then
    for _ in $(seq 1 15); do
      trace="$(trace_summary "${start_event_id}")"
      [[ "${trace}" != '[]' ]] && break
      sleep 1
    done
    printf '[Tiangong] Sanitized Coordinator start-event trace: %s\n' "${trace}" >&2
  else
    printf '[Tiangong] Coordinator start-event trace correlation is unavailable.\n' >&2
  fi
  if ! docker exec "${COORDINATOR_CONTAINER}" "${COORDINATOR_ROOM_MEMBERS}" event-visible \
      "${coordinator_config}" "${team_room_id}" "${admin_user_id}" \
      "${coordinator_user_id}" "${nonce}" TG_PEER_START; then
    printf '[Tiangong] Coordinator account could not prove visibility of the expected Admin start.\n' >&2
  fi
  if ! docker exec "${ENGINEER_CONTAINER}" "${ENGINEER_ROOM_MEMBERS}" event-visible \
      "${engineer_config}" "${team_room_id}" "${coordinator_user_id}" \
      "${engineer_user_id}" "${nonce}" TG_PEER_PING; then
    printf '[Tiangong] Engineer account could not prove visibility of the expected peer ping.\n' >&2
  fi
  for diagnostic_container in "${COORDINATOR_CONTAINER}" "${ENGINEER_CONTAINER}"; do
    diagnostic_member="${diagnostic_container#agentteams-worker-}"
    diagnostic_channel_status="$(matrix_channel_status "${diagnostic_container}" \
      2>/dev/null || printf '{"observable":false}')"
    printf '[Tiangong] Sanitized Matrix channel status for %s: %s\n' \
      "${diagnostic_member}" "${diagnostic_channel_status}" >&2
  done
  die "Worker peer event chain failed."
fi
printf '%s\n' "${peer_output}"
grep -Fqx 'worker_peer_event_chain=pass' <<<"${peer_output}" || die "Worker peer event chain failed."
grep -Fqx 'stock_leader_message_count=0' <<<"${peer_output}" || die "Stock Leader emitted a message."
assert_harness "${COORDINATOR_CONTAINER}" "${COORDINATOR_NAME}" "${coordinator_harness_before}"
assert_harness "${ENGINEER_CONTAINER}" "${ENGINEER_NAME}" "${engineer_harness_before}"
start_event_id="$(probe_output_value "${peer_output}" peer_start_event)" || \
  die "Peer output omitted the start event correlation."
ping_event_id="$(probe_output_value "${peer_output}" peer_ping_event)" || \
  die "Peer output omitted the ping event correlation."
pong_event_id="$(probe_output_value "${peer_output}" peer_pong_event)" || \
  die "Peer output omitted the pong event correlation."
assert_trace_complete "${start_event_id}" coordinator_start || \
  die "Coordinator start-event trace did not complete."
assert_trace_complete "${ping_event_id}" engineer_ping || \
  die "Engineer ping-event trace did not complete."
assert_trace_complete "${pong_event_id}" coordinator_pong || \
  die "Coordinator pong-event trace did not complete."
assert_nonce_persisted "${COORDINATOR_CONTAINER}" "${COORDINATOR_NAME}" "${nonce}"
assert_nonce_persisted "${ENGINEER_CONTAINER}" "${ENGINEER_NAME}" "${nonce}"
leader_snapshot_after="$(stock_session_snapshot)"
[[ "${leader_snapshot_after}" == "${leader_snapshot_before}" ]] || \
  die "Stock Leader session state changed during messages that did not mention it."
printf 'stock_leader_model_turn_count=0\n'
printf 'peer_test_identities_are_not_role_authority=pass\n'
log "Worker peer mention and stock Leader non-interference smoke passed."
