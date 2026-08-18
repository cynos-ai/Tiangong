#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Start the code-owned shared Runner broker before any professional Task is
# notified. The broker is the only component that receives the Docker socket;
# professional Workers reach its fixed internal DNS name and receive no
# platform credential or socket.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly NETWORK="agentteams-net"
readonly BROKER="tiangong-runner-broker"
readonly BROKER_IMAGE="tiangong-runner-broker:dev"
readonly OWNER="tiangong"
readonly COMPONENT="runner-broker"
readonly CONFIG_VOLUME="tiangong-runner-broker-config"
readonly FIXTURE_VOLUME="tiangong-runner-broker-fixtures"
readonly STATE_VOLUME="tiangong-runner-broker-state"
readonly SEED="tiangong-runner-broker-seed"
DOCKER_BINARY="$(command -v docker 2>/dev/null || true)"
DOCKER_BINARY_REAL="$(readlink -f "${DOCKER_BINARY}" 2>/dev/null || printf '%s' "${DOCKER_BINARY}")"
DOCKER_USES_WINDOWS_PATHS=0
[[ "${DOCKER_BINARY_REAL}" == *.exe ]] && DOCKER_USES_WINDOWS_PATHS=1
if ((DOCKER_USES_WINDOWS_PATHS == 0)) && command -v file >/dev/null 2>&1 && file "${DOCKER_BINARY_REAL}" 2>/dev/null | grep -Eiq 'PE32|MS-DOS'; then
  DOCKER_USES_WINDOWS_PATHS=1
fi
readonly DOCKER_BINARY DOCKER_BINARY_REAL DOCKER_USES_WINDOWS_PATHS

fail() {
  printf 'runner_broker=fail code=%s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: %s start|status|ensure|stop [--purge]\n' "$0" >&2
}

