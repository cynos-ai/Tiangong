#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly FIXTURE_DIR="${REPO_ROOT}/smoke-testing/fixtures/runner-isolation"
readonly RUNNER_POLICY="${REPO_ROOT}/worker/agent/runner/runner-policy.mjs"
readonly RUNNER_IMAGE="${TIANGONG_RUNNER_IMAGE:-tiangong-worker-implementor:dev}"
RUN_ID="run-$(cat /proc/sys/kernel/random/uuid)"
readonly RUN_ID
readonly RESOURCE_SUFFIX="${RUN_ID#run-}"
readonly CONTAINER_NAME="tiangong-runner-spike-${RESOURCE_SUFFIX}"
readonly SEED_CONTAINER_NAME="tiangong-runner-seed-${RESOURCE_SUFFIX}"
readonly FIXTURE_VOLUME="tiangong-runner-fixture-${RESOURCE_SUFFIX}"
readonly SCRATCH_VOLUME="tiangong-runner-scratch-${RESOURCE_SUFFIX}"
ARTIFACT_DIR=""
resources_started=0

log() { printf '[Tiangong] %s\n' "$*"; }
die() { printf '[Tiangong] ERROR: %s\n' "$*" >&2; exit 1; }
container_exists() { docker inspect "$1" >/dev/null 2>&1; }
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

remove_owned_container() {
  local name=$1 owner_label run_label
  container_exists "${name}" || return 0
  owner_label="$(docker inspect --format '{{index .Config.Labels "io.tiangong.owner"}}' "${name}" 2>/dev/null)"
  run_label="$(docker inspect --format '{{index .Config.Labels "io.tiangong.run-id"}}' "${name}" 2>/dev/null)"
  if [[ "${owner_label}" != "runner-isolation-spike" || "${run_label}" != "${RUN_ID}" ]]; then
    printf '[Tiangong] ERROR: refusing to remove container without exact ownership labels: %s\n' "${name}" >&2
    return 1
  fi
  docker rm --force "${name}" >/dev/null 2>&1
}

remove_owned_volume() {
  local name=$1 owner_label run_label
  volume_exists "${name}" || return 0
  owner_label="$(docker volume inspect --format '{{index .Labels "io.tiangong.owner"}}' "${name}" 2>/dev/null)"
  run_label="$(docker volume inspect --format '{{index .Labels "io.tiangong.run-id"}}' "${name}" 2>/dev/null)"
  if [[ "${owner_label}" != "runner-isolation-spike" || "${run_label}" != "${RUN_ID}" ]]; then
    printf '[Tiangong] ERROR: refusing to remove volume without exact ownership labels: %s\n' "${name}" >&2
    return 1
  fi
  docker volume rm "${name}" >/dev/null 2>&1
}

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT INT TERM
  set +e

  if [[ "${resources_started}" -eq 1 ]]; then
    remove_owned_container "${CONTAINER_NAME}" || cleanup_failed=1
    remove_owned_container "${SEED_CONTAINER_NAME}" || cleanup_failed=1
    remove_owned_volume "${FIXTURE_VOLUME}" || cleanup_failed=1
    remove_owned_volume "${SCRATCH_VOLUME}" || cleanup_failed=1
  fi

  if container_exists "${CONTAINER_NAME}" || container_exists "${SEED_CONTAINER_NAME}" || \
      volume_exists "${FIXTURE_VOLUME}" || volume_exists "${SCRATCH_VOLUME}"; then
    printf '[Tiangong] ERROR: run-owned Docker resources remain after cleanup\n' >&2
    cleanup_failed=1
  fi

  if [[ -n "${ARTIFACT_DIR}" ]]; then
    rm -rf -- "${ARTIFACT_DIR}" || cleanup_failed=1
    if [[ -e "${ARTIFACT_DIR}" ]]; then
      printf '[Tiangong] ERROR: runner artifacts remain after cleanup\n' >&2
      cleanup_failed=1
    fi
  fi

  if [[ "${cleanup_failed}" -ne 0 ]]; then
    status=1
  else
    log "runner_cleanup=pass"
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

command -v docker >/dev/null 2>&1 || die "docker is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v node >/dev/null 2>&1 || die "node is required"
[[ -f "${FIXTURE_DIR}/probe.mjs" && -f "${FIXTURE_DIR}/input.txt" ]] || die "runner fixture is incomplete"
[[ -f "${RUNNER_POLICY}" ]] || die "RunnerPort policy is missing"
for name in "${CONTAINER_NAME}" "${SEED_CONTAINER_NAME}"; do
  container_exists "${name}" && die "refusing to replace existing container ${name}"
