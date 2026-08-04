#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker:dev"
readonly STOCK_LEADER_IMAGE="higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-copaw-worker:v1.2.0"
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
readonly WORKER_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/peer-mention-smoke-workers.yaml"
readonly BUILD_WORKER_IMAGE="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly PEER_ROUNDTRIP="${SCRIPT_DIR}/matrix-peer-roundtrip.sh"
readonly ROOM_MEMBERS="${SCRIPT_DIR}/matrix-peer-room-members.sh"
readonly ALIAS_HELPER="${SCRIPT_DIR}/matrix-peer-aliases.sh"
readonly OTLP_RECEIVER="${SCRIPT_DIR}/otlp-smoke-receiver.mjs"
readonly OTLP_ACTIVITY_QUERY="${SCRIPT_DIR}/otlp-turn-activity.jq"
readonly OTLP_CONTAINER="tiangong-peer-smoke-otel"
readonly OTLP_VOLUME="tiangong-peer-smoke-otel-data"
readonly OTLP_NETWORK_ALIAS="tiangong-otel-collector"
readonly OTLP_ENDPOINT="http://${OTLP_NETWORK_ALIAS}:4318/v1/traces"
readonly OTLP_DATA_DIRECTORY="${REPO_ROOT}/.runtime/peer-smoke-observability"
readonly OTLP_SPANS_FILE="${OTLP_DATA_DIRECTORY}/spans.jsonl"
readonly MANAGER_MANIFEST="/tmp/tiangong-peer-smoke-team.yaml"
readonly MANAGER_WORKER_MANIFEST="/tmp/tiangong-peer-smoke-workers.yaml"
readonly CONTROLLER_PEER_ROUNDTRIP="/tmp/tiangong-peer-roundtrip.sh"
readonly CONTROLLER_ALIAS_HELPER="/tmp/tiangong-peer-aliases.sh"
readonly COORDINATOR_ROOM_MEMBERS="/tmp/tiangong-peer-room-members.sh"
readonly ENGINEER_ROOM_MEMBERS="/tmp/tiangong-peer-room-members.sh"
readonly SMOKE_MODE="${TIANGONG_PEER_SMOKE_MODE:-full}"
owned_resources=0
otlp_owned=0
manager_restart_required=0
controller_api_token=''
leader_cleanup_room_id=''
coordinator_cleanup_room_id=''
engineer_cleanup_room_id=''

log() {
  printf '[Tiangong] %s\n' "$*"
}

die() {
  printf '[Tiangong] ERROR: %s\n' "$*" >&2
  exit 1
}

team_json() {
  docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json 2>/dev/null
}

member_json() {
  docker exec "${MANAGER_CONTAINER}" agt get workers "$1" -o json 2>/dev/null
}

capture_manager_cleanup_state() {
  local resource
  controller_api_token="$(docker exec "${MANAGER_CONTAINER}" printenv AGENTTEAMS_AUTH_TOKEN 2>/dev/null || true)"
  [[ -n "${controller_api_token}" ]] || return 1
  resource="$(member_json "${LEADER_NAME}" || true)"
  leader_cleanup_room_id="$(jq -r '.roomID // empty' <<<"${resource}" 2>/dev/null || true)"
  resource="$(member_json "${COORDINATOR_NAME}" || true)"
  coordinator_cleanup_room_id="$(jq -r '.roomID // empty' <<<"${resource}" 2>/dev/null || true)"
  resource="$(member_json "${ENGINEER_NAME}" || true)"
  engineer_cleanup_room_id="$(jq -r '.roomID // empty' <<<"${resource}" 2>/dev/null || true)"
  if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
    docker stop "${MANAGER_CONTAINER}" >/dev/null || return 1
    manager_restart_required=1
  fi
}

leave_manager_from_worker_room() {
  local member="$1" room_id
  case "${member}" in
    "${LEADER_NAME}") room_id="${leader_cleanup_room_id}" ;;
    "${COORDINATOR_NAME}") room_id="${coordinator_cleanup_room_id}" ;;
    "${ENGINEER_NAME}") room_id="${engineer_cleanup_room_id}" ;;
    *) return 1 ;;
  esac
  [[ -n "${room_id}" ]] || return 0
  docker exec -i "${CONTROLLER_CONTAINER}" sh -s -- "${room_id}" <<'EOF'
