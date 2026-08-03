#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Start the code-owned shared Runner broker before any professional Task is
# notified. The broker is the only component that receives the Docker socket;
# professional Workers reach its fixed internal DNS name and receive no
# platform credential or socket.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly NETWORK="agentteams-net"
readonly BROKER="tiangong-runner-broker"
readonly BROKER_IMAGE="tiangong-runner-broker:dev"
readonly OWNER="tiangong"
readonly COMPONENT="runner-broker"
readonly CONFIG_VOLUME="tiangong-runner-broker-config"
readonly FIXTURE_VOLUME="tiangong-runner-broker-fixtures"
readonly STATE_VOLUME="tiangong-runner-broker-state"
readonly SEED="tiangong-runner-broker-seed"

fail() {
  printf 'runner_broker=fail code=%s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: %s start|status|stop [--purge]\n' "$0" >&2
}

[[ $# -ge 1 && $# -le 2 ]] || { usage; fail INVALID_ARGUMENTS; }
readonly ACTION="$1"
readonly PURGE="${2:-}"
[[ "$ACTION" == start || "$ACTION" == status || "$ACTION" == stop ]] || { usage; fail INVALID_ACTION; }
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
  if docker inspect "$BROKER" >/dev/null 2>&1; then
    owned_container "$BROKER" || fail FOREIGN_CONTAINER
    docker rm --force "$BROKER" >/dev/null
  fi
  if [[ "$PURGE" == --purge ]]; then
    for volume in "$CONFIG_VOLUME" "$FIXTURE_VOLUME" "$STATE_VOLUME"; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then
        owned_volume "$volume" || fail FOREIGN_VOLUME
        docker volume rm "$volume" >/dev/null
      fi
    done
  fi
  printf 'runner_broker=stopped purge=%s\n' "$([[ "$PURGE" == --purge ]] && echo true || echo false)"
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

  local leader_image implementor_image assessor_image config_file
  leader_image="$(docker image inspect --format '{{.Id}}' tiangong-worker-leader:dev)"
  implementor_image="$(docker image inspect --format '{{.Id}}' tiangong-worker-implementor:dev)"
  assessor_image="$(docker image inspect --format '{{.Id}}' tiangong-worker-assessor:dev)"
  config_file="$(mktemp "${TMPDIR:-/tmp}/tiangong-runner-broker-config.XXXXXX")"
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
  docker create --name "$SEED" \
    --mount "type=volume,src=${CONFIG_VOLUME},dst=/config" \
    --mount "type=volume,src=${FIXTURE_VOLUME},dst=/fixture" \
    --entrypoint /bin/sh "$BROKER_IMAGE" -c 'sleep 300' >/dev/null
  docker start "$SEED" >/dev/null
  docker cp "$config_file" "$SEED:/config/config.json"
  docker exec "$SEED" chmod 600 /config/config.json
  docker exec "$SEED" mkdir -p /fixture/isolation
  docker cp "${REPO_ROOT}/smoke-testing/fixtures/runner-isolation/." "$SEED:/fixture/isolation/"
  docker rm --force "$SEED" >/dev/null

  docker create --name "$BROKER" --network "$NETWORK" \
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
  stop) stop ;;
esac
