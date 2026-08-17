#!/usr/bin/env bash
# P0.2 mention-gating regression + worker-owned Matrix delivery contract.
#
# Proves, against a real requireMention Worker in a bound Team room:
#   1. Dashboard bug class: a message whose formatted_body carries NO matrix.to
#      anchor (only body=@DisplayName + m.mentions) does NOT wake the Worker.
#   2. The standard rich mention (formatted_body matrix.to anchor + m.mentions)
#      DOES wake the Worker (harness turn observed).
#   3. Worker-owned delivery contract: the Matrix event_id is the stable echo and
#      the Matrix transaction id is the send-idempotency key (duplicate PUT with
#      the same txn id returns the same event id; the event is queryable).
#   4. Sender preservation: the Human event keeps the Human sender; a Worker
#      reply carries the Worker sender.
#
# Scope: focused Matrix/OpenClaw transport probe. It does not implement the
# target CoordinationStore, Work admission, or P1 API. The positive "rich mention
# wakes a Worker" fact is also covered by the merged peer-mention and
# Specialist-to-Leader handoff smokes; this run adds the Dashboard negative
# regression and the delivery/replay/sender facts.
#
# jq programs intentionally keep $variables unexpanded inside single quotes.
# shellcheck disable=SC2016
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly TARGET_IMAGE="tiangong-worker-designer:dev"
readonly STOCK_LEADER_IMAGE="higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-copaw-worker:v1.2.0"
readonly TEAM_NAME="tiangong-p0-2-mention"
readonly LEADER_NAME="tiangong-p0-2-mention-leader"
readonly TARGET_NAME="tiangong-p0-2-mention-target"
readonly LEADER_CONTAINER="agentteams-worker-${LEADER_NAME}"
readonly TARGET_CONTAINER="agentteams-worker-${TARGET_NAME}"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly WORKER_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/p0-2-mention-workers.yaml"
readonly TEAM_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/p0-2-mention-team.yaml"
readonly CONTRACT="${REPO_ROOT}/smoke-testing/support/p0-2-mention-contract.mjs"
readonly MANAGER_WORKER_MANIFEST="/tmp/tiangong-p0-2-mention-workers.yaml"
readonly MANAGER_TEAM_MANIFEST="/tmp/tiangong-p0-2-mention-team.yaml"
readonly STATE_DIR="${REPO_ROOT}/.runtime/p0-2-mention"
owned=0
manager_restart_required=0
controller_api_token=''
admin_access_token=''

log() { printf '[Tiangong] %s\n' "$*"; }
die() { printf '[Tiangong] ERROR: %s\n' "$*" >&2; exit 1; }
container_exists() { docker inspect "$1" >/dev/null 2>&1; }
team_json() { docker exec "${MANAGER_CONTAINER}" agt get teams "${TEAM_NAME}" -o json 2>/dev/null; }
member_json() { docker exec "${MANAGER_CONTAINER}" agt get workers "$1" -o json 2>/dev/null; }

harness_snapshot() {
  if ! docker exec "${TARGET_CONTAINER}" test -f /tmp/tiangong-pi-harness.last-run 2>/dev/null; then
    printf 'absent\n'; return
  fi
  docker exec "${TARGET_CONTAINER}" stat -c '%y:%s' /tmp/tiangong-pi-harness.last-run 2>/dev/null || printf 'absent\n'
}

assert_no_turn() {
  local baseline="$1" seconds="${2:-20}" _
  for _ in $(seq 1 "$((seconds * 2))"); do
    sleep 0.5
  done
  [[ "$(harness_snapshot)" == "${baseline}" ]] || die "Dashboard-format mention woke the requireMention Worker (regression failed)."
}

assert_turn() {
  local baseline="$1" _ current
  for _ in $(seq 1 240); do
    current="$(harness_snapshot)"
    [[ "${current}" != "${baseline}" && "${current}" != "absent" ]] && return 0
    sleep 1
  done
  die "Standard rich mention did not wake the requireMention Worker within the bounded window."
}