set -eu
room_id="$1"
config=/root/agentteams-fs/agents/manager/openclaw.json
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${config}")"
access_token="$(jq -r '.channels.matrix.accessToken // empty' "${config}")"
[ -n "${homeserver}" ] && [ -n "${access_token}" ] || exit 1
room_path="$(printf '%s' "${room_id}" | jq -sRr @uri)"
response="$(printf 'header = "Authorization: Bearer %s"\n' "${access_token}" | \
  curl --silent --show-error --max-time 30 -K - -X POST \
    -w '\n%{http_code}' "${homeserver%/}/_matrix/client/v3/rooms/${room_path}/leave")"
status="$(printf '%s\n' "${response}" | tail -n 1)"
body="$(printf '%s\n' "${response}" | sed '$d')"
if [ "${status}" = 200 ]; then
  exit 0
fi
if [ "${status}" = 403 ] && printf '%s' "${body}" | jq -e \
  '.error == "M_FORBIDDEN: Auth check failed: cannot leave if not joined, invited or knocked"' >/dev/null 2>&1; then
  exit 0
fi
exit 1
EOF
}

controller_team_status() {
  printf 'header = "Authorization: Bearer %s"\n' "${controller_api_token}" | \
    docker exec -i "${CONTROLLER_CONTAINER}" curl --silent --show-error --max-time 5 \
      -K - -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:8090/api/v1/teams/${TEAM_NAME}"
}

controller_delete_team() {
  local status
  status="$(printf 'header = "Authorization: Bearer %s"\n' "${controller_api_token}" | \
    docker exec -i "${CONTROLLER_CONTAINER}" curl --silent --show-error --max-time 5 \
      -K - -o /dev/null -w '%{http_code}' -X DELETE \
      "http://127.0.0.1:8090/api/v1/teams/${TEAM_NAME}")"
  [[ "${status}" == 204 || "${status}" == 404 ]]
}

wait_for_team_absent() {
  for _ in $(seq 1 360); do
    [[ "$(controller_team_status)" == 404 ]] && return 0
    sleep 1
  done
  return 1
}

