#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tg-worker:dev"
readonly STOCK_LEADER_IMAGE="higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-copaw-worker:v1.2.0"
readonly TEAM_NAME="tiangong-specialist-handoff"
readonly LEADER_NAME="tiangong-specialist-handoff-leader"
readonly SPECIALIST_NAME="tiangong-specialist-handoff-specialist"
readonly OBSERVER_NAME="tiangong-specialist-handoff-observer"
readonly LEADER_CONTAINER="agentteams-worker-${LEADER_NAME}"
readonly SPECIALIST_CONTAINER="agentteams-worker-${SPECIALIST_NAME}"
readonly OBSERVER_CONTAINER="agentteams-worker-${OBSERVER_NAME}"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/specialist-handoff-smoke-team.yaml"
readonly WORKER_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/specialist-handoff-smoke-workers.yaml"
readonly BUILD_WORKER_IMAGE="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly ROOM_MEMBERS="${SCRIPT_DIR}/matrix-peer-room-members.sh"
readonly ALIAS_HELPER="${SCRIPT_DIR}/matrix-specialist-handoff-aliases.sh"
readonly OTLP_RECEIVER="${SCRIPT_DIR}/otlp-smoke-receiver.mjs"
readonly OTLP_ACTIVITY_QUERY="${SCRIPT_DIR}/otlp-turn-activity.jq"
readonly OTLP_CONTAINER="tiangong-specialist-handoff-otel"
readonly OTLP_VOLUME="tiangong-specialist-handoff-otel-data"
readonly OTLP_NETWORK_ALIAS="tiangong-otel-collector"
readonly OTLP_ENDPOINT="http://${OTLP_NETWORK_ALIAS}:4318/v1/traces"
readonly OTLP_DATA_DIRECTORY="${REPO_ROOT}/.runtime/specialist-handoff-observability"
readonly OTLP_SPANS_FILE="${OTLP_DATA_DIRECTORY}/spans.jsonl"
readonly MANAGER_MANIFEST="/tmp/tiangong-specialist-handoff-team.yaml"
readonly MANAGER_WORKER_MANIFEST="/tmp/tiangong-specialist-handoff-workers.yaml"
readonly CONTROLLER_ALIAS_HELPER="/tmp/tiangong-specialist-handoff-aliases.sh"
readonly SPECIALIST_ROOM_MEMBERS="/tmp/tiangong-specialist-handoff-room-members.sh"
readonly OBSERVER_ROOM_MEMBERS="/tmp/tiangong-specialist-handoff-room-members.sh"
readonly SMOKE_MODE="${TIANGONG_SPECIALIST_HANDOFF_MODE:-full}"
owned_resources=0
otlp_owned=0
manager_restart_required=0
controller_api_token=''
admin_access_token=''
leader_cleanup_room_id=''
specialist_cleanup_room_id=''
observer_cleanup_room_id=''

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
  resource="$(member_json "${SPECIALIST_NAME}" || true)"
  specialist_cleanup_room_id="$(jq -r '.roomID // empty' <<<"${resource}" 2>/dev/null || true)"
  resource="$(member_json "${OBSERVER_NAME}" || true)"
  observer_cleanup_room_id="$(jq -r '.roomID // empty' <<<"${resource}" 2>/dev/null || true)"
  if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
    docker stop "${MANAGER_CONTAINER}" >/dev/null || return 1
    manager_restart_required=1
  fi
}

leave_manager_from_worker_room() {
  local member="$1" room_id
  case "${member}" in
    "${LEADER_NAME}") room_id="${leader_cleanup_room_id}" ;;
    "${SPECIALIST_NAME}") room_id="${specialist_cleanup_room_id}" ;;
    "${OBSERVER_NAME}") room_id="${observer_cleanup_room_id}" ;;
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
    for member in "${LEADER_NAME}" "${SPECIALIST_NAME}" "${OBSERVER_NAME}"; do
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
    "agents/${SPECIALIST_NAME}" \
    "agents/${OBSERVER_NAME}" \
    "teams/${TEAM_NAME}"; do
    if remote_prefix_has_objects "${prefix}"; then
      return 1
    fi
  done
  for mirror_root in \
    "/root/agentteams-fs/agents/${LEADER_NAME}" \
    "/root/agentteams-fs/agents/${SPECIALIST_NAME}" \
    "/root/agentteams-fs/agents/${OBSERVER_NAME}" \
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
    "agents/${SPECIALIST_NAME}" \
    "agents/${OBSERVER_NAME}" \
    "teams/${TEAM_NAME}"; do
    docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
      "agentteams/agentteams-storage/${prefix}/" >/dev/null 2>&1 || failed=1
  done
  for mirror_root in \
    "/root/agentteams-fs/agents/${LEADER_NAME}" \
    "/root/agentteams-fs/agents/${SPECIALIST_NAME}" \
    "/root/agentteams-fs/agents/${OBSERVER_NAME}" \
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
  [[ "$(docker exec "${container}" printenv OPENCLAW_AGENT_RUNTIME)" == pi ]] || \
    die "The pinned OpenClaw built-in runtime is not selected for ${member}."
  [[ "$(docker exec "${container}" printenv TIANGONG_OTEL_EXPORTER_ENDPOINT)" == "${OTLP_ENDPOINT}" ]] || \
    die "Worker observability endpoint is not the owned smoke receiver for ${member}."
}