admin_login() {
  local body response
  body="$(jq -cn --arg user "${ADMIN_USER}" --arg password "${ADMIN_PASSWORD}" \
    '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password}')"
  response="$(printf '%s' "${body}" | curl --fail --silent --show-error --max-time 30 \
    -H 'Content-Type: application/json' --data-binary @- "${HOMESERVER}/_matrix/client/v3/login")"
  admin_access_token="$(jq -r '.access_token // empty' <<<"${response}")"
  [[ -n "${admin_access_token}" ]] || die "Matrix Admin login did not return an access token."
  body=''; response=''
}

admin_curl() {
  printf 'header = "Authorization: Bearer %s"\nheader = "Host: %s"\n' "${admin_access_token}" "${MATRIX_DOMAIN}" | \
    curl --fail --silent --show-error --max-time 30 -K - "$@"
}

send_event() {
  # $1 txn-local $2 body $3 formatted_body $4 mentions-json-array
  local txn="$1" room_path
  room_path="$(printf '%s' "${team_room_id}" | jq -sRr @uri)"
  local body="$2" fb="$3" mentions="$4" request
  request="$(jq -cn --arg body "${body}" --arg fb "${fb}" --argjson mentions "${mentions}" \
    '{msgtype:"m.text",body:$body,format:"org.matrix.custom.html",formatted_body:$fb,"m.mentions":{user_ids:$mentions}}')"
  admin_curl -X PUT -H 'Content-Type: application/json' --data-binary "${request}" \
    "${HOMESERVER}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/${txn}"
}

fetch_event() {
  local event_id="$1" room_path encoded
  room_path="$(printf '%s' "${team_room_id}" | jq -sRr @uri)"
  encoded="$(printf '%s' "${event_id}" | jq -sRr @uri)"
  admin_curl "${HOMESERVER}/_matrix/client/v3/rooms/${room_path}/event/${encoded}"
}

room_messages() {
  local room_path
  room_path="$(printf '%s' "${team_room_id}" | jq -sRr @uri)"
  admin_curl "${HOMESERVER}/_matrix/client/v3/rooms/${room_path}/messages?dir=f&limit=128"
}

cleanup() {
  local status=$? failed=0 team_absent=0 workers_absent=0 member room_id
  trap - EXIT INT TERM
  set +e
  if [[ -n "${admin_access_token}" ]]; then
    printf 'header = "Authorization: Bearer %s"\nheader = "Host: %s"\n' "${admin_access_token}" "${MATRIX_DOMAIN}" | \
      curl --silent --show-error --max-time 15 -K - -X POST "${HOMESERVER}/_matrix/client/v3/logout" >/dev/null 2>&1 || failed=1
    admin_access_token=''
  fi
  docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_WORKER_MANIFEST}" "${MANAGER_TEAM_MANIFEST}" >/dev/null 2>&1 || true

  if ((owned == 1)); then
    controller_api_token="$(docker exec "${MANAGER_CONTAINER}" printenv AGENTTEAMS_AUTH_TOKEN 2>/dev/null || true)"
    [[ -n "${controller_api_token}" ]] || failed=1
    for member in "${LEADER_NAME}" "${TARGET_NAME}"; do
      room_id="$(jq -r '.roomID // empty' <<<"$(member_json "${member}" 2>/dev/null || true)")"
      [[ -z "${room_id}" ]] || leave_manager "${room_id}" || failed=1
    done
    delete_team || failed=1
    for _ in $(seq 1 360); do [[ "$(team_status)" == 404 ]] && { team_absent=1; break; }; sleep 1; done
    ((team_absent == 1)) || failed=1
    if ((manager_restart_required == 1)); then
      docker start "${MANAGER_CONTAINER}" >/dev/null 2>&1 || failed=1
      for _ in $(seq 1 60); do docker exec "${MANAGER_CONTAINER}" agt get workers -o json >/dev/null 2>&1 && break; sleep 2; done
    fi
    for member in "${LEADER_NAME}" "${TARGET_NAME}"; do
      docker exec "${MANAGER_CONTAINER}" agt delete worker "${member}" >/dev/null 2>&1 || failed=1
    done
    for _ in $(seq 1 240); do
      if ! member_json "${LEADER_NAME}" >/dev/null 2>&1 && ! member_json "${TARGET_NAME}" >/dev/null 2>&1 && \
         ! container_exists "${LEADER_CONTAINER}" && ! container_exists "${TARGET_CONTAINER}"; then workers_absent=1; break; fi
      sleep 1
    done
    ((workers_absent == 1)) || failed=1
    purge_storage || failed=1
    storage_absent || failed=1
    delete_aliases || failed=1
  fi

  docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_WORKER_MANIFEST}" 2>/dev/null || failed=1
  docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_TEAM_MANIFEST}" 2>/dev/null || failed=1
  rm -rf -- "${STATE_DIR}" 2>/dev/null || true
  ((failed == 0 && status == 0)) || { log "P0.2 cleanup retained a sanitized failure state under ${STATE_DIR}."; status=1; }
  exit "${status}"
}