restart_manager_after_cleanup() {
  ((manager_restart_required == 1)) || return 0
  docker start "${MANAGER_CONTAINER}" >/dev/null || return 1
  for _ in $(seq 1 60); do
    docker exec "${MANAGER_CONTAINER}" agt get workers -o json >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

wait_for_worker_provisioning() {
  local member resource container
  for _ in $(seq 1 120); do
    local ready=1
    for member in "${LEADER_NAME}" "${COORDINATOR_NAME}" "${ENGINEER_NAME}"; do
      container="agentteams-worker-${member}"
      resource="$(member_json "${member}" || true)"
      if [[ -z "${resource}" ]] || \
         [[ "$(jq -r '.phase // empty' <<<"${resource}")" != Running ]] || \
         [[ "$(jq -r '.containerState // empty' <<<"${resource}")" != running ]] || \
         ! container_exists "${container}" || \
         [[ "$(docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null)" != true ]]; then
        ready=0
        break
      fi
      if [[ "${member}" != "${LEADER_NAME}" ]] && \
         ! docker exec "${CONTROLLER_CONTAINER}" mc stat \
           "agentteams/agentteams-storage/agents/${member}/.openclaw/credentials/matrix/credentials.json" \
           >/dev/null 2>&1; then
        ready=0
        break
      fi
    done
    ((ready == 1)) && return 0
    sleep 2
  done
  return 1
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
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
    "/root/agentteams-fs/agents/${LEADER_NAME}" \
    "/root/agentteams-fs/agents/${COORDINATOR_NAME}" \
    "/root/agentteams-fs/agents/${ENGINEER_NAME}" \
    "/root/agentteams-fs/teams/${TEAM_NAME}"; do
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
    "/root/agentteams-fs/agents/${LEADER_NAME}" \
    "/root/agentteams-fs/agents/${COORDINATOR_NAME}" \
    "/root/agentteams-fs/agents/${ENGINEER_NAME}" \
    "/root/agentteams-fs/teams/${TEAM_NAME}"; do
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
  [[ "$(docker exec "${container}" printenv AGENTTEAMS_WORKER_NAME)" == "${member}" ]] || \
    die "Worker identity environment is wrong for ${member}."
  [[ "$(docker exec "${container}" printenv OPENCLAW_AGENT_RUNTIME)" == tiangong-pi ]] || \
    die "Tiangong Harness is not selected for ${member}."
  [[ "$(docker exec "${container}" printenv TIANGONG_OTEL_EXPORTER_ENDPOINT)" == "${OTLP_ENDPOINT}" ]] || \
    die "Worker observability endpoint is not the owned smoke receiver for ${member}."
}

assert_peer_policy() {
  local container="$1" member="$2" peer_id="$3" leader_id="$4" admin_id="$5"
  local config="/root/agentteams-fs/agents/${member}/openclaw.json" status
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
  local config="/root/agentteams-fs/agents/${member}/openclaw.json"
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
  state_root="/root/agentteams-fs/agents/${member}/.tiangong/runtime/sessions"
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

sync_trace_file() {
  local temporary="${OTLP_SPANS_FILE}.tmp"
  rm -f -- "${temporary}"
  if docker cp "${OTLP_CONTAINER}:/data/spans.jsonl" "${temporary}" >/dev/null 2>&1; then
    chmod 600 "${temporary}" && mv -f -- "${temporary}" "${OTLP_SPANS_FILE}"
  else
    rm -f -- "${temporary}"
    return 1
  fi
}

trace_summary() {
  local event_id="$1" digest
  sync_trace_file || true
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

trace_activity_facts() {
  trace_summary "$1" | jq -c -f "${OTLP_ACTIVITY_QUERY}" 2>/dev/null || \
    printf '{"observable":false}\n'
}

trace_inventory() {
  sync_trace_file || true
  [[ -f "${OTLP_SPANS_FILE}" ]] || {
    printf '[]\n'
    return
  }
  jq -cs '[.[] | {
    turn:(.attributes["tiangong.turn.id"] // null),
    name,
    phase:(.attributes["tiangong.phase"] // null),
    outcome:(.attributes["tiangong.operation.outcome"] // null),
    errorType:(.attributes["error.type"] // null),
    statusCode
  }]' "${OTLP_SPANS_FILE}" 2>/dev/null || printf '[]\n'
}

receiver_status() {
  docker exec "${OTLP_CONTAINER}" node -e '
    fetch("http://127.0.0.1:4318/health")
      .then((response) => response.json())
      .then((value) => process.stdout.write(JSON.stringify(value)))
      .catch(() => process.exit(1));
  ' 2>/dev/null || printf '{"status":"unavailable"}'
}

assert_trace_complete() {
  local event_id="$1" label="$2" expected_phase="$3" digest
  digest="$(observability_turn_digest "${event_id}")"
  for _ in $(seq 1 30); do
    sync_trace_file || true
    if [[ -f "${OTLP_SPANS_FILE}" ]] && jq -se \
      --arg digest "${digest}" --arg phase "${expected_phase}" '
      any(.[];
        .name == "tiangong.harness.attempt" and
        .attributes["tiangong.turn.id"] == $digest and
        .attributes["tiangong.operation.outcome"] == "complete" and
        .statusCode == 1
      ) and
      any(.[];
        .name == "tiangong.lifecycle.checkpoint" and
        .attributes["tiangong.turn.id"] == $digest and
        .attributes["tiangong.phase"] == $phase and
        .statusCode == 1
      ) and
      all(.[] | select(.attributes["tiangong.turn.id"] == $digest);
        .name != "tiangong.pi.agent_turn" and .name != "gen_ai.chat"
      )
    ' "${OTLP_SPANS_FILE}" >/dev/null; then
      printf 'peer_%s_observability=pass\n' "${label}"
      return 0
    fi
    sleep 1
  done
  printf '[Tiangong] Sanitized trace summary for %s: %s\n' \
    "${label}" "$(trace_summary "${event_id}")" >&2
  printf '[Tiangong] Sanitized turn activity facts for %s: %s\n' \
    "${label}" "$(trace_activity_facts "${event_id}")" >&2
  printf '[Tiangong] Sanitized OTLP receiver status: %s\n' "$(receiver_status)" >&2
  printf '[Tiangong] Sanitized unmatched trace inventory: %s\n' "$(trace_inventory)" >&2
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
  local status=$? cleanup_failed=0 team_absent=0 workers_absent=0
  trap - EXIT INT TERM
  set +e

  if ((otlp_owned == 1)); then
    if container_exists "${OTLP_CONTAINER}"; then
      docker rm --force "${OTLP_CONTAINER}" >/dev/null 2>&1 || cleanup_failed=1
    fi
    if volume_exists "${OTLP_VOLUME}"; then
      docker volume rm "${OTLP_VOLUME}" >/dev/null 2>&1 || cleanup_failed=1
    fi
    rm -rf -- "${OTLP_DATA_DIRECTORY}" || cleanup_failed=1
    ! container_exists "${OTLP_CONTAINER}" || cleanup_failed=1
    ! volume_exists "${OTLP_VOLUME}" || cleanup_failed=1
    [[ ! -e "${OTLP_DATA_DIRECTORY}" ]] || cleanup_failed=1
  fi

  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_MANIFEST}" "${MANAGER_WORKER_MANIFEST}" >/dev/null 2>&1 || cleanup_failed=1
  if container_exists "${COORDINATOR_CONTAINER}"; then
    docker exec "${COORDINATOR_CONTAINER}" rm -f \
      "${COORDINATOR_ROOM_MEMBERS}" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if container_exists "${ENGINEER_CONTAINER}"; then
    docker exec "${ENGINEER_CONTAINER}" rm -f \
      "${ENGINEER_ROOM_MEMBERS}" >/dev/null 2>&1 || cleanup_failed=1
  fi

  if ((owned_resources == 1)); then
    capture_manager_cleanup_state || cleanup_failed=1
    if ((cleanup_failed == 0)); then
      for member in "${LEADER_NAME}" "${COORDINATOR_NAME}" "${ENGINEER_NAME}"; do
        leave_manager_from_worker_room "${member}" || cleanup_failed=1
      done
      if ((cleanup_failed == 0)); then
        log "Deleting temporary Team ${TEAM_NAME}"
        controller_delete_team || cleanup_failed=1
      fi
      if ((cleanup_failed == 0)) && wait_for_team_absent; then
        team_absent=1
      else
        cleanup_failed=1
      fi
    fi

    if ((team_absent == 1)); then
      restart_manager_after_cleanup || cleanup_failed=1
      if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
        for member in "${LEADER_NAME}" "${COORDINATOR_NAME}" "${ENGINEER_NAME}"; do
          docker exec "${MANAGER_CONTAINER}" agt delete worker "${member}" >/dev/null 2>&1 || cleanup_failed=1
        done
        for _ in $(seq 1 180); do
          if ! member_json "${LEADER_NAME}" >/dev/null 2>&1 && \
             ! member_json "${COORDINATOR_NAME}" >/dev/null 2>&1 && \
             ! member_json "${ENGINEER_NAME}" >/dev/null 2>&1 && \
             ! container_exists "${LEADER_CONTAINER}" && \
             ! container_exists "${COORDINATOR_CONTAINER}" && \
             ! container_exists "${ENGINEER_CONTAINER}"; then
            workers_absent=1
            break
          fi
          sleep 1
        done
        if ((workers_absent == 0)); then
          printf '[Tiangong] ERROR: temporary Workers did not finish deletion.\n' >&2
          cleanup_failed=1
        fi
      else
        cleanup_failed=1
      fi
    else
      printf '[Tiangong] ERROR: temporary Team cleanup did not finish; Manager remains stopped.\n' >&2
    fi

    docker exec "${CONTROLLER_CONTAINER}" "${CONTROLLER_ALIAS_HELPER}" delete || cleanup_failed=1
    if ((team_absent == 1 && workers_absent == 1)); then
      purge_reserved_storage || cleanup_failed=1
      reserved_storage_absent || cleanup_failed=1
    else
      cleanup_failed=1
    fi
  fi

  docker exec "${CONTROLLER_CONTAINER}" rm -f \
    "${CONTROLLER_PEER_ROUNDTRIP}" "${CONTROLLER_ALIAS_HELPER}" >/dev/null 2>&1 || cleanup_failed=1
  docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_MANIFEST}" || cleanup_failed=1
  docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_WORKER_MANIFEST}" || cleanup_failed=1
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
for command in docker jq grep awk sha256sum node curl id; do
  command -v "${command}" >/dev/null 2>&1 || die "Missing required command: ${command}"
done
for path in "${MANIFEST}" "${WORKER_MANIFEST}" "${BUILD_WORKER_IMAGE}" "${PEER_ROUNDTRIP}" \
  "${ROOM_MEMBERS}" "${ALIAS_HELPER}" "${OTLP_RECEIVER}" "${OTLP_ACTIVITY_QUERY}"; do
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
! volume_exists "${OTLP_VOLUME}" || \
  die "Reserved observability volume ${OTLP_VOLUME} already exists; refusing to replace it."
[[ ! -e "${OTLP_DATA_DIRECTORY}" ]] || \
  die "Reserved observability data path already exists; refusing to replace it."
reserved_storage_absent || die "Reserved peer smoke storage is not empty; refusing to replace it."
docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_MANIFEST}" || \
  die "Reserved Manager helper path already exists; refusing to replace it."
docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_WORKER_MANIFEST}" || \
  die "Reserved Manager Worker manifest path already exists; refusing to replace it."
docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_PEER_ROUNDTRIP}" || \
  die "Reserved Controller round-trip helper already exists; refusing to replace it."
docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_ALIAS_HELPER}" || \
  die "Reserved Controller alias helper already exists; refusing to replace it."

docker cp "${ALIAS_HELPER}" "${CONTROLLER_CONTAINER}:${CONTROLLER_ALIAS_HELPER}"
docker exec "${CONTROLLER_CONTAINER}" "${CONTROLLER_ALIAS_HELPER}" assert-absent
TIANGONG_OTEL_EXPORTER_ENDPOINT="${OTLP_ENDPOINT}" "${BUILD_WORKER_IMAGE}"
mkdir -m 700 "${OTLP_DATA_DIRECTORY}"
docker volume create --label "io.tiangong.smoke=peer-mention" "${OTLP_VOLUME}" >/dev/null
otlp_owned=1
docker run --rm -i \
  --read-only \
  --cap-drop ALL \
  --cap-add CHOWN \
  --security-opt no-new-privileges=true \
  --env "OTLP_OWNER_UID=$(id -u)" \
  --env "OTLP_OWNER_GID=$(id -g)" \
  --mount "type=volume,src=${OTLP_VOLUME},dst=/data" \
  --entrypoint sh \
  "${IMAGE}" -c 'umask 077; cat > /data/tiangong-otlp-receiver.mjs; chmod 600 /data/tiangong-otlp-receiver.mjs; chown "${OTLP_OWNER_UID}:${OTLP_OWNER_GID}" /data /data/tiangong-otlp-receiver.mjs' \
  <"${OTLP_RECEIVER}"