assert_handoff_policy() {
  local container="$1" member="$2" handoff_id="$3" leader_id="$4" admin_id="$5"
  local config="/root/agentteams-fs/agents/${member}/openclaw.json" status
  for _ in $(seq 1 30); do
    if docker exec "${container}" jq -e \
      --arg peer "${handoff_id}" \
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
    --arg peer "${handoff_id}" \
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
  die "Matrix specialist handoff policy is incomplete for ${member}."
}

handoff_policy_digest() {
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

assert_handoff_channel_stable() {
  local container="$1" member="$2"
  local policy_before policy_after status_before status_after
  for _ in $(seq 1 12); do
    policy_before="$(handoff_policy_digest "${container}" "${member}")" || {
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
    policy_after="$(handoff_policy_digest "${container}" "${member}")" || continue
    status_after="$(matrix_channel_status "${container}")" || continue
    if [[ "${policy_after}" == "${policy_before}" ]] && \
       matrix_channel_is_ready <<<"${status_after}" && \
       [[ "$(jq -r '.lastStartAt' <<<"${status_after}")" == \
          "$(jq -r '.lastStartAt' <<<"${status_before}")" ]]; then
      printf 'handoff_%s_matrix_active_channel=%s\n' \
        "${member##*-}" "${status_after}"
      return 0
    fi
  done
  status_after="$(matrix_channel_status "${container}" 2>/dev/null || printf '{"observable":false}')"
  printf '[Tiangong] Matrix channel did not stabilize for %s: %s\n' \
    "${member}" "${status_after}" >&2
  return 1
}

control_snapshot() {
  local container="$1" worker state_path
  worker="$(docker exec "${container}" printenv AGENTTEAMS_WORKER_NAME)"
  state_path="/root/agentteams-fs/agents/${worker}/.tiangong/runtime/tool-results/openclaw.json"
  if ! docker exec "${container}" test -f "${state_path}"; then
    printf 'absent\n'
    return
  fi
  docker exec "${container}" stat -c '%y:%s' "${state_path}"
}

assert_control() {
  local container="$1" member="$2" baseline="$3" current worker state_path
  for _ in $(seq 1 30); do
    current="$(control_snapshot "${container}")"
    if [[ "${current}" != "${baseline}" ]]; then
      worker="$(docker exec "${container}" printenv AGENTTEAMS_WORKER_NAME)"
      state_path="/root/agentteams-fs/agents/${worker}/.tiangong/runtime/tool-results/openclaw.json"
      if docker exec "${container}" jq -e '.results | length > 0' "${state_path}" >/dev/null; then
        printf 'handoff_%s_control=pass\n' "${member##*-}"
        return 0
      fi
    fi
    sleep 1
  done
  die "OpenClaw ToolResult marker did not complete for ${member}."
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
        .name == "tiangong.control.attempt" and
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
        .name != "tiangong.openclaw.agent_turn" and .name != "gen_ai.chat"
      )
    ' "${OTLP_SPANS_FILE}" >/dev/null; then
      printf 'handoff_%s_observability=pass\n' "${label}"
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
    root="/root/.copaw-worker/$1/.copaw/workspaces/default/sessions"
    if [[ ! -d "${root}" ]]; then
      printf "0:%s\n" "$(printf empty | sha256sum | cut -d " " -f 1)"
      exit 0
    fi
    count="$(find "${root}" -type f | wc -l | tr -d " ")"
    digest="$(find "${root}" -type f -print0 | sort -z | \
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

  if [[ -n "${admin_access_token}" ]]; then
    admin_curl -X POST "${HOMESERVER}/_matrix/client/v3/logout" >/dev/null 2>&1 || cleanup_failed=1
    admin_access_token=''
  fi

  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_MANIFEST}" "${MANAGER_WORKER_MANIFEST}" >/dev/null 2>&1 || cleanup_failed=1
  if container_exists "${SPECIALIST_CONTAINER}"; then
    docker exec "${SPECIALIST_CONTAINER}" rm -f \
      "${SPECIALIST_ROOM_MEMBERS}" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if container_exists "${OBSERVER_CONTAINER}"; then
    docker exec "${OBSERVER_CONTAINER}" rm -f \
      "${OBSERVER_ROOM_MEMBERS}" >/dev/null 2>&1 || cleanup_failed=1
  fi

  if ((owned_resources == 1)); then
    capture_manager_cleanup_state || cleanup_failed=1
    if ((cleanup_failed == 0)); then
      for member in "${LEADER_NAME}" "${SPECIALIST_NAME}" "${OBSERVER_NAME}"; do
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
        for member in "${LEADER_NAME}" "${SPECIALIST_NAME}" "${OBSERVER_NAME}"; do
          docker exec "${MANAGER_CONTAINER}" agt delete worker "${member}" >/dev/null 2>&1 || cleanup_failed=1
        done
        for _ in $(seq 1 180); do
          if ! member_json "${LEADER_NAME}" >/dev/null 2>&1 && \
             ! member_json "${SPECIALIST_NAME}" >/dev/null 2>&1 && \
             ! member_json "${OBSERVER_NAME}" >/dev/null 2>&1 && \
             ! container_exists "${LEADER_CONTAINER}" && \
             ! container_exists "${SPECIALIST_CONTAINER}" && \
             ! container_exists "${OBSERVER_CONTAINER}"; then
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
    "${CONTROLLER_ALIAS_HELPER}" >/dev/null 2>&1 || cleanup_failed=1
  docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_MANIFEST}" || cleanup_failed=1
  docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_WORKER_MANIFEST}" || cleanup_failed=1
  docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_ALIAS_HELPER}" || cleanup_failed=1
  ((cleanup_failed == 0)) || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${SMOKE_MODE}" == full || "${SMOKE_MODE}" == config ]] || \
  die "TIANGONG_SPECIALIST_HANDOFF_MODE must be full or config."