[[ $# -ge 1 && $# -le 2 ]] || { usage; fail INVALID_ARGUMENTS; }
readonly ACTION="$1"
readonly PURGE="${2:-}"
[[ "$ACTION" == start || "$ACTION" == status || "$ACTION" == ensure || "$ACTION" == stop ]] || { usage; fail INVALID_ACTION; }
[[ -z "$PURGE" || "$PURGE" == --purge ]] || { usage; fail INVALID_ARGUMENTS; }
[[ "$ACTION" == stop || -z "$PURGE" ]] || { usage; fail INVALID_ARGUMENTS; }

command -v docker >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE
command -v jq >/dev/null 2>&1 || fail JQ_UNAVAILABLE
docker info >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE

owned_container() {
  local name="$1"
  local owner component
  owner="$(docker inspect --format '{{index .Config.Labels "io.tiangong.owner"}}' "$name" 2>/dev/null || true)"
  component="$(docker inspect --format '{{index .Config.Labels "io.tiangong.component"}}' "$name" 2>/dev/null || true)"
  [[ "$owner" == "$OWNER" && "$component" == "$COMPONENT" ]]
}

owned_volume() {
  local name="$1"
  local owner component
  owner="$(docker volume inspect --format '{{index .Labels "io.tiangong.owner"}}' "$name" 2>/dev/null || true)"
  component="$(docker volume inspect --format '{{index .Labels "io.tiangong.component"}}' "$name" 2>/dev/null || true)"
  [[ "$owner" == "$OWNER" && "$component" == "$COMPONENT" ]]
}

resource_absent() {
  local kind="$1" name="$2"
  if docker "$kind" inspect "$name" >/dev/null 2>&1; then
    fail "${kind^^}_ALREADY_EXISTS"
  fi
}

status() {
  if ! docker inspect "$BROKER" >/dev/null 2>&1; then
    printf 'runner_broker=absent\n'
    return 1
  fi
  owned_container "$BROKER" || fail FOREIGN_CONTAINER
  local running
  running="$(docker inspect --format '{{.State.Running}}' "$BROKER")"
  [[ "$running" == true ]] || fail NOT_RUNNING
  docker network inspect "$NETWORK" >/dev/null 2>&1 || fail NETWORK_UNAVAILABLE
  docker network inspect "$NETWORK" | jq -e --arg name "$BROKER" \
    '.[0].Containers | to_entries[]? | select(.value.Name == $name)' >/dev/null || fail BROKER_NETWORK_MEMBERSHIP
  printf 'runner_broker=ready\n'
}

stop() {
  local purge="${1:-$PURGE}"
  if docker inspect "$BROKER" >/dev/null 2>&1; then
    owned_container "$BROKER" || fail FOREIGN_CONTAINER
    docker rm --force "$BROKER" >/dev/null
  fi
  if [[ "$purge" == --purge ]]; then
    for volume in "$CONFIG_VOLUME" "$FIXTURE_VOLUME" "$STATE_VOLUME"; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then
        owned_volume "$volume" || fail FOREIGN_VOLUME
        docker volume rm "$volume" >/dev/null
      fi
    done
  fi
  printf 'runner_broker=stopped purge=%s\n' "$([[ "$purge" == --purge ]] && echo true || echo false)"
}

preparation_matches_current_images() {
  local config leader implementor assessor
  leader="$(docker image inspect --format '{{.Id}}' tiangong-worker-leader:dev 2>/dev/null || true)"
  implementor="$(docker image inspect --format '{{.Id}}' tiangong-worker-implementor:dev 2>/dev/null || true)"
  assessor="$(docker image inspect --format '{{.Id}}' tiangong-worker-assessor:dev 2>/dev/null || true)"
  [[ -n "$leader" && -n "$implementor" && -n "$assessor" ]] || return 1
  config="$(docker run --rm --entrypoint cat \
    --mount "type=volume,src=${CONFIG_VOLUME},dst=/config,readonly" \
    "$BROKER_IMAGE" /config/config.json 2>/dev/null || true)"
  jq -e --arg leader "$leader" --arg implementor "$implementor" --arg assessor "$assessor" \
    '.preparation.leaderImageId == $leader and .preparation.runnerImageIds.implementor == $implementor and .preparation.runnerImageIds.assessor == $assessor' \
    <<<"$config" >/dev/null
}

bindings_are_orphaned_or_empty() {
  local state container
  state="$(docker run --rm --entrypoint cat \
    --mount "type=volume,src=${STATE_VOLUME},dst=/state,readonly" \
    "$BROKER_IMAGE" /state/bindings.json 2>/dev/null || printf '{"bindings":[]}\n')"
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    docker inspect "$container" >/dev/null 2>&1 && return 1
  done < <(jq -r '.bindings[]?.containerName // empty' <<<"$state")
  return 0
}

ensure() {
  local state running
  if ! docker inspect "$BROKER" >/dev/null 2>&1; then
    # A previous process can remove the broker container after creating its
    # owned volumes (for example, a host-side interruption during startup).
    # Reclaim that exact orphaned state only when every volume is owned by this
    # broker and no live binding still references a container.
    local has_owned_volume=0 volume
    for volume in "$CONFIG_VOLUME" "$FIXTURE_VOLUME" "$STATE_VOLUME"; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then
        owned_volume "$volume" || fail FOREIGN_VOLUME
        has_owned_volume=1
      fi
    done
    if ((has_owned_volume == 1)); then
      if docker inspect "$SEED" >/dev/null 2>&1; then
        [[ "$(docker inspect --format '{{.Config.Image}}' "$SEED")" == "$BROKER_IMAGE" ]] || fail FOREIGN_SEED
        docker rm --force "$SEED" >/dev/null
      fi
      bindings_are_orphaned_or_empty || fail ACTIVE_BINDING_STATE
      stop --purge
    fi
    start
    printf 'runner_broker_ensure=started managed=true\n'
    return 0
  fi
  owned_container "$BROKER" || fail FOREIGN_CONTAINER
  running="$(docker inspect --format '{{.State.Running}}' "$BROKER")"
  if [[ "$running" != true ]]; then
    # A stopped broker cannot serve a new Task, but its state may still carry
    # immutable bindings. Reclaim it only when every such binding points to a
    # container that is already gone; a live binding remains fail-closed.
    bindings_are_orphaned_or_empty || fail ACTIVE_BINDING_STATE
    stop --purge
    start
    printf 'runner_broker_ensure=restarted_stopped managed=true\n'
    return 0
  fi
  status >/dev/null
  # Even when image pins are unchanged, an interrupted smoke can leave
  # immutable bindings whose Worker containers are gone. Reclaim that exact
  # orphaned state before another run fills the broker registry.
  if ! bindings_are_orphaned_or_empty; then
    fail ACTIVE_BINDING_STATE
  fi
  state="$(docker run --rm --entrypoint cat \
    --mount "type=volume,src=${STATE_VOLUME},dst=/state,readonly" \
    "$BROKER_IMAGE" /state/bindings.json 2>/dev/null || printf '{"bindings":[]}\n')"
  if jq -e '.bindings | length > 0' <<<"$state" >/dev/null; then
    stop --purge
    start
    printf 'runner_broker_ensure=restarted_orphaned managed=true\n'
    return 0
  fi
  if preparation_matches_current_images; then
    printf 'runner_broker_ensure=ready managed=false\n'
    return 0
  fi
  # Replacing the image-pinned broker while another Task is registered would
  # invalidate its immutable runner binding. Fail closed instead of purging a
  # live broker state volume.
  bindings_are_orphaned_or_empty || fail STALE_IMAGE_BINDING_ACTIVE
  stop --purge
  start
  printf 'runner_broker_ensure=restarted managed=true\n'
}

start() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || fail NETWORK_UNAVAILABLE
  resource_absent container "$BROKER"
  resource_absent volume "$CONFIG_VOLUME"
  resource_absent volume "$FIXTURE_VOLUME"
  resource_absent volume "$STATE_VOLUME"
  docker image inspect "$BROKER_IMAGE" >/dev/null 2>&1 || fail BROKER_IMAGE_UNAVAILABLE
  for image in tiangong-worker-leader:dev tiangong-worker-implementor:dev tiangong-worker-assessor:dev; do
    docker image inspect "$image" >/dev/null 2>&1 || fail "IMAGE_UNAVAILABLE_${image%%:*}"
  done

  local leader_image implementor_image assessor_image config_file temp_root
  leader_image="$(docker image inspect --format '{{.Id}}' tiangong-worker-leader:dev)"
  implementor_image="$(docker image inspect --format '{{.Id}}' tiangong-worker-implementor:dev)"
  assessor_image="$(docker image inspect --format '{{.Id}}' tiangong-worker-assessor:dev)"
  # Docker Desktop cannot resolve a WSL /tmp path when the CLI projects a
  # host file into a container. Keep this disposable file under the shared
  # repository mount so both native Windows and WSL Docker clients can read it.
  temp_root="${TIANGONG_DOCKER_TEMP_DIR:-${REPO_ROOT}/.tmp-runner-broker}"
  [[ -d "${temp_root}" && ! -L "${temp_root}" ]] || mkdir -p "${temp_root}"
  chmod 700 "${temp_root}"
  config_file="$(mktemp "${temp_root}/config.XXXXXX")"
  jq -n \
    --arg leader "$leader_image" \
    --arg implementor "$implementor_image" \
    --arg assessor "$assessor_image" \
    '{schemaVersion:1,network:"agentteams-net",listenPort:8787,bindings:[],preparation:{leaderImageId:$leader,runnerImageIds:{implementor:$implementor,assessor:$assessor}}}' \
    >"$config_file"
  chmod 600 "$config_file"

  for volume in "$CONFIG_VOLUME" "$FIXTURE_VOLUME" "$STATE_VOLUME"; do
    docker volume create \
      --label "io.tiangong.owner=${OWNER}" \
      --label "io.tiangong.component=${COMPONENT}" \
      "$volume" >/dev/null
  done
  MSYS_NO_PATHCONV=1 docker create --name "$SEED" \
    --mount "type=volume,src=${CONFIG_VOLUME},dst=/config" \
    --mount "type=volume,src=${FIXTURE_VOLUME},dst=/fixture" \
    --entrypoint /bin/sh "$BROKER_IMAGE" -c 'sleep 300' >/dev/null
  docker start "$SEED" >/dev/null
  # Git Bash rewrites POSIX-looking Docker container destinations (for
  # example /config) into a Windows host path unless path conversion is
  # disabled for that one command. Keep the host source as an absolute
  # Windows path so Docker Desktop can still read the temporary file.
  local config_source fixture_source
  if [[ "${OSTYPE:-}" =~ ^(msys|cygwin) ]]; then
    config_source="$(cygpath -w "$config_file")"
    fixture_source="$(cygpath -w "${REPO_ROOT}/smoke-testing/fixtures/runner-isolation/.")"
  elif ((DOCKER_USES_WINDOWS_PATHS == 1)) && command -v wslpath >/dev/null 2>&1; then
    config_source="$(wslpath -w "$config_file")"
    fixture_source="$(wslpath -w "${REPO_ROOT}/smoke-testing/fixtures/runner-isolation/.")"
  else
    config_source="$config_file"
    fixture_source="${REPO_ROOT}/smoke-testing/fixtures/runner-isolation/."
  fi
  MSYS_NO_PATHCONV=1 docker cp "$config_source" "$SEED:/config/config.json"
  # The broker image runs as its unprivileged worker user. The projected file
  # contains only image IDs and fixed policy, so it may be world-readable
  # inside the private config volume; keeping mode 600 would make a fresh
  # Docker Desktop volume unreadable to the broker process.
  MSYS_NO_PATHCONV=1 docker exec "$SEED" chmod 644 /config/config.json
  MSYS_NO_PATHCONV=1 docker exec "$SEED" mkdir -p /fixture/isolation
  MSYS_NO_PATHCONV=1 docker cp "$fixture_source" "$SEED:/fixture/isolation/"
  docker rm --force "$SEED" >/dev/null

  MSYS_NO_PATHCONV=1 docker create --name "$BROKER" --network "$NETWORK" \
    --label "io.tiangong.owner=${OWNER}" \
    --label "io.tiangong.component=${COMPONENT}" \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 256 --memory 512m --cpus 1 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --env HOME=/tmp \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --mount "type=volume,src=${CONFIG_VOLUME},dst=/run/tiangong-runner-broker,readonly" \
    --mount "type=volume,src=${FIXTURE_VOLUME},dst=/opt/tiangong-runner-fixtures,readonly" \
    --mount "type=volume,src=${STATE_VOLUME},dst=/var/lib/tiangong-runner-broker" \
    "$BROKER_IMAGE" >/dev/null
  docker start "$BROKER" >/dev/null

  for _ in {1..60}; do
    if docker logs "$BROKER" 2>&1 | grep -q '^runner_broker_ready=pass '; then
      break
    fi
    [[ "$(docker inspect --format '{{.State.Running}}' "$BROKER" 2>/dev/null || true)" == true ]] || fail BROKER_STOPPED_BEFORE_READY
    sleep 1
  done
  docker logs "$BROKER" 2>&1 | grep -q '^runner_broker_ready=pass ' || fail BROKER_READINESS_TIMEOUT
  rm -f "$config_file"

  docker run --rm --network "$NETWORK" --entrypoint node "$BROKER_IMAGE" \
    --input-type=module -e '
      const response = await fetch("http://tiangong-runner-broker:8787/v1/execute", { signal: AbortSignal.timeout(5000) });
      if (response.status !== 404) process.exit(1);
    ' >/dev/null 2>&1 || fail BROKER_DNS_UNREACHABLE
  status
}

case "$ACTION" in
  start) start ;;
  status) status ;;
  ensure) ensure ;;
  stop) stop ;;
esac