leave_manager() {
  local room_id="$1"
  [[ -n "${room_id}" ]] || return 0
  docker exec -i "${CONTROLLER_CONTAINER}" sh -s -- "${room_id}" <<'SH'
set -eu
room_id="$1"
config=/root/agentteams-fs/agents/manager/openclaw.json
homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${config}")"
access_token="$(jq -r '.channels.matrix.accessToken // empty' "${config}")"
[ -n "${homeserver}" ] && [ -n "${access_token}" ]
room_path="$(printf '%s' "${room_id}" | jq -sRr @uri)"
status="$(printf 'header = "Authorization: Bearer %s"\n' "${access_token}" | \
  curl --config - --silent --show-error --max-time 30 --request POST \
  --output /dev/null --write-out '%{http_code}' \
  "${homeserver%/}/_matrix/client/v3/rooms/${room_path}/leave")"
[ "${status}" = 200 ] || [ "${status}" = 403 ]
SH
}

team_status() {
  printf 'header = "Authorization: Bearer %s"\n' "${controller_api_token}" | \
    docker exec -i "${CONTROLLER_CONTAINER}" curl --config - --silent --show-error --max-time 10 \
    --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:8090/api/v1/teams/${TEAM_NAME}" 2>/dev/null || true
}

delete_team() {
  local status
  status="$(printf 'header = "Authorization: Bearer %s"\n' "${controller_api_token}" | \
    docker exec -i "${CONTROLLER_CONTAINER}" curl --config - --silent --show-error --max-time 10 \
    --request DELETE --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:8090/api/v1/teams/${TEAM_NAME}" 2>/dev/null || true)"
  [[ "${status}" == 204 || "${status}" == 404 ]]
}

remote_has_objects() {
  docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive "agentteams/agentteams-storage/$1/" 2>/dev/null | grep -q .
}

storage_absent() {
  local prefix mirror
  for prefix in "agents/${LEADER_NAME}" "agents/${TARGET_NAME}" "teams/${TEAM_NAME}"; do
    ! remote_has_objects "${prefix}" || return 1
  done
  for mirror in "/root/agentteams-fs/agents/${LEADER_NAME}" "/root/agentteams-fs/agents/${TARGET_NAME}" "/root/agentteams-fs/teams/${TEAM_NAME}"; do
    ! docker exec "${CONTROLLER_CONTAINER}" test -e "${mirror}" 2>/dev/null || return 1
    ! docker exec "${MANAGER_CONTAINER}" test -e "${mirror}" 2>/dev/null || return 1
  done
}

purge_storage() {
  local prefix mirror
  for prefix in "agents/${LEADER_NAME}" "agents/${TARGET_NAME}" "teams/${TEAM_NAME}"; do
    docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force "agentteams/agentteams-storage/${prefix}/" >/dev/null 2>&1 || true
  done
  for mirror in "/root/agentteams-fs/agents/${LEADER_NAME}" "/root/agentteams-fs/agents/${TARGET_NAME}" "/root/agentteams-fs/teams/${TEAM_NAME}"; do
    docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "${mirror}" >/dev/null 2>&1 || true
    docker exec "${MANAGER_CONTAINER}" rm -rf -- "${mirror}" >/dev/null 2>&1 || true
  done
}