for command in docker jq grep awk sha256sum node curl id; do
  command -v "${command}" >/dev/null 2>&1 || die "Missing required command: ${command}"
done
for path in "${MANIFEST}" "${WORKER_MANIFEST}" "${BUILD_WORKER_IMAGE}" \
  "${ROOM_MEMBERS}" "${ALIAS_HELPER}" "${OTLP_RECEIVER}" "${OTLP_ACTIVITY_QUERY}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || die "Required smoke asset is missing or symlinked: ${path}"
done
[[ -x "${BUILD_WORKER_IMAGE}" && -x "${ROOM_MEMBERS}" && -x "${ALIAS_HELPER}" ]] || \
  die "Specialist handoff support scripts must be executable."
docker info >/dev/null 2>&1 || die "The Docker daemon is unavailable."
for container in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}"; do
  container_exists "${container}" || die "${container} does not exist."
  [[ "$(docker inspect "${container}" --format '{{.State.Running}}')" == true ]] || \
    die "${container} is not running."
done

for resource in "${LEADER_NAME}" "${SPECIALIST_NAME}" "${OBSERVER_NAME}"; do
  ! member_json "${resource}" >/dev/null 2>&1 || \
    die "Reserved member ${resource} already exists; refusing to replace it."
done
! team_json >/dev/null 2>&1 || die "Reserved Team ${TEAM_NAME} already exists; refusing to replace it."
for container in "${LEADER_CONTAINER}" "${SPECIALIST_CONTAINER}" "${OBSERVER_CONTAINER}"; do
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
docker exec "${CONTROLLER_CONTAINER}" test ! -e "${CONTROLLER_ALIAS_HELPER}" || \
  die "Reserved Controller alias helper already exists; refusing to replace it."

docker cp "${ALIAS_HELPER}" "${CONTROLLER_CONTAINER}:${CONTROLLER_ALIAS_HELPER}"
docker exec "${CONTROLLER_CONTAINER}" "${CONTROLLER_ALIAS_HELPER}" assert-absent
TIANGONG_OTEL_EXPORTER_ENDPOINT="${OTLP_ENDPOINT}" "${BUILD_WORKER_IMAGE}"
mkdir -p "${OTLP_DATA_DIRECTORY}"
chmod 700 "${OTLP_DATA_DIRECTORY}"
docker volume create --label "io.tiangong.smoke=specialist-handoff" "${OTLP_VOLUME}" >/dev/null
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
printf 'handoff_observability_receiver=pass\n'
# the Specialist Worker owns the handoff send; the test driver sends only the Human source event
docker cp "${WORKER_MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_WORKER_MANIFEST}"
docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
owned_resources=1
log "Creating temporary AgentTeams Workers ${LEADER_NAME}, ${SPECIALIST_NAME}, and ${OBSERVER_NAME}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_WORKER_MANIFEST}" || \
  die "handoff Worker apply failed."
wait_for_worker_provisioning || die "handoff Workers did not finish provisioning within 240 seconds."
log "Creating temporary AgentTeams Team ${TEAM_NAME}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_MANIFEST}" || \
  die "Specialist handoff Team apply failed."

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

