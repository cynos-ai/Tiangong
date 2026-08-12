#!/usr/bin/env bash
# jq programs intentionally keep $variables unexpanded inside single quotes.
# shellcheck disable=SC2016
#
# P0.4 identity / PostgreSQL / network probe driver.
#
# Disposable, dependency-free proof of the app + PostgreSQL + Matrix identity
# boundary on the pinned local AgentTeams stack. Creates only owned resources,
# asserts observable facts, revokes/destroys exactly what it created, and keeps
# the run red if cleanup cannot be proven.
#
# Scope: probe scaffold. It proves Human/Worker current Matrix identity (whoami)
# as the only read-authorization mechanism, HttpOnly app session + CSRF, a fresh
# user-bound step-up for dangerous actions, SSE revocation, PostgreSQL race and
# uniqueness facts, credential containment, and exact cleanup. It does NOT
# implement the Tiangong Web product, CoordinationStore, Work admission, Team
# route/MemberConfig binding (a P1 target), or P1 API.
set -Eeuo pipefail
umask 077


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly FIXTURE_ROOT="${REPO_ROOT}/smoke-testing/fixtures/p0-identity-pg"
readonly WORKER_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/p0-identity-pg-workers.yaml"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly WORKER_NAME="tiangong-p0-4-identity-worker"
readonly WORKER_CONTAINER="agentteams-worker-${WORKER_NAME}"
readonly POSTGRES_IMAGE="postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID
readonly STATE_DIR="${REPO_ROOT}/.runtime/p0-identity-pg/${RUN_ID}"
readonly APP_CONTAINER="tiangong-p0-4-app-${RUN_ID}"
readonly DB_CONTAINER="tiangong-p0-4-postgres-${RUN_ID}"
readonly DB_ALIAS="p0-4-postgres"
readonly APP_IMAGE="tiangong-p0-4-app:${RUN_ID}"
readonly COOKIE_JAR="${STATE_DIR}/cookies.txt"
readonly SSE_FILE="${STATE_DIR}/events.sse"
readonly MANAGER_WORKER_MANIFEST="/tmp/tiangong-p0-4-identity-workers.yaml"

owned_worker=0
owned_app=0
owned_db=0
manager_restart_required=0
cleanup_allowed=1
sse_pid=""
admin_token=""
appservice_token=""
human_token=""
worker_token=""
human_created=0
human_deactivated=0
admin_password=""
db_password=""
human_password=""
probe_key=""
MATRIX_DOMAIN=""
MATRIX_GATEWAY_PORT=""
MATRIX_ORIGIN=""
MATRIX_HOST=""
ADMIN_USER=""
APP_PORT=""
WORKER_RESOURCE=""
WORKER_USER_ID=""
WORKER_ROOM_ID=""
LAST_STATUS=""
LAST_BODY=""
LAST_HEADERS=""

log() { printf '[Tiangong] %s\n' "$*"; }
die() { printf '[Tiangong] ERROR: %s\n' "$*" >&2; exit 1; }
container_exists() { docker inspect "$1" >/dev/null 2>&1; }
worker_resource() { docker exec "${MANAGER_CONTAINER}" agt get workers "${WORKER_NAME}" -o json 2>/dev/null; }

read_generated_value() {
  local key="$1" file="${REPO_ROOT}/.runtime/agentteams/manager.env"
  [[ -f "${file}" && ! -L "${file}" ]] || die "Missing generated AgentTeams environment file."
  awk -F= -v key="${key}" '$1 == key {sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit}' "${file}"
}

json_body() {
  jq -cn "$@" || die "Could not construct JSON request body."
}

# Tokens are passed to curl only via a transient stdin config, never on the
# command line or in a persisted file. The response body is captured to a
# bounded temp file and discarded after each call.
matrix_call() {
  local token="$1" method="$2" path="$3" body="${4:-}" response_file
  response_file="$(mktemp "${STATE_DIR}/matrix-response.XXXXXX")"
  LAST_HEADERS="$(mktemp "${STATE_DIR}/matrix-headers.XXXXXX")"
  LAST_STATUS="$(
    {
      printf 'header = "Host: %s"\n' "${MATRIX_HOST}"
      [[ -n "${token}" ]] && printf 'header = "Authorization: Bearer %s"\n' "${token}"
    } | curl --config - --silent --show-error --max-time 30 \
      --request "${method}" ${body:+--header 'Content-Type: application/json' --data-binary "${body}"} \
      --dump-header "${LAST_HEADERS}" --output "${response_file}" --write-out '%{http_code}' \
      "${MATRIX_ORIGIN}${path}" || true
  )"
  LAST_BODY="$(<"${response_file}")"
  rm -f -- "${response_file}"
}