docker create \
  --name "${OTLP_CONTAINER}" \
  --network agentteams-net \
  --network-alias "${OTLP_NETWORK_ALIAS}" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges=true \
  --user "$(id -u):$(id -g)" \
  --mount "type=volume,src=${OTLP_VOLUME},dst=/data" \
  --entrypoint node \
  "${IMAGE}" /data/tiangong-otlp-receiver.mjs /data/spans.jsonl >/dev/null
docker start "${OTLP_CONTAINER}" >/dev/null
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
docker cp "${WORKER_MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_WORKER_MANIFEST}"
docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
owned_resources=1
log "Creating temporary AgentTeams Workers ${LEADER_NAME}, ${COORDINATOR_NAME}, and ${ENGINEER_NAME}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_WORKER_MANIFEST}" || \
  die "Peer Worker apply failed."
wait_for_worker_provisioning || die "Peer Workers did not finish provisioning within 240 seconds."
log "Creating temporary AgentTeams Team ${TEAM_NAME}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_MANIFEST}" || \
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
coordinator_config="/root/agentteams-fs/agents/${COORDINATOR_NAME}/openclaw.json"
engineer_config="/root/agentteams-fs/agents/${ENGINEER_NAME}/openclaw.json"
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
          "${nonce}" "/root/agentteams-fs/agents/${diagnostic_member}/.tiangong/runtime/sessions" \
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
    printf '[Tiangong] Sanitized Coordinator turn activity facts: %s\n' \
      "$(trace_activity_facts "${start_event_id}")" >&2
    printf '[Tiangong] Sanitized OTLP receiver status: %s\n' "$(receiver_status)" >&2
    if [[ "${trace}" == '[]' ]]; then
      printf '[Tiangong] Sanitized unmatched trace inventory: %s\n' "$(trace_inventory)" >&2
    fi
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
assert_trace_complete "${start_event_id}" coordinator_start peer.transport.start || \
  die "Coordinator start-event trace did not complete."
assert_trace_complete "${ping_event_id}" engineer_ping peer.transport.ping || \
  die "Engineer ping-event trace did not complete."
assert_trace_complete "${pong_event_id}" coordinator_pong peer.transport.pong || \
  die "Coordinator pong-event trace did not complete."
assert_nonce_persisted "${COORDINATOR_CONTAINER}" "${COORDINATOR_NAME}" "${nonce}"
assert_nonce_persisted "${ENGINEER_CONTAINER}" "${ENGINEER_NAME}" "${nonce}"
leader_snapshot_after="$(stock_session_snapshot)"
[[ "${leader_snapshot_after}" == "${leader_snapshot_before}" ]] || \
  die "Stock Leader session state changed during messages that did not mention it."
printf 'stock_leader_model_turn_count=0\n'
printf 'peer_test_identities_are_not_role_authority=pass\n'
log "Worker peer mention and stock Leader non-interference smoke passed."