assert_worker_runtime "${SPECIALIST_NAME}" "${SPECIALIST_CONTAINER}"
assert_worker_runtime "${OBSERVER_NAME}" "${OBSERVER_CONTAINER}"
specialist_resource="$(member_json "${SPECIALIST_NAME}")"
observer_resource="$(member_json "${OBSERVER_NAME}")"
leader_user_id="$(jq -r '.matrixUserID // empty' <<<"${leader_resource}")"
specialist_user_id="$(jq -r '.matrixUserID // empty' <<<"${specialist_resource}")"
observer_user_id="$(jq -r '.matrixUserID // empty' <<<"${observer_resource}")"
specialist_room_id="$(jq -r '.roomID // empty' <<<"${specialist_resource}")"
observer_room_id="$(jq -r '.roomID // empty' <<<"${observer_resource}")"
manager_user_id="$(docker exec "${MANAGER_CONTAINER}" jq -r \
  '.channels.matrix.userId // empty' /root/manager-workspace/openclaw.json)"
admin_user="$(docker exec "${CONTROLLER_CONTAINER}" printenv AGENTTEAMS_ADMIN_USER)"
matrix_domain="$(docker exec "${CONTROLLER_CONTAINER}" printenv AGENTTEAMS_MATRIX_DOMAIN)"
admin_user_id="@${admin_user}:${matrix_domain}"
[[ -n "${leader_user_id}" && -n "${specialist_user_id}" && -n "${observer_user_id}" && \
   -n "${specialist_room_id}" && -n "${observer_room_id}" && -n "${manager_user_id}" ]] || \
  die "Peer Team Matrix identity is incomplete."

wait_for_worker_channel "${SPECIALIST_CONTAINER}" "${SPECIALIST_NAME}" "${team_room_id}" 0 || \
  die "Coordinator Worker Team Room channel did not become ready."
wait_for_worker_channel "${OBSERVER_CONTAINER}" "${OBSERVER_NAME}" "${team_room_id}" 0 || \
  die "Engineer Worker Team Room channel did not become ready."
printf 'handoff_worker_runtime_and_channel_readiness=pass\n'
docker cp "${ROOM_MEMBERS}" "${SPECIALIST_CONTAINER}:${SPECIALIST_ROOM_MEMBERS}"
docker cp "${ROOM_MEMBERS}" "${OBSERVER_CONTAINER}:${OBSERVER_ROOM_MEMBERS}"
specialist_config="/root/agentteams-fs/agents/${SPECIALIST_NAME}/openclaw.json"
docker exec "${SPECIALIST_CONTAINER}" "${SPECIALIST_ROOM_MEMBERS}" members \
  "${specialist_config}" "${team_room_id}" \
  "${admin_user_id},${leader_user_id},${specialist_user_id},${observer_user_id}" \
  "${manager_user_id}"
assert_handoff_policy "${SPECIALIST_CONTAINER}" "${SPECIALIST_NAME}" \
  "${leader_user_id}" "${leader_user_id}" "${admin_user_id}"
assert_handoff_policy "${OBSERVER_CONTAINER}" "${OBSERVER_NAME}" \
  "${specialist_user_id}" "${leader_user_id}" "${admin_user_id}"
printf 'matrix_handoff_channel_policy=pass\n'
assert_handoff_channel_stable "${SPECIALIST_CONTAINER}" "${SPECIALIST_NAME}" || \
  die "Specialist Matrix listener did not stabilize after handoff policy publication."
assert_handoff_channel_stable "${OBSERVER_CONTAINER}" "${OBSERVER_NAME}" || \
  die "Observer Matrix listener did not stabilize after handoff policy publication."
printf 'matrix_handoff_active_channel_stability=pass\n'

if [[ "${SMOKE_MODE}" == config ]]; then
  log "Specialist handoff configuration boundary passed."
  exit 0
fi

HOMESERVER="${AGENTTEAMS_MATRIX_URL%/}"
MATRIX_DOMAIN="${AGENTTEAMS_MATRIX_DOMAIN:-}"
ADMIN_USER="${AGENTTEAMS_ADMIN_USER:-}"
ADMIN_PASSWORD="${AGENTTEAMS_ADMIN_PASSWORD:-}"
[[ -n "${HOMESERVER}" && -n "${MATRIX_DOMAIN}" && -n "${ADMIN_USER}" && -n "${ADMIN_PASSWORD}" ]] || \
  die "Matrix Admin environment is incomplete."
admin_access_token=''

admin_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "${admin_access_token}" | \
    curl --fail --silent --show-error --max-time 30 -K - "$@"
}