app_call() {
  local token="$1" method="$2" path="$3" body="${4:-}" csrf="${5:-}" response_file
  response_file="$(mktemp "${STATE_DIR}/app-response.XXXXXX")"
  LAST_HEADERS="$(mktemp "${STATE_DIR}/app-headers.XXXXXX")"
  # Cookies travel only in curl's cookie jar, never in the URL or the bearer
  # config. Pass both flags unconditionally so the first set-cookie is captured.
  local cookie_args=(--cookie "${COOKIE_JAR}" --cookie-jar "${COOKIE_JAR}")
  LAST_STATUS="$(
    {
      printf 'header = "x-probe-key: %s"\n' "${probe_key}"
      [[ -n "${token}" ]] && printf 'header = "Authorization: Bearer %s"\n' "${token}"
      [[ -n "${csrf}" ]] && printf 'header = "x-csrf-token: %s"\n' "${csrf}"
    } | curl --config - --silent --show-error --max-time 30 \
      "${cookie_args[@]}" --request "${method}" ${body:+--header 'Content-Type: application/json' --data-binary "${body}"} \
      --dump-header "${LAST_HEADERS}" --output "${response_file}" --write-out '%{http_code}' \
      "http://127.0.0.1:${APP_PORT}${path}" || true
  )"
  LAST_BODY="$(<"${response_file}")"
  rm -f -- "${response_file}"
}

assert_status() {
  [[ "${LAST_STATUS}" == "$1" ]] || die "Expected HTTP $1, observed HTTP ${LAST_STATUS}; error body intentionally not printed."
}

assert_json_field() {
  # Stringify the expression result so a JSON number (e.g. max_staleness_ms:0)
  # compares equal to its expected text form without jq type rejection.
  jq -e --arg expected "$2" "($1 | tostring) == \$expected" >/dev/null <<<"${LAST_BODY}" || \
    die "JSON response did not satisfy the expected bounded fact."
}