delete_aliases() {
  local alias encoded status
  for alias in "#agentteams-team-${TEAM_NAME}:${MATRIX_DOMAIN}" "#agentteams-leader-dm-${LEADER_NAME}:${MATRIX_DOMAIN}"; do
    encoded="$(printf '%s' "${alias}" | jq -sRr @uri)"
    status="$(printf 'header = "Authorization: Bearer %s"\nheader = "Host: %s"\n' "${admin_access_token}" "${MATRIX_DOMAIN}" | \
      curl --config - --silent --show-error --max-time 15 --request DELETE --output /dev/null --write-out '%{http_code}' \
      "${HOMESERVER}/_matrix/client/v3/directory/room/${encoded}" 2>/dev/null || true)"
    [[ "${status}" == 200 || "${status}" == 404 || -z "${admin_access_token}" ]] || return 1
  done
}

mkdir -m 700 -- "${STATE_DIR}" 2>/dev/null || true
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in docker curl jq node; do command -v "${command}" >/dev/null 2>&1 || die "Required command missing: ${command}"; done
for path in "${WORKER_MANIFEST}" "${TEAM_MANIFEST}" "${CONTRACT}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || die "Required asset missing or symlinked: ${path}"
done
docker info >/dev/null 2>&1 || die "Docker daemon is unavailable."
cd "${REPO_ROOT}"
for c in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}"; do
  container_exists "${c}" || die "Required AgentTeams container absent: ${c}"
  [[ "$(docker inspect "${c}" --format '{{.State.Running}}')" == true ]] || die "Required AgentTeams container not running: ${c}"
done
docker image inspect "${TARGET_IMAGE}" >/dev/null 2>&1 || die "Required Tiangong Worker image absent: ${TARGET_IMAGE}"
docker image inspect "${STOCK_LEADER_IMAGE}" >/dev/null 2>&1 || die "Required stock Leader image absent."
if member_json "${LEADER_NAME}" >/dev/null 2>&1 || member_json "${TARGET_NAME}" >/dev/null 2>&1 || \
   team_json >/dev/null 2>&1 || container_exists "${LEADER_CONTAINER}" || container_exists "${TARGET_CONTAINER}"; then
  die "Reserved P0.2 Worker/Team already exists; refusing to adopt it."
fi

[[ -n "${AGENTTEAMS_MATRIX_URL:-}" && -n "${AGENTTEAMS_MATRIX_DOMAIN:-}" && \
   -n "${AGENTTEAMS_ADMIN_USER:-}" && -n "${AGENTTEAMS_ADMIN_PASSWORD:-}" ]] || \
  die "Matrix Admin environment is incomplete (AGENTTEAMS_MATRIX_URL/DOMAIN/ADMIN_USER/PASSWORD)."
HOMESERVER="${AGENTTEAMS_MATRIX_URL%/}"
MATRIX_DOMAIN="${AGENTTEAMS_MATRIX_DOMAIN}"
ADMIN_USER="${AGENTTEAMS_ADMIN_USER}"
ADMIN_PASSWORD="${AGENTTEAMS_ADMIN_PASSWORD}"
admin_user_id="@${ADMIN_USER}:${MATRIX_DOMAIN}"
nonce="$(date -u +%s)-$$"

# Provision the disposable Team (stock Leader + one Tiangong requireMention Worker).
docker cp "${WORKER_MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_WORKER_MANIFEST}"
docker cp "${TEAM_MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_TEAM_MANIFEST}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_WORKER_MANIFEST}" >/dev/null
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_TEAM_MANIFEST}" >/dev/null
owned=1
for _ in $(seq 1 240); do
  leader_resource="$(member_json "${LEADER_NAME}" || true)"
  target_resource="$(member_json "${TARGET_NAME}" || true)"
  if jq -e '.phase=="Running" and (.matrixUserID|type=="string"and startswith("@")) and (.roomID|type=="string"and startswith("!"))' <<<"${leader_resource}" >/dev/null 2>&1 && \
     jq -e '.phase=="Running" and (.matrixUserID|type=="string"and startswith("@")) and (.roomID|type=="string"and startswith("!"))' <<<"${target_resource}" >/dev/null 2>&1 && \
     container_exists "${LEADER_CONTAINER}" && container_exists "${TARGET_CONTAINER}" && \
     [[ "$(docker inspect "${LEADER_CONTAINER}" --format '{{.State.Running}}')" == true && \
        "$(docker inspect "${TARGET_CONTAINER}" --format '{{.State.Running}}')" == true ]]; then break; fi
  sleep 2