admin_login() {
  local body response
  body="$(jq -cn --arg user "${ADMIN_USER}" --arg password "${ADMIN_PASSWORD}" \
    '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password}')"
  response="$(printf '%s' "${body}" | curl --fail --silent --show-error --max-time 30 \
    -H 'Content-Type: application/json' --data-binary @- \
    "${HOMESERVER}/_matrix/client/v3/login")"
  admin_access_token="$(jq -r '.access_token // empty' <<<"${response}")"
  [[ -n "${admin_access_token}" ]] || die "Matrix Admin login did not return an access token."
  body=''
  response=''
}

admin_room_messages() {
  local room_path
  room_path="$(printf '%s' "${team_room_id}" | jq -sRr @uri)"
  admin_curl "${HOMESERVER}/_matrix/client/v3/rooms/${room_path}/messages?dir=b&limit=64"
}

leader_room_messages() {
  docker exec -i "${LEADER_CONTAINER}" sh -s -- "${team_room_id}" <<'LEADER_MESSAGES'
set -eu
room_id="$1"
config="${OPENCLAW_CONFIG_PATH:-}"
if [ -z "${config}" ] || [ ! -f "${config}" ]; then
  config="$(find /root -maxdepth 7 -type f -name openclaw.json -print -quit)"
fi
[ -f "${config}" ] || exit 1
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${config}")"
token="$(jq -r '.channels.matrix.accessToken // empty' "${config}")"
[ -n "${homeserver}" ] && [ -n "${token}" ] || exit 1
room_path="$(printf '%s' "${room_id}" | jq -sRr @uri)"
printf 'header = "Authorization: Bearer %s"\n' "${token}" | \
  curl --fail --silent --show-error --max-time 30 -K - \
  "${homeserver%/}/_matrix/client/v3/rooms/${room_path}/messages?dir=b&limit=64"
token=''
LEADER_MESSAGES
}

leader_has_event() {
  local event_id="$1" messages
  messages="$(leader_room_messages 2>/dev/null || true)"
  jq -e --arg event "${event_id}" '[.chunk[]? | select(.type == "m.room.message" and .event_id == $event)] | length == 1' \
    >/dev/null 2>&1 <<<"${messages}"
}

specialist_ack() {
  docker exec -i "${SPECIALIST_CONTAINER}" sh -s -- "${SPECIALIST_NAME}" <<'SPECIALIST_ACK'
set -eu
member="$1"
root="/root/agentteams-fs/agents/${member}/.tiangong/runtime/sessions"
find "${root}" -type f -name '*.jsonl' -exec jq -r '.message.content[]?.text // empty' {} + 2>/dev/null |
  grep -F 'TG_HANDOFF_SENDER_ACK transaction_id=' |
  tail -n 1
SPECIALIST_ACK
}

diagnose_specialist_failure() {
  printf '[Tiangong] Sanitized Specialist policy: '
  docker exec "${SPECIALIST_CONTAINER}" jq -c \
    '{groupAllowFrom:.channels.matrix.groupAllowFrom,dmAllowFrom:.channels.matrix.dm.allowFrom,requireMention:.channels.matrix.groups["*"].requireMention}' \
    "/root/agentteams-fs/agents/${SPECIALIST_NAME}/openclaw.json" 2>/dev/null || printf '{"observable":false}'
  printf '[Tiangong] Sanitized Specialist channel: '
  matrix_channel_status "${SPECIALIST_CONTAINER}" 2>/dev/null || printf '{"observable":false}'
  printf '[Tiangong] Sanitized Specialist ToolResult state: '
  docker exec "${SPECIALIST_CONTAINER}" printenv AGENTTEAMS_WORKER_NAME 2>/dev/null || printf 'absent\n'
  printf '[Tiangong] Specialist session facts: '
  docker exec -i "${SPECIALIST_CONTAINER}" sh -s -- "${SPECIALIST_NAME}" "${source_event_id}" <<'SPECIALIST_FACTS' 2>/dev/null || true
member="$1"
source_event="$2"
root="/root/agentteams-fs/agents/${member}/.tiangong/runtime/sessions"
evidence_root="/root/agentteams-fs/agents/${member}/.tiangong/runtime/evidence"
jsonl_files="$(find "${root}" -type f -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
text_lines="$(find "${root}" -type f -name '*.jsonl' -exec jq -r '.message.content[]?.text // empty' {} + 2>/dev/null || true)"
handoff_start_count="$(printf '%s\n' "${text_lines}" | grep -F 'TG_HANDOFF_START' | wc -l | tr -d ' ')"
handoff_ack_count="$(printf '%s\n' "${text_lines}" | grep -F 'TG_HANDOFF_SENDER_ACK' | wc -l | tr -d ' ')"
source_event_mentions="$(grep -Rho --include='*.jsonl' "${source_event}" "${root}" 2>/dev/null | wc -l | tr -d ' ')"
evidence_handoff_count="$(grep -Rho --include='*.jsonl' 'team.specialist.handoff.delivered' "${evidence_root}" 2>/dev/null | wc -l | tr -d ' ')"
printf 'session_root=%s jsonl_files=%s handoff_start_count=%s handoff_ack_count=%s source_event_mentions=%s evidence_handoff_count=%s\n' \
  "${root}" "${jsonl_files}" "${handoff_start_count}" "${handoff_ack_count}" "${source_event_mentions}" "${evidence_handoff_count}"
SPECIALIST_FACTS
  printf '[Tiangong] Specialist stable error-code count: '
  docker logs --since 3m "${SPECIALIST_CONTAINER}" 2>&1 | \
    grep -Eio 'code=[A-Z][A-Z0-9_]{0,63}|errorCode=[A-Z][A-Z0-9_]{0,63}' | tail -n 8 | paste -sd, - || true
  printf '[Tiangong] Specialist bounded failure lines:\n'
  docker logs --since 3m "${SPECIALIST_CONTAINER}" 2>&1 | \
    grep -Ei 'error|fail|exception|handoff|matrix' | \
    sed -E 's/(access[_-]?token|authorization|password|secret|api[_-]?key)[=:][^[:space:],}]*/\\1=<redacted>/Ig; s/(body|formatted_body)=[^[:space:]]*/\\1=<redacted>/Ig' | \
    tail -n 12 | cut -c1-300 || true
}