leave_manager_from_worker_room() {
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

remote_prefix_has_objects() {
  docker exec "${CONTROLLER_CONTAINER}" mc ls --recursive \
    "agentteams/agentteams-storage/$1/" 2>/dev/null | grep -q .
}

reserved_storage_absent() {
  ! remote_prefix_has_objects "agents/${WORKER_NAME}" || return 1
  ! docker exec "${CONTROLLER_CONTAINER}" test -e "/root/agentteams-fs/agents/${WORKER_NAME}" || return 1
  ! docker exec "${MANAGER_CONTAINER}" test -e "/root/agentteams-fs/agents/${WORKER_NAME}" || return 1
}

purge_reserved_storage() {
  docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
    "agentteams/agentteams-storage/agents/${WORKER_NAME}/" >/dev/null 2>&1 || true
  docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "/root/agentteams-fs/agents/${WORKER_NAME}" >/dev/null 2>&1 || true
  docker exec "${MANAGER_CONTAINER}" rm -rf -- "/root/agentteams-fs/agents/${WORKER_NAME}" >/dev/null 2>&1 || true
}

wait_for_worker_absent() {
  local _
  for _ in $(seq 1 240); do
    if ! worker_resource >/dev/null 2>&1 && ! container_exists "${WORKER_CONTAINER}"; then return 0; fi
    sleep 1
  done
  return 1
}

assert_no_secret_in_text() {
  local text="$1" secret
  for secret in "${admin_token}" "${appservice_token}" "${human_token}" "${worker_token}" "${admin_password}" "${db_password}" "${human_password}" "${probe_key}"; do
    [[ -z "${secret}" ]] || ! grep -Fq -- "${secret}" <<<"${text}" || {
      cleanup_allowed=0
      die "Credential appeared in an observable app/database log; preserving owned resources for audit."
    }
  done
  ! grep -Eiq 'Bearer[[:space:]]+[A-Za-z0-9._~-]{16,512}|access_token[[:space:]]*[:=]|password[[:space:]]*[:=]' <<<"${text}" || {
    cleanup_allowed=0
    die "Credential-shaped text appeared in an observable log; preserving owned resources for audit."
  }
}

cleanup() {
  local final=$? failed=0 worker_room="" worker_absent=0
  trap - EXIT INT TERM
  set +e

  if [[ -n "${sse_pid}" ]]; then
    kill "${sse_pid}" >/dev/null 2>&1 || true
    wait "${sse_pid}" >/dev/null 2>&1 || true
  fi

  if ((cleanup_allowed == 1)); then
    if ((human_created == 1)) && [[ -n "${admin_token}" ]] && [[ -n "${WORKER_ROOM_ID+x}" ]]; then
      if [[ -n "${human_token}" ]]; then
        matrix_call "${human_token}" POST "/_matrix/client/v3/logout"
        human_token=""
      fi
      matrix_call "${admin_token}" PUT "/_matrix/client/v3/rooms/${ADMIN_ROOM_PATH}/send/m.room.message/p0-4-cleanup-${RUN_ID}" \
        "$(json_body --arg command "!admin users deactivate ${HUMAN_USER_ID_FOR_CLEANUP:-${HUMAN_USER_ID:-}}" '{msgtype:"m.text",body:$command}')"
      if [[ "${LAST_STATUS}" == 200 || "${LAST_STATUS}" == 201 ]]; then
        local _ logout_tok
        for _ in $(seq 1 40); do
          matrix_call "" POST "/_matrix/client/v3/login" \
            "$(json_body --arg user "${HUMAN_LOCALPART:-}" --arg password "${HUMAN_PASSWORD:-x}" '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password}')"
          if [[ "${LAST_STATUS}" == 401 || "${LAST_STATUS}" == 403 ]]; then human_deactivated=1; break; fi
          if [[ "${LAST_STATUS}" == 200 ]]; then
            logout_tok="$(jq -r '.access_token // empty' <<<"${LAST_BODY}" 2>/dev/null || true)"
            [[ "${logout_tok}" =~ ^[A-Za-z0-9._~-]{16,512}$ ]] && matrix_call "${logout_tok}" POST "/_matrix/client/v3/logout"
          fi
          sleep 0.5
        done
      fi
    fi
    ((human_deactivated == 1)) || { [[ "${human_created}" == 0 ]] && human_deactivated=1; }

    if ((owned_app == 1)) && container_exists "${APP_CONTAINER}"; then
      docker logs "${APP_CONTAINER}" >"${STATE_DIR}/app-container.log" 2>&1 || true
      docker rm --force "${APP_CONTAINER}" >/dev/null 2>&1 || failed=1
    fi
    if ((owned_db == 1)) && container_exists "${DB_CONTAINER}"; then
      docker logs "${DB_CONTAINER}" >"${STATE_DIR}/db-container.log" 2>&1 || true
      docker rm --force "${DB_CONTAINER}" >/dev/null 2>&1 || failed=1
    fi
    ! container_exists "${APP_CONTAINER}" || failed=1
    ! container_exists "${DB_CONTAINER}" || failed=1
    docker image rm "${APP_IMAGE}" >/dev/null 2>&1 || true
    docker image inspect "${APP_IMAGE}" >/dev/null 2>&1 && failed=1

    if ((owned_worker == 1)); then
      worker_room="$(jq -r '.roomID // empty' <<<"${WORKER_RESOURCE:-}" 2>/dev/null || true)"
      if [[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
        docker stop "${MANAGER_CONTAINER}" >/dev/null 2>&1 || failed=1
        manager_restart_required=1
      fi
      [[ -z "${worker_room}" ]] || leave_manager_from_worker_room "${worker_room}" || failed=1
      if ((manager_restart_required == 1)); then
        docker start "${MANAGER_CONTAINER}" >/dev/null 2>&1 || failed=1
        local _
        for _ in $(seq 1 60); do
          docker exec "${MANAGER_CONTAINER}" agt get workers -o json >/dev/null 2>&1 && break
          sleep 2
        done
      fi
      docker exec "${MANAGER_CONTAINER}" agt delete worker "${WORKER_NAME}" >/dev/null 2>&1 || failed=1
      if wait_for_worker_absent; then worker_absent=1; else failed=1; fi
      purge_reserved_storage
      ((worker_absent == 1)) || failed=1
      reserved_storage_absent || failed=1
    fi
    docker exec "${MANAGER_CONTAINER}" rm -f "${MANAGER_WORKER_MANIFEST}" >/dev/null 2>&1 || failed=1

    if [[ -n "${admin_token}" ]]; then
      matrix_call "${admin_token}" POST "/_matrix/client/v3/logout"
      [[ "${LAST_STATUS}" == 200 || "${LAST_STATUS}" == 401 || "${LAST_STATUS}" == 403 ]] || failed=1
      admin_token=""
    fi
    docker exec "${MANAGER_CONTAINER}" test ! -e "${MANAGER_WORKER_MANIFEST}" || failed=1
  else
    log "Cleanup is intentionally withheld; inspect owned state under ${STATE_DIR}."
    failed=1
  fi

  if ((failed == 0 && final == 0)); then
    rm -rf -- "${STATE_DIR}"
    [[ ! -e "${STATE_DIR}" ]] || final=1
    rmdir -- "${REPO_ROOT}/.runtime/p0-identity-pg" >/dev/null 2>&1 || true
  else
    log "Sanitized failure state retained at ${STATE_DIR}."
    final=1
  fi
  admin_token=''; appservice_token=''; human_token=''; worker_token=''
  admin_password=''; db_password=''; human_password=''; probe_key=''
  exit "${final}"
}

mkdir -p -- "${REPO_ROOT}/.runtime/p0-identity-pg"
[[ ! -e "${STATE_DIR}" ]] || die "Probe state already exists: ${STATE_DIR}"
mkdir -m 700 -- "${STATE_DIR}"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in docker curl jq openssl grep awk node npm; do
  command -v "${command}" >/dev/null 2>&1 || die "Required command missing: ${command}"
done
for path in "${FIXTURE_ROOT}/Dockerfile" "${FIXTURE_ROOT}/.dockerignore" \
  "${FIXTURE_ROOT}/app/package.json" "${FIXTURE_ROOT}/app/package-lock.json" \
  "${FIXTURE_ROOT}/app/server.mjs" "${WORKER_MANIFEST}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || die "Required probe asset missing or symlinked: ${path}"
done
docker info >/dev/null 2>&1 || die "Docker daemon is unavailable."
# Node ESM imports resolve relative to the repo root; the support contract
# module is a test-only driver, not a public runtime API.
cd "${REPO_ROOT}"
for container in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}"; do
  container_exists "${container}" || die "Required AgentTeams container is absent: ${container}"
  [[ "$(docker inspect "${container}" --format '{{.State.Running}}')" == true ]] || die "Required AgentTeams container is not running: ${container}"
done
docker network inspect agentteams-net >/dev/null 2>&1 || die "AgentTeams network is absent."
docker image inspect tiangong-worker-designer:dev >/dev/null 2>&1 || die "Required public Tiangong Worker image is absent."
if worker_resource >/dev/null 2>&1 || container_exists "${WORKER_CONTAINER}"; then
  die "Reserved P0.4 Worker already exists; refusing to adopt it."
fi

MATRIX_DOMAIN="$(read_generated_value AGENTTEAMS_MATRIX_DOMAIN)"
MATRIX_GATEWAY_PORT="$(read_generated_value AGENTTEAMS_PORT_GATEWAY)"
ADMIN_USER="$(read_generated_value AGENTTEAMS_ADMIN_USER)"
admin_password="$(read_generated_value AGENTTEAMS_ADMIN_PASSWORD)"
appservice_token="$(read_generated_value AGENTTEAMS_MATRIX_APPSERVICE_AS_TOKEN)"
[[ "${MATRIX_DOMAIN}" =~ ^[^[:space:]/]{1,255}$ && "${MATRIX_GATEWAY_PORT}" =~ ^[0-9]+$ ]] || die "Generated Matrix configuration is invalid."
[[ "${admin_password}" =~ ^.+$ && "${appservice_token}" =~ ^[A-Za-z0-9._~-]{16,512}$ ]] || die "Generated Matrix credentials are unavailable."
MATRIX_ORIGIN="http://127.0.0.1:${MATRIX_GATEWAY_PORT}"
MATRIX_HOST="${MATRIX_DOMAIN}"
probe_key="$(openssl rand -hex 32)"
db_password="$(openssl rand -hex 32)"
HUMAN_SUFFIX="$(printf '%s' "${RUN_ID}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
HUMAN_LOCALPART="p0-human-${HUMAN_SUFFIX}"
HUMAN_USER_ID="@${HUMAN_LOCALPART}:${MATRIX_DOMAIN}"
HUMAN_USER_ID_FOR_CLEANUP="${HUMAN_USER_ID}"
HUMAN_PASSWORD="$(openssl rand -hex 24)"
ADMIN_ROOM_PATH=""

# Build the isolated Fastify/Vite app image from public, lockfile-pinned assets.
# npm audit must query the public npm registry; the mirror does not implement
# the audit endpoint. The image build registry is overridable for local
# bandwidth-constrained environments but defaults to the public registry.
NPM_REGISTRY="${TIANGONG_NPM_REGISTRY:-https://registry.npmjs.org/}"
npm audit --prefix "${FIXTURE_ROOT}/app" --omit=dev --ignore-scripts --no-fund \
  --registry=https://registry.npmjs.org/ --json >"${STATE_DIR}/npm-audit.json" 2>/dev/null || die "Public runtime dependency audit failed."
jq -e '.metadata.vulnerabilities.total == 0' "${STATE_DIR}/npm-audit.json" >/dev/null || die "Public runtime dependency audit reported vulnerabilities."
docker build --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" --tag "${APP_IMAGE}" "${FIXTURE_ROOT}" >"${STATE_DIR}/app-build.log" 2>&1 || die "P0.4 app image build failed; inspect retained state."

# Provision the disposable Worker. A standalone Worker receives its current
# AgentTeams/Matrix identity (matrixUserID, roomID, token) from provisioning;
# Team route / MemberConfig binding is a P1 target and is not claimed here.
docker cp "${WORKER_MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_WORKER_MANIFEST}"
docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANAGER_WORKER_MANIFEST}" >/dev/null
owned_worker=1
for _ in $(seq 1 240); do
  WORKER_RESOURCE="$(worker_resource || true)"
  if jq -e '
    .phase == "Running" and
    (.matrixUserID | type == "string" and startswith("@")) and
    (.roomID | type == "string" and startswith("!"))' <<<"${WORKER_RESOURCE}" >/dev/null 2>&1 && \
    container_exists "${WORKER_CONTAINER}" && \
    [[ "$(docker inspect "${WORKER_CONTAINER}" --format '{{.State.Running}}')" == true ]]; then break; fi
  sleep 2
done
jq -e '
  .phase == "Running" and
  (.matrixUserID | type == "string" and startswith("@")) and
  (.roomID | type == "string" and startswith("!"))' <<<"${WORKER_RESOURCE}" >/dev/null || die "Disposable Worker did not become ready."
WORKER_USER_ID="$(jq -r '.matrixUserID' <<<"${WORKER_RESOURCE}")"
WORKER_ROOM_ID="$(jq -r '.roomID' <<<"${WORKER_RESOURCE}")"
worker_token="$(docker exec "${WORKER_CONTAINER}" printenv AGENTTEAMS_WORKER_MATRIX_TOKEN 2>/dev/null || true)"
[[ "${worker_token}" =~ ^[A-Za-z0-9._~-]{16,512}$ ]] || die "Worker Matrix token was not available inside the Worker boundary."

# Resolve the authoritative admin room using a disposable admin session.
ADMIN_LOGIN_BODY="$(json_body --arg user "${ADMIN_USER}" --arg password "${admin_password}" \
  '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password}')"
matrix_call "" POST "/_matrix/client/v3/login" "${ADMIN_LOGIN_BODY}"
assert_status 200
admin_token="$(jq -r '.access_token // empty' <<<"${LAST_BODY}")"
[[ "${admin_token}" =~ ^[A-Za-z0-9._~-]{16,512}$ ]] || die "Admin Matrix login did not return a valid token."
ADMIN_LOGIN_BODY=''
matrix_call "${admin_token}" GET "/_matrix/client/v3/directory/room/$(printf '%s' "#admins:${MATRIX_DOMAIN}" | jq -sRr @uri)"
assert_status 200
ADMIN_ROOM_ID="$(jq -r '.room_id // empty' <<<"${LAST_BODY}")"
[[ "${ADMIN_ROOM_ID}" =~ ^![^[:space:]]+$ ]] || die "Authoritative admin room was not resolved."
ADMIN_ROOM_PATH="$(printf '%s' "${ADMIN_ROOM_ID}" | jq -sRr @uri)"

# Register a disposable Matrix Human identity via the pinned local appservice.
matrix_call "${appservice_token}" POST "/_matrix/client/v3/register" \
  "$(json_body --arg username "${HUMAN_LOCALPART}" '{type:"m.login.application_service",username:$username}')"
assert_status 200
[[ "$(jq -r '.user_id // empty' <<<"${LAST_BODY}")" == "${HUMAN_USER_ID}" ]] || die "Disposable Human registration returned the wrong identity."
human_token="$(jq -r '.access_token // empty' <<<"${LAST_BODY}")"
[[ "${human_token}" =~ ^[A-Za-z0-9._~-]{16,512}$ ]] || die "Disposable Human registration did not return a token."
human_created=1
# Bind a password to the disposable Human so deactivation can later be proven by
# password-login denial; the password never crosses the app or database.
matrix_call "${admin_token}" PUT "/_matrix/client/v3/rooms/${ADMIN_ROOM_PATH}/send/m.room.message/p0-4-reset-${RUN_ID}" \
  "$(json_body --arg command "!admin users reset-password ${HUMAN_USER_ID} ${HUMAN_PASSWORD}" '{msgtype:"m.text",body:$command}')"
[[ "${LAST_STATUS}" == 200 || "${LAST_STATUS}" == 201 ]] || die "Admin password reset command was not accepted."
for _ in $(seq 1 40); do
  matrix_call "" POST "/_matrix/client/v3/login" \
    "$(json_body --arg user "${HUMAN_LOCALPART}" --arg password "${HUMAN_PASSWORD}" '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password}')"
  [[ "${LAST_STATUS}" == 200 ]] && break
  sleep 0.5
done
[[ "${LAST_STATUS}" == 200 ]] || die "Disposable Human password was not set within the bounded window."
matrix_call "${human_token}" GET "/_matrix/client/v3/account/whoami"
assert_status 200
[[ "$(jq -r '.user_id // empty' <<<"${LAST_BODY}")" == "${HUMAN_USER_ID}" ]] || die "Human whoami did not preserve the authenticated sender."

# Launch PostgreSQL (no host volume) and the app on the shared AgentTeams network.
docker run --detach --name "${DB_CONTAINER}" --network agentteams-net --network-alias "${DB_ALIAS}" \
  --label "tiangong.p0.4.run=${RUN_ID}" \
  --env POSTGRES_USER=p0probe --env POSTGRES_PASSWORD="${db_password}" --env POSTGRES_DB=p0probe \
  "${POSTGRES_IMAGE}" >/dev/null
owned_db=1
for _ in $(seq 1 120); do
  if docker exec "${DB_CONTAINER}" pg_isready -h 127.0.0.1 -p 5432 -U p0probe -d p0probe >/dev/null 2>&1; then break; fi
  [[ "$(docker inspect "${DB_CONTAINER}" --format '{{.State.Running}}' 2>/dev/null)" == true ]] || break
  sleep 1
done
docker exec "${DB_CONTAINER}" pg_isready -h 127.0.0.1 -p 5432 -U p0probe -d p0probe >/dev/null 2>&1 || die "PostgreSQL did not become ready."
docker run --detach --name "${APP_CONTAINER}" --network agentteams-net --network-alias "p0-4-app" \
  --add-host host.docker.internal:host-gateway --publish 127.0.0.1::8080 \
  --label "tiangong.p0.4.run=${RUN_ID}" \
  --env PROBE_KEY="${probe_key}" --env MATRIX_ORIGIN="http://host.docker.internal:${MATRIX_GATEWAY_PORT}/" \
  --env MATRIX_HOST="${MATRIX_HOST}" --env BOUND_WORKER_USER_ID="${WORKER_USER_ID}" \
  --env PGHOST="${DB_ALIAS}" --env PGPORT=5432 --env PGUSER=p0probe --env PGPASSWORD="${db_password}" \
  --env PGDATABASE=p0probe --env SESSION_TTL_MS=180000 --env STEP_UP_TTL_MS=1200 \
  "${APP_IMAGE}" >/dev/null
owned_app=1
APP_PORT="$(docker port "${APP_CONTAINER}" 8080/tcp | awk -F: 'NR == 1 {print $NF}')"
[[ "${APP_PORT}" =~ ^[0-9]+$ ]] || die "App host port was not published."
for _ in $(seq 1 90); do
  app_call "" GET /healthz
  [[ "${LAST_STATUS}" == 200 ]] && break
  sleep 1
done
app_call "" GET /healthz
assert_status 200
jq -e '.status == "ready" and .database == "ready" and .network == "agentteams"' <<<"${LAST_BODY}" >/dev/null || die "App health did not prove database/network readiness."

# App and DB are both attached to the shared network (observed, not prose).
NETWORK_FACTS="$(docker network inspect agentteams-net | jq -c --arg app "${APP_CONTAINER}" --arg db "${DB_CONTAINER}" \
  '.[0].Containers | to_entries | map(.value) | {app:any(.Name == $app), database:any(.Name == $db)}')"
jq -e '.app and .database' <<<"${NETWORK_FACTS}" >/dev/null || die "App/PostgreSQL network attachment was not observed."

# Human and Worker identity cross the app boundary only as current Matrix proofs.
app_call "${human_token}" POST /session/start
assert_status 200
HUMAN_CSRF="$(jq -r '.csrf_token // empty' <<<"${LAST_BODY}")"
[[ "${HUMAN_CSRF}" =~ ^[A-Za-z0-9._~-]{16,128}$ ]] || die "App session did not return a CSRF token."
assert_json_field '.actor' "${HUMAN_USER_ID}"
assert_json_field '.auth_mode' transient_matrix_proof
assert_json_field '.max_staleness_ms' "0"
COOKIE_HEADER="$(grep -i '^set-cookie:' "${LAST_HEADERS}" | head -n 1 | sed 's/^[^:]*:[[:space:]]*//; s/\r$//')"
[[ "${COOKIE_HEADER}" == tiangong_probe_session=* ]] || die "App did not issue its session cookie."
node --input-type=module - "${COOKIE_HEADER}" <<'NODE'
import { assertCookieHeader } from "./smoke-testing/support/p0-identity-pg-contract.mjs";
assertCookieHeader(process.argv[2]);
NODE
app_call "${human_token}" GET /protected/read
assert_status 200
node --input-type=module - "${HUMAN_USER_ID}" "${LAST_BODY}" <<'NODE'
import { assertReadAuthorization } from "./smoke-testing/support/p0-identity-pg-contract.mjs";
assertReadAuthorization(JSON.parse(process.argv[3]), process.argv[2]);
NODE
app_call "" GET /protected/read
assert_status 401
app_call "${worker_token}" GET /worker/internal-identity
assert_status 200
[[ "$(jq -r '.actor // empty' <<<"${LAST_BODY}")" == "${WORKER_USER_ID}" ]] || die "Worker internal route did not preserve current Matrix identity."
app_call "${human_token}" GET /worker/internal-identity
assert_status 403

# Direct PostgreSQL race and uniqueness facts are returned only after the app
# executes them; they are not asserted from prose.
app_call "" POST /database/probe
assert_status 200
node --input-type=module - "${LAST_BODY}" <<'NODE'
import { assertDatabaseFacts } from "./smoke-testing/support/p0-identity-pg-contract.mjs";
assertDatabaseFacts(JSON.parse(process.argv[2]));
NODE

# CSRF and exact fresh step-up: the app session alone never authorizes a
# dangerous action.
app_call "${human_token}" POST /step-up/challenge "$(json_body --arg operation_id p0-operation-a --arg action approve '{operation_id:$operation_id,action:$action}')"
assert_status 403
app_call "${human_token}" POST /step-up/challenge "$(json_body --arg operation_id p0-operation-a --arg action approve '{operation_id:$operation_id,action:$action}')" "${HUMAN_CSRF}"
assert_status 200
CHALLENGE_A="$(jq -r '.challenge_id // empty' <<<"${LAST_BODY}")"
app_call "${human_token}" POST /step-up/complete "$(json_body --arg challenge_id "${CHALLENGE_A}" --arg operation_id p0-operation-a --arg action approve '{challenge_id:$challenge_id,operation_id:$operation_id,action:$action}')" "${HUMAN_CSRF}"
assert_status 200
node --input-type=module - "${HUMAN_USER_ID}" "${LAST_BODY}" <<'NODE'
import { assertFreshStepUp } from "./smoke-testing/support/p0-identity-pg-contract.mjs";
const body = JSON.parse(process.argv[3]);
assertFreshStepUp(body, process.argv[2], "p0-operation-a", "approve", body.issuer);
NODE
# One-time challenge: replay is rejected.
app_call "${human_token}" POST /step-up/complete "$(json_body --arg challenge_id "${CHALLENGE_A}" --arg operation_id p0-operation-a --arg action approve '{challenge_id:$challenge_id,operation_id:$operation_id,action:$action}')" "${HUMAN_CSRF}"
assert_status 403
# Cross-operation/action binding is rejected.
app_call "${human_token}" POST /step-up/challenge "$(json_body --arg operation_id p0-operation-b --arg action reject '{operation_id:$operation_id,action:$action}')" "${HUMAN_CSRF}"
assert_status 200
CHALLENGE_B="$(jq -r '.challenge_id // empty' <<<"${LAST_BODY}")"
app_call "${human_token}" POST /step-up/complete "$(json_body --arg challenge_id "${CHALLENGE_B}" --arg operation_id p0-operation-a --arg action approve '{challenge_id:$challenge_id,operation_id:$operation_id,action:$action}')" "${HUMAN_CSRF}"
assert_status 403
# Expired challenge is rejected.
app_call "${human_token}" POST /step-up/challenge "$(json_body --arg operation_id p0-operation-expire --arg action approve '{operation_id:$operation_id,action:$action}')" "${HUMAN_CSRF}"
assert_status 200
CHALLENGE_EXPIRE="$(jq -r '.challenge_id // empty' <<<"${LAST_BODY}")"
sleep 2
app_call "${human_token}" POST /step-up/complete "$(json_body --arg challenge_id "${CHALLENGE_EXPIRE}" --arg operation_id p0-operation-expire --arg action approve '{challenge_id:$challenge_id,operation_id:$operation_id,action:$action}')" "${HUMAN_CSRF}"
assert_status 403

# SSE carries the same transient proof and closes after Matrix token revocation.
(
  {
    printf 'header = "x-probe-key: %s"\n' "${probe_key}"
    printf 'header = "Authorization: Bearer %s"\n' "${human_token}"
  } | curl --config - --silent --show-error --no-buffer --max-time 25 \
    --cookie "${COOKIE_JAR}" "http://127.0.0.1:${APP_PORT}/events" >"${SSE_FILE}" 2>/dev/null || true
) &
sse_pid=$!
for _ in $(seq 1 40); do
  grep -Fq 'event: ready' "${SSE_FILE}" 2>/dev/null && break
  sleep 0.2
done
grep -Fq 'event: ready' "${SSE_FILE}" || die "SSE did not start with a current transient Matrix proof."
matrix_call "${human_token}" POST "/_matrix/client/v3/logout"
[[ "${LAST_STATUS}" == 200 ]] || die "Human Matrix logout did not return success."
for _ in $(seq 1 40); do
  grep -Fq 'event: revoked' "${SSE_FILE}" 2>/dev/null && break
  sleep 0.2
done
wait "${sse_pid}" >/dev/null 2>&1 || true
sse_pid=""
grep -Fq 'event: revoked' "${SSE_FILE}" || die "Existing SSE did not close after Matrix token revocation."
app_call "${human_token}" GET /protected/read
assert_status 401
app_call "${human_token}" POST /session/logout "" "${HUMAN_CSRF}"
assert_status 200

# Inspect the app's bounded diagnostics and all observable logs before cleanup.
app_call "" GET /diagnostics
assert_status 200
jq -e '.credential_storage.matrix_token_in_memory_only == true and .credential_storage.matrix_token_in_database == false and .credential_storage.matrix_token_in_logs == false' \
  <<<"${LAST_BODY}" >/dev/null || die "App diagnostics did not retain the credential boundary."
APP_LOG="$(docker logs "${APP_CONTAINER}" 2>&1 || true)"
DB_LOG="$(docker logs "${DB_CONTAINER}" 2>&1 || true)"
assert_no_secret_in_text "${APP_LOG}"
assert_no_secret_in_text "${DB_LOG}"
assert_no_secret_in_text "${LAST_BODY}"

STATE_REPORT="$(jq -cn \
  --arg run_id "${RUN_ID}" --arg worker "${WORKER_USER_ID}" --arg human "${HUMAN_USER_ID}" \
  --arg worker_room "${WORKER_ROOM_ID}" --arg app "${APP_CONTAINER}" --arg db "${DB_CONTAINER}" \
  --arg image "${APP_IMAGE}" --arg app_port "${APP_PORT}" --arg network_facts "${NETWORK_FACTS}" \
  '{run_id:$run_id,worker_user_id:$worker,human_user_id:$human,worker_room_id:$worker_room,app_container:$app,postgres_container:$db,app_image:$image,app_port:($app_port|tonumber),network_facts:($network_facts|fromjson),auth_mode:"transient_matrix_proof",max_staleness_ms:0,step_up:{issuer:"configured Matrix homeserver",challenge_binding:"app-session+actor+operation+action",one_time:true},database:{unique_constraint:true,select_for_update:true,optimistic_epoch:true},credential_observations:{app_log_clean:true,database_log_clean:true,diagnostics_clean:true},scope:"probe_scaffold_only_no_work_no_team_route_memberconfig"}')"
printf '%s\n' "${STATE_REPORT}" >"${STATE_DIR}/sanitized-report.json"
log "P0.4 identity/PostgreSQL probe facts: ${STATE_REPORT}"
log "Owned resources will now be revoked and removed exactly."