done
for name in "${FIXTURE_VOLUME}" "${SCRATCH_VOLUME}"; do
  volume_exists "${name}" && die "refusing to replace existing volume ${name}"
done

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${RUNNER_IMAGE}" 2>/dev/null)" || die "runner image is unavailable: ${RUNNER_IMAGE}"
readonly IMAGE_ID
[[ "${IMAGE_ID}" == sha256:* ]] || die "runner image did not resolve to an immutable local ID"

mapfile -t FORBIDDEN_ENV_NAMES < <(
  # shellcheck disable=SC2016
  node --input-type=module -e \
    'const { FORBIDDEN_ENV_KEYS } = await import(process.argv[1]); process.stdout.write(`${FORBIDDEN_ENV_KEYS.join("\n")}\n`);' \
    "${RUNNER_POLICY}"
)
mapfile -t FORBIDDEN_NETWORK_TARGETS < <(
  # shellcheck disable=SC2016
  node --input-type=module -e \
    'const { FORBIDDEN_NETWORK_TARGETS } = await import(process.argv[1]); process.stdout.write(`${FORBIDDEN_NETWORK_TARGETS.join("\n")}\n`);' \
    "${RUNNER_POLICY}"
)
[[ "${#FORBIDDEN_ENV_NAMES[@]}" -gt 0 && "${#FORBIDDEN_NETWORK_TARGETS[@]}" -gt 0 ]] || die "RunnerPort isolation policy is empty"
FORBIDDEN_ENV_CSV="$(IFS=,; printf '%s' "${FORBIDDEN_ENV_NAMES[*]}")"
readonly FORBIDDEN_ENV_CSV
FORBIDDEN_NETWORK_CSV="$(IFS=,; printf '%s' "${FORBIDDEN_NETWORK_TARGETS[*]}")"
readonly FORBIDDEN_NETWORK_CSV
FORBIDDEN_ENV_JSON="$(printf '%s\n' "${FORBIDDEN_ENV_NAMES[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
readonly FORBIDDEN_ENV_JSON

ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tiangong-runner-spike.XXXXXXXX")"
chmod 0700 "${ARTIFACT_DIR}"
readonly ARTIFACT_DIR
RUNNER_UID="$(id -u)"
readonly RUNNER_UID
RUNNER_GID="$(id -g)"
readonly RUNNER_GID

resources_started=1
docker volume create \
  --label io.tiangong.owner=runner-isolation-spike \
  --label "io.tiangong.run-id=${RUN_ID}" \
  "${FIXTURE_VOLUME}" >/dev/null
docker volume create \
  --label io.tiangong.owner=runner-isolation-spike \
  --label "io.tiangong.run-id=${RUN_ID}" \
  "${SCRATCH_VOLUME}" >/dev/null

docker create \
  --name "${SEED_CONTAINER_NAME}" \
  --label io.tiangong.owner=runner-isolation-spike \
  --label "io.tiangong.run-id=${RUN_ID}" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=volume,src=${FIXTURE_VOLUME},dst=/seed-fixture" \
  --mount "type=volume,src=${SCRATCH_VOLUME},dst=/seed-scratch" \
  --entrypoint /usr/bin/chmod \
  "${IMAGE_ID}" 0666 /seed-scratch/result.json >/dev/null
docker cp "${FIXTURE_DIR}/." "${SEED_CONTAINER_NAME}:/seed-fixture/"
: >"${ARTIFACT_DIR}/result.json"
docker cp "${ARTIFACT_DIR}/result.json" "${SEED_CONTAINER_NAME}:/seed-scratch/result.json"
docker start --attach "${SEED_CONTAINER_NAME}" >/dev/null
[[ "$(docker inspect --format '{{.State.ExitCode}}' "${SEED_CONTAINER_NAME}")" == "0" ]] || die "runner volume setup failed"
remove_owned_container "${SEED_CONTAINER_NAME}"

log "Creating run-owned disposable runner ${CONTAINER_NAME} from ${IMAGE_ID}"
docker create \
  --name "${CONTAINER_NAME}" \
  --label io.tiangong.owner=runner-isolation-spike \
  --label "io.tiangong.run-id=${RUN_ID}" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 256m \
  --cpus 1 \
  --user "${RUNNER_UID}:${RUNNER_GID}" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --mount "type=volume,src=${FIXTURE_VOLUME},dst=/workspace/fixture,readonly" \
  --mount "type=volume,src=${SCRATCH_VOLUME},dst=/workspace/scratch" \
  --workdir /workspace/fixture \
  --env HOME=/tmp \
  --env PATH=/usr/bin:/bin \
  --env "TIANGONG_RUN_ID=${RUN_ID}" \
  --env "TIANGONG_FORBIDDEN_ENV_NAMES=${FORBIDDEN_ENV_CSV}" \
  --env "TIANGONG_FORBIDDEN_NETWORK_TARGETS=${FORBIDDEN_NETWORK_CSV}" \
  --entrypoint /usr/bin/node \
  "${IMAGE_ID}" /workspace/fixture/probe.mjs >/dev/null

# Inspect the actual daemon-owned container configuration before execution.
if ! docker inspect "${CONTAINER_NAME}" | jq -e \
  --arg image_id "${IMAGE_ID}" \
  --arg fixture_volume "${FIXTURE_VOLUME}" \
  --arg scratch_volume "${SCRATCH_VOLUME}" \
  --arg user "${RUNNER_UID}:${RUNNER_GID}" \
  --arg run_id "${RUN_ID}" \
  --argjson forbidden_env "${FORBIDDEN_ENV_JSON}" '
  .[0]
  | (.Image == $image_id)
    and (.Config.User == $user)
    and (.Config.Labels["io.tiangong.owner"] == "runner-isolation-spike")
    and (.Config.Labels["io.tiangong.run-id"] == $run_id)
    and (.HostConfig.NetworkMode == "none")
    and (.HostConfig.ReadonlyRootfs == true)
    and (.HostConfig.CapDrop == ["ALL"])
    and (.HostConfig.SecurityOpt == ["no-new-privileges"])
    and (.HostConfig.PidsLimit == 128)
    and (.HostConfig.Memory == 268435456)
    and ((.Config.Env | map(split("=")[0])) as $names | all($forbidden_env[]; . as $forbidden | $names | index($forbidden) == null))
    and (.Mounts | length == 2)
    and (any(.Mounts[]; .Type == "volume" and .Name == $fixture_volume and .Destination == "/workspace/fixture" and .RW == false))
    and (any(.Mounts[]; .Type == "volume" and .Name == $scratch_volume and .Destination == "/workspace/scratch" and .RW == true))
' >/dev/null; then
  docker inspect "${CONTAINER_NAME}" | jq '
    .[0]
    | {
        Image,
        Config: {User: .Config.User, Labels: .Config.Labels, EnvKeys: (.Config.Env | map(split("=")[0]))},
        HostConfig: {
          NetworkMode: .HostConfig.NetworkMode,
          ReadonlyRootfs: .HostConfig.ReadonlyRootfs,
          CapDrop: .HostConfig.CapDrop,
          SecurityOpt: .HostConfig.SecurityOpt,
          PidsLimit: .HostConfig.PidsLimit,
          Memory: .HostConfig.Memory
        },
        Mounts: (.Mounts | map({Type, Name, Destination, RW}))
      }
  ' >&2
  die "runner daemon policy inspection failed"
fi
log "runner_daemon_policy=pass"

docker start --attach "${CONTAINER_NAME}"
[[ "$(docker inspect --format '{{.State.ExitCode}}' "${CONTAINER_NAME}")" == "0" ]] || die "runner probe exited non-zero"
docker cp "${CONTAINER_NAME}:/workspace/scratch/result.json" "${ARTIFACT_DIR}/result.actual.json"

EXPECTED_FIXTURE_SHA256="$(sha256sum "${FIXTURE_DIR}/input.txt" | awk '{print $1}')"
readonly EXPECTED_FIXTURE_SHA256
jq -e \
  --arg run_id "${RUN_ID}" \
  --arg fixture_sha256 "${EXPECTED_FIXTURE_SHA256}" '
  .runId == $run_id
  and .fixtureSha256 == $fixture_sha256
  and .credentialKeysAbsent == true
  and .fixtureReadOnly == true
  and .rootFilesystemReadOnly == true
  and .runtimeSocketAbsent == true
  and .networkLoopbackOnly == true
  and .controlPlaneNamesUnresolved == true
' "${ARTIFACT_DIR}/result.actual.json" >/dev/null
log "runner_machine_evidence=pass run_id=${RUN_ID} image_id=${IMAGE_ID}"