validate_source_event() {
  local event_json="$1"
  printf '%s' "${event_json}" | \
    HANDOFF_ROOM_ID="${team_room_id}" HANDOFF_EVENT_ID="${source_event_id}" \
    HANDOFF_SENDER_ID="${admin_user_id}" HANDOFF_SPECIALIST_ID="${specialist_user_id}" \
    HANDOFF_LEADER_ID="${leader_user_id}" \
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { validateHumanSourceEvent } from "./smoke-testing/support/matrix-specialist-handoff.mjs";
      const event = JSON.parse(readFileSync(0, "utf8"));
      validateHumanSourceEvent(event, {
        roomId: process.env.HANDOFF_ROOM_ID,
        eventId: process.env.HANDOFF_EVENT_ID,
        senderId: process.env.HANDOFF_SENDER_ID,
        specialistId: process.env.HANDOFF_SPECIALIST_ID,
        leaderId: process.env.HANDOFF_LEADER_ID,
      });
      process.stdout.write("handoff_human_source=pass\n");
    '
}

validate_handoff_event() {
  local event_json="$1"
  printf '%s' "${event_json}" | \
    HANDOFF_ROOM_ID="${team_room_id}" HANDOFF_EVENT_ID="${handoff_event_id}" \
    HANDOFF_SOURCE_EVENT_ID="${source_event_id}" HANDOFF_SOURCE_SENDER="${admin_user_id}" \
    HANDOFF_SPECIALIST_ID="${specialist_user_id}" HANDOFF_LEADER_ID="${leader_user_id}" \
    HANDOFF_WORK_ID="${work_id}" HANDOFF_INTENT_ID="${intent_id}" \
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { validateSpecialistHandoffEvent } from "./smoke-testing/support/matrix-specialist-handoff.mjs";
      const event = JSON.parse(readFileSync(0, "utf8"));
      validateSpecialistHandoffEvent(event, {
        roomId: process.env.HANDOFF_ROOM_ID,
        eventId: process.env.HANDOFF_EVENT_ID,
        sourceEventId: process.env.HANDOFF_SOURCE_EVENT_ID,
        sourceSender: process.env.HANDOFF_SOURCE_SENDER,
        specialistId: process.env.HANDOFF_SPECIALIST_ID,
        leaderId: process.env.HANDOFF_LEADER_ID,
        workId: process.env.HANDOFF_WORK_ID,
        intentId: process.env.HANDOFF_INTENT_ID,
      });
      process.stdout.write("handoff_raw_reference=pass\n");
    '
}

assert_invalid_reference_fail_closed() {
  local event_json="$1" invalid_event_json
  invalid_event_json="$(jq --arg wrong_event '$invalid-reference' \
    '.content["com.tiangong.handoff"].source.event_id = $wrong_event' <<<"${event_json}")"
  printf '%s' "${invalid_event_json}" | \
    HANDOFF_ROOM_ID="${team_room_id}" HANDOFF_EVENT_ID="${handoff_event_id}" \
    HANDOFF_SOURCE_EVENT_ID="${source_event_id}" HANDOFF_SOURCE_SENDER="${admin_user_id}" \
    HANDOFF_SPECIALIST_ID="${specialist_user_id}" HANDOFF_LEADER_ID="${leader_user_id}" \
    HANDOFF_WORK_ID="${work_id}" HANDOFF_INTENT_ID="${intent_id}" \
    node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { assertInvalidReferenceRejected } from "./smoke-testing/support/matrix-specialist-handoff.mjs";
      const event = JSON.parse(readFileSync(0, "utf8"));
      assertInvalidReferenceRejected(event, {
        roomId: process.env.HANDOFF_ROOM_ID,
        eventId: process.env.HANDOFF_EVENT_ID,
        sourceEventId: process.env.HANDOFF_SOURCE_EVENT_ID,
        sourceSender: process.env.HANDOFF_SOURCE_SENDER,
        specialistId: process.env.HANDOFF_SPECIALIST_ID,
        leaderId: process.env.HANDOFF_LEADER_ID,
        workId: process.env.HANDOFF_WORK_ID,
        intentId: process.env.HANDOFF_INTENT_ID,
      });
      process.stdout.write("handoff_invalid_reference_fail_closed=pass\n");
    '
}