done
jq -e '.phase=="Running" and (.matrixUserID|type=="string"and startswith("@"))' <<<"${leader_resource}" >/dev/null || die "Disposable Leader did not become ready."
jq -e '.phase=="Running" and (.matrixUserID|type=="string"and startswith("@"))' <<<"${target_resource}" >/dev/null || die "Disposable Target Worker did not become ready."
leader_user_id="$(jq -r '.matrixUserID' <<<"${leader_resource}")"
target_user_id="$(jq -r '.matrixUserID' <<<"${target_resource}")"
for _ in $(seq 1 240); do
  team_resource="$(team_json || true)"
  jq -e --arg t "${TEAM_NAME}" '.phase=="Active" and .leaderReady==true and .readyWorkers==1 and .teamRoomID|type=="string"and startswith("!")' <<<"${team_resource}" >/dev/null 2>&1 && break
  sleep 2
done
team_room_id="$(jq -r '.teamRoomID // empty' <<<"${team_resource}")"
[[ "${team_room_id}" =~ ^! ]] || die "Disposable Team did not become Active with a bound team room."
# Wait for the Target Worker to have joined the team room and reported ready.
for _ in $(seq 1 90); do
  logs="$(docker logs "${TARGET_CONTAINER}" 2>&1 || true)"
  if grep -Fq "[matrix] joined room ${team_room_id}" <<<"${logs}" && \
     grep -Fq "worker/${TARGET_NAME} reported ready" <<<"${logs}"; then break; fi
  sleep 2
done
logs="$(docker logs "${TARGET_CONTAINER}" 2>&1 || true)"
grep -Fq "[matrix] joined room ${team_room_id}" <<<"${logs}" || die "Target Worker did not join the team room."
# Assert the Target Worker retains requireMention in the team room.
target_config="/root/agentteams-fs/agents/${TARGET_NAME}/openclaw.json"
for _ in $(seq 1 30); do
  docker exec "${TARGET_CONTAINER}" jq -e --arg t "${target_user_id}" --arg l "${leader_user_id}" --arg a "${admin_user_id}" '
    (.channels.matrix.groupAllowFrom|index($t))!=null and (.channels.matrix.groupAllowFrom|index($l))!=null and
    (.channels.matrix.groupAllowFrom|index($a))!=null and .channels.matrix.groups["*"].requireMention==true' "${target_config}" >/dev/null 2>&1 && break
  sleep 2
done
docker exec "${TARGET_CONTAINER}" jq -e '.channels.matrix.groups["*"].requireMention==true' "${target_config}" >/dev/null || \
  die "Target Worker did not retain requireMention:true in the team room."
admin_login

target_before="$(harness_snapshot)"
log "Baseline target harness snapshot: ${target_before}"

# (1) NEGATIVE: Dashboard-format mention must NOT wake the Worker.
dash_body="@Tiangong P0.2 Target Worker dashboard-mention nonce=${nonce}"
dash_event_id="$(send_event "tiangong-p02-dash-${nonce}" "${dash_body}" "${dash_body}" "$(jq -cn --arg t "${target_user_id}" '[$t]')" | jq -r '.event_id // empty')"
[[ "${dash_event_id}" =~ ^\$ ]] || die "Dashboard-format send did not return a Matrix event id."
assert_no_turn "${target_before}" 25
printf 'p0_2_dashboard_mention_no_turn=pass\n'
dash_event_json="$(fetch_event "${dash_event_id}")"
[[ "$(jq -r '.sender' <<<"${dash_event_json}")" == "${admin_user_id}" ]] || die "Dashboard event did not preserve the Human sender."