assert_no_work_admission() {
  local work="$1" intent="$2" id prefix path
  for id in "${work}" "${intent}"; do
    for prefix in \
      "shared/projects/${id}" \
      "shared/tasks/${id}" \
      "teams/${TEAM_NAME}/shared/projects/${id}" \
      "teams/${TEAM_NAME}/shared/tasks/${id}"; do
      if remote_prefix_has_objects "${prefix}"; then
        die "Handoff admitted unexpected Work storage under ${prefix}."
      fi
    done
  done
  for id in "${work}" "${intent}"; do
    for path in \
      "/root/agentteams-fs/shared/projects/${id}" \
      "/root/agentteams-fs/shared/tasks/${id}" \
      "/root/agentteams-fs/teams/${TEAM_NAME}/shared/projects/${id}" \
      "/root/agentteams-fs/teams/${TEAM_NAME}/shared/tasks/${id}"; do
      if docker exec "${CONTROLLER_CONTAINER}" test -e "${path}" || \
         docker exec "${MANAGER_CONTAINER}" test -e "${path}" || \
         docker exec "${LEADER_CONTAINER}" test -e "${path}" || \
         docker exec "${SPECIALIST_CONTAINER}" test -e "${path}"; then
        die "Handoff admitted unexpected Work path ${path}."
      fi
    done
  done
  for id in "${work}" "${intent}"; do
    for path in \
      "/root/.copaw-worker/${LEADER_NAME}/.copaw/workspaces/default/shared/projects/${id}" \
      "/root/.copaw-worker/${LEADER_NAME}/.copaw/workspaces/default/shared/tasks/${id}"; do
      if docker exec "${LEADER_CONTAINER}" test -e "${path}"; then
        die "Handoff admitted unexpected Leader Work path ${path}."
      fi
    done
  done
  printf 'handoff_agent_communication_not_human_work=pass\n'
}

leader_snapshot_before="$(stock_session_snapshot)"
specialist_control_before="$(control_snapshot "${SPECIALIST_CONTAINER}")"
observer_control_before="$(control_snapshot "${OBSERVER_CONTAINER}")"
admin_login
nonce="$(cat /proc/sys/kernel/random/uuid)"
work_id="work-${nonce}"
intent_id="intent-${nonce}"
room_path="$(printf '%s' "${team_room_id}" | jq -sRr @uri)"
source_body="$(jq -cn \
  --arg specialist "${specialist_user_id}" \
  --arg work "${work_id}" \
  --arg intent "${intent_id}" \
  '{msgtype:"m.text",body:($specialist + " TG_HANDOFF_START work=" + $work + " intent=" + $intent),format:"org.matrix.custom.html",formatted_body:("<a href=\"https://matrix.to/#/" + $specialist + "\">" + $specialist + "</a> TG_HANDOFF_START work=" + $work + " intent=" + $intent),"m.mentions":{user_ids:[$specialist]}}')"
jq -e --arg specialist "${specialist_user_id}" --arg leader "${leader_user_id}" \
  '."m.mentions".user_ids == [$specialist] and (.body | contains($leader) | not)' \
  <<<"${source_body}" >/dev/null || die "Human source event violates the Specialist-only mention boundary."
source_response="$(admin_curl -X PUT -H 'Content-Type: application/json' \
  --data-binary "${source_body}" \
  "${HOMESERVER}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/tiangong_handoff_source_${nonce}")"
source_event_id="$(jq -r '.event_id // empty' <<<"${source_response}")"
[[ "${source_event_id}" =~ ^\$[^[:space:]]+$ ]] || die "Matrix did not return a valid Human source event ID."
source_response=''
source_body=''
printf 'handoff_human_event_sent=pass\n'
printf 'handoff_source_event_id=%s\n' "${source_event_id}"

ack_line=''
for _ in $(seq 1 90); do
  ack_line="$(specialist_ack || true)"
  [[ -n "${ack_line}" ]] && break
  sleep 1
done
if [[ -z "${ack_line}" ]]; then
  diagnose_specialist_failure
  die "Specialist sender acknowledgement was not persisted."
fi
read -r sender_transaction_id handoff_event_id replay_event_id < <(
  sed -n 's/.*transaction_id=\([^ ]*\) event_id=\([^ ]*\) replay_event_id=\([^ ]*\).*/\1 \2 \3/p' <<<"${ack_line}"
)
[[ -n "${sender_transaction_id}" && -n "${handoff_event_id}" && "${handoff_event_id}" == "${replay_event_id}" ]] || \
  die "Specialist sender acknowledgement did not bind one replayed event."
printf 'handoff_specialist_sender_ack=pass\n'
printf 'handoff_transaction_id=%s\n' "${sender_transaction_id}"
printf 'handoff_event_id=%s\n' "${handoff_event_id}"
assert_control "${SPECIALIST_CONTAINER}" "${SPECIALIST_NAME}" "${specialist_control_before}"

messages=''
for _ in $(seq 1 30); do
  messages="$(admin_room_messages)"
  handoff_count="$(jq --arg event "${handoff_event_id}" \
    '[.chunk[]? | select(.type == "m.room.message" and .event_id == $event)] | length' <<<"${messages}")"
  [[ "${handoff_count}" == 1 ]] && break
  sleep 1
done
[[ "${handoff_count}" == 1 ]] || die "Admin could not observe exactly one Specialist handoff event."
source_event_json="$(jq -c --arg event "${source_event_id}" '[.chunk[]? | select(.event_id == $event)][0]' <<<"${messages}")"
handoff_event_json="$(jq -c --arg event "${handoff_event_id}" '[.chunk[]? | select(.event_id == $event)][0]' <<<"${messages}")"
[[ "${source_event_json}" != null && "${handoff_event_json}" != null ]] || die "Required source or handoff event is missing."
validate_source_event "${source_event_json}"
validate_handoff_event "${handoff_event_json}"
assert_invalid_reference_fail_closed "${handoff_event_json}"
printf 'handoff_visible_event_count=1\n'

leader_receipt=''
for _ in $(seq 1 60); do
  if leader_has_event "${handoff_event_id}" && [[ "$(stock_session_snapshot)" != "${leader_snapshot_before}" ]]; then
    leader_receipt=1
    break
  fi
  sleep 1
done
if [[ "${leader_receipt}" != 1 ]]; then
  leader_snapshot_after="$(stock_session_snapshot 2>/dev/null || printf 'unavailable')"
  leader_messages_after="$(leader_room_messages 2>/dev/null || true)"
  leader_message_count="$(jq '[.chunk[]? | select(.type == "m.room.message")] | length' <<<"${leader_messages_after}" 2>/dev/null || printf 'unavailable')"
  leader_event_count="$(jq --arg event "${handoff_event_id}" '[.chunk[]? | select(.type == "m.room.message" and .event_id == $event)] | length' <<<"${leader_messages_after}" 2>/dev/null || printf 'unavailable')"
  leader_message_facts="$(jq -c '[.chunk[]? | select(.type == "m.room.message") | {event_id,sender,origin_server_ts}]' <<<"${leader_messages_after}" 2>/dev/null || printf '[]')"
  printf '[Tiangong] Sanitized Leader receipt facts: before=%s after=%s message_count=%s handoff_event_count=%s messages=%s\n' \
    "${leader_snapshot_before}" "${leader_snapshot_after}" "${leader_message_count}" "${leader_event_count}" "${leader_message_facts}" >&2
  printf '[Tiangong] Sanitized Leader diagnostics:\n'
  docker logs --since 5m "${LEADER_CONTAINER}" 2>&1 | \
    grep -Ei 'matrix|session|message|event|error|fail|exception|model' | \
    sed -E 's/.*(msgs_str|content|text)[":=].*/\\1=<redacted>/Ig; s/(access[_-]?token|authorization|password|secret|api[_-]?key)[=:][^[:space:],}]*/\\1=<redacted>/Ig; s/(body|formatted_body)=[^[:space:]]*/\\1=<redacted>/Ig' | \
    tail -n 20 >&2 || true
  die "Independent Leader receipt was not observed."
fi
printf 'handoff_leader_receipt=pass\n'
printf 'handoff_leader_session_changed=pass\n'
assert_no_work_admission "${work_id}" "${intent_id}"
[[ "$(control_snapshot "${OBSERVER_CONTAINER}")" == "${observer_control_before}" ]] || \
  die "Unmentioned observer Worker was woken by the handoff path."
printf 'handoff_observer_non_interference=pass\n'
assert_trace_complete "${source_event_id}" specialist_handoff handoff.transport.sent || \
  die "Specialist handoff trace did not complete."
printf '[Tiangong] Specialist-to-Leader exact handoff probe passed.\n'