# (2) POSITIVE + (3) delivery/replay: standard rich mention DOES wake the Worker;
# the event id is the stable echo; the txn id is the send-idempotency key.
rich_body="${target_user_id} Please reply with the single token P02_ACK nonce=${nonce}"
rich_fb="<a href=\"https://matrix.to/#/${target_user_id}\">${target_user_id}</a> Please reply with the single token P02_ACK nonce=${nonce}"
rich_event_id="$(send_event "tiangong-p02-rich-${nonce}" "${rich_body}" "${rich_fb}" "$(jq -cn --arg t "${target_user_id}" '[$t]')" | jq -r '.event_id // empty')"
[[ "${rich_event_id}" =~ ^\$ ]] || die "Rich-mention send did not return a Matrix event id."
# Replay the SAME txn id; Matrix must dedup to the same event id.
replay_event_id="$(send_event "tiangong-p02-rich-${nonce}" "${rich_body}" "${rich_fb}" "$(jq -cn --arg t "${target_user_id}" '[$t]')" | jq -r '.event_id // empty')"
[[ "${replay_event_id}" == "${rich_event_id}" ]] || die "Duplicate Matrix transaction id produced a second event id."
printf 'p0_2_replay_same_event_id=pass\n'
rich_event_json="$(fetch_event "${rich_event_id}")"
[[ "$(jq -r '.sender' <<<"${rich_event_json}")" == "${admin_user_id}" ]] || die "Rich-mention event did not preserve the Human sender."
# The Worker turns on the rich mention (positive gating fact).
assert_turn "${target_before}" 240
printf 'p0_2_rich_mention_wakes_worker=pass\n'

# (4) Worker reply echo + sender preservation. Wait for a Worker-originated
# m.room.message in the room after the rich mention; its event id is the stable
# delivery echo and its sender must be the Worker, not the Human.
reply_event_id=""
for _ in $(seq 1 120); do
  reply_event_id="$(room_messages | jq -r --arg after "${rich_event_id}" --arg worker "${target_user_id}" --arg admin "${admin_user_id}" '
      [.chunk[]? | select(.type=="m.room.message" and .sender==$worker and .sender!=$admin)]
      | sort_by(.origin_server_ts) | .[-1].event_id // empty')" || true
  [[ -n "${reply_event_id}" ]] && break
  sleep 1
done
if [[ -n "${reply_event_id}" ]]; then
  reply_json="$(fetch_event "${reply_event_id}")"
  [[ "$(jq -r '.sender' <<<"${reply_json}")" == "${target_user_id}" ]] || die "Worker reply did not carry the Worker sender (impersonation risk)."
  printf 'p0_2_worker_reply_echo_sender_preserved=pass\n'
  printf 'p0_2_worker_reply_event_id=%s\n' "${reply_event_id}"
else
  die "No Worker-originated reply observed; cannot prove the ordinary-reply delivery echo."
fi

# Validate the mention wire-format boundary and replay contract deterministically.
TARGET_USER_ID="${target_user_id}" DASH_EVENT="${dash_event_json}" RICH_EVENT="${rich_event_json}" \
REPLAY_EVENT_ID="${replay_event_id}" RICH_EVENT_ID="${rich_event_id}" ADMIN_USER_ID="${admin_user_id}" \
node --input-type=module - <<'NODE'
import { assertMentionGateBoundary, assertReplayContract, assertSenderPreserved } from "./smoke-testing/support/p0-2-mention-contract.mjs";
const worker = process.env.TARGET_USER_ID;
const dash = JSON.parse(process.env.DASH_EVENT);
const rich = JSON.parse(process.env.RICH_EVENT);
assertMentionGateBoundary(dash, rich, worker);
assertReplayContract(process.env.RICH_EVENT_ID, process.env.REPLAY_EVENT_ID);
assertSenderPreserved(dash, process.env.ADMIN_USER_ID);
console.log("p0_2_wire_format_and_delivery_contract=pass");
NODE

printf 'p0_2_mention_delivery_facts={dashboard_no_turn:true,rich_wakes_worker:true,replay_same_event_id:%s,worker_reply_sender_preserved:true,human_sender_preserved:true}\n' \
  "${replay_event_id}"
log "P0.2 mention-gating and delivery probe facts recorded; cleaning up owned resources."
