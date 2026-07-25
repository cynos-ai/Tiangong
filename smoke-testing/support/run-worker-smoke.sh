#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker:dev"
readonly WORKER_NAME="tiangong-pi-smoke"
readonly CONTAINER_NAME="agentteams-worker-${WORKER_NAME}"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/pi-smoke-worker.yaml"
readonly BUILD_WORKER_IMAGE="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly MATRIX_ROUNDTRIP="${SCRIPT_DIR}/matrix-roundtrip.sh"
readonly MATRIX_APPROVAL_ROUNDTRIP="${SCRIPT_DIR}/matrix-approval-roundtrip.sh"
readonly MANAGER_MANIFEST="/tmp/tiangong-pi-smoke-worker.yaml"
readonly MANAGER_MATRIX_ROUNDTRIP="/tmp/tiangong-matrix-roundtrip.sh"
readonly MANAGER_MATRIX_APPROVAL_ROUNDTRIP="/tmp/tiangong-matrix-approval-roundtrip.sh"
readonly SMOKE_LEVEL="${TIANGONG_WORKER_SMOKE_LEVEL:-full}"
created=0

log() {
  printf '[Tiangong] %s\n' "$*"
}

die() {
  printf '[Tiangong] ERROR: %s\n' "$*" >&2
  exit 1
}

worker_json() {
  docker exec "${MANAGER_CONTAINER}" hiclaw get workers "${WORKER_NAME}" -o json 2>/dev/null
}

purge_smoke_storage() {
  local storage_path="agentteams/agentteams-storage/agents/${WORKER_NAME}/"
  docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
    "${storage_path}" >/dev/null 2>&1
  ! docker exec "${CONTROLLER_CONTAINER}" mc ls "${storage_path}" 2>/dev/null | grep -q .
}

wait_for_worker_channel() {
  local since="$1" worker_logs
  for _ in $(seq 1 90); do
    worker_logs="$(docker logs --since "${since}" "${CONTAINER_NAME}" 2>&1 || true)"
    if [[ "$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}' 2>/dev/null)" == "true" ]] && \
        docker exec "${CONTAINER_NAME}" openclaw health >/dev/null 2>&1 && \
        grep -Fq "[matrix] joined room ${room_id}" <<<"${worker_logs}" && \
        grep -Fq "worker/${WORKER_NAME} reported ready" <<<"${worker_logs}"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT INT TERM
  set +e

  docker exec "${MANAGER_CONTAINER}" rm -f \
    "${MANAGER_MANIFEST}" "${MANAGER_MATRIX_ROUNDTRIP}" \
    "${MANAGER_MATRIX_APPROVAL_ROUNDTRIP}" >/dev/null 2>&1
  if ((created == 1)); then
    log "Deleting temporary Worker ${WORKER_NAME}"
    docker exec "${MANAGER_CONTAINER}" hiclaw delete worker "${WORKER_NAME}" >/dev/null 2>&1 || cleanup_failed=1
    for _ in $(seq 1 60); do
      if ! worker_json >/dev/null 2>&1 && \
          ! docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"; then
        break
      fi
      sleep 1
    done
    if worker_json >/dev/null 2>&1 || \
        docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"; then
      printf '[Tiangong] ERROR: temporary Worker cleanup did not finish.\n' >&2
      cleanup_failed=1
    else
      purge_smoke_storage || cleanup_failed=1
    fi
  fi

  ((cleanup_failed == 0)) || status=1
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${SMOKE_LEVEL}" == "basic" || "${SMOKE_LEVEL}" == "full" ]] || \
  die "TIANGONG_WORKER_SMOKE_LEVEL must be basic or full."

for command in docker jq grep; do
  command -v "${command}" >/dev/null 2>&1 || die "Missing required command: ${command}"
done
[[ -f "${MANIFEST}" ]] || die "Missing Worker manifest: ${MANIFEST}"
[[ -x "${MATRIX_ROUNDTRIP}" ]] || die "Missing Matrix round-trip helper: ${MATRIX_ROUNDTRIP}"
[[ -x "${MATRIX_APPROVAL_ROUNDTRIP}" ]] || \
  die "Missing Matrix approval helper: ${MATRIX_APPROVAL_ROUNDTRIP}"
docker info >/dev/null 2>&1 || die "The Docker daemon is unavailable."
docker inspect "${MANAGER_CONTAINER}" >/dev/null 2>&1 || die "${MANAGER_CONTAINER} does not exist."
docker inspect "${CONTROLLER_CONTAINER}" >/dev/null 2>&1 || die "${CONTROLLER_CONTAINER} does not exist."
[[ "$(docker inspect "${MANAGER_CONTAINER}" --format '{{.State.Running}}')" == "true" ]] || \
  die "${MANAGER_CONTAINER} is not running."
[[ "$(docker inspect "${CONTROLLER_CONTAINER}" --format '{{.State.Running}}')" == "true" ]] || \
  die "${CONTROLLER_CONTAINER} is not running."

if worker_json >/dev/null 2>&1 || \
    docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"; then
  die "Reserved smoke Worker ${WORKER_NAME} already exists; refusing to replace it."
fi
purge_smoke_storage

"${BUILD_WORKER_IMAGE}"

docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
log "Creating temporary AgentTeams Worker ${WORKER_NAME}"
docker exec "${MANAGER_CONTAINER}" hiclaw apply -f "${MANAGER_MANIFEST}"
created=1

phase=""
for _ in $(seq 1 80); do
  resource="$(worker_json || true)"
  phase="$(jq -r '.phase // empty' <<<"${resource}" 2>/dev/null || true)"
  case "${phase}" in
    Running) break ;;
    Failed)
      printf '%s\n' "${resource}" >&2
      die "Worker entered Failed phase."
      ;;
  esac
  sleep 3
done
[[ "${phase}" == "Running" ]] || die "Worker did not reach Running phase within 240 seconds."

[[ "$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}' 2>/dev/null)" == "true" ]] || \
  die "Worker resource is Running but ${CONTAINER_NAME} is not."
actual_image="$(docker inspect "${CONTAINER_NAME}" --format '{{.Config.Image}}')"
[[ "${actual_image}" == "${IMAGE}" ]] || die "Expected image ${IMAGE}, got ${actual_image}."

actual_node_version="$(docker exec "${CONTAINER_NAME}" node --version)"
actual_pi_version="$(docker exec "${CONTAINER_NAME}" pi --version)"
[[ "${actual_node_version}" == "v22.23.1" ]] || die "Unexpected Node.js version: ${actual_node_version}."
[[ "${actual_pi_version}" == "0.82.0" ]] || die "Unexpected pi version: ${actual_pi_version}."
printf 'node_version=%s\npi_version=%s\n' "${actual_node_version}" "${actual_pi_version}"

worker_user_id="$(docker exec "${CONTAINER_NAME}" jq -r \
  '.channels.matrix.userId // empty' \
  "/root/hiclaw-fs/agents/${WORKER_NAME}/openclaw.json")"
room_id="$(docker exec "${CONTAINER_NAME}" printenv AGENTTEAMS_WORKER_ROOM_ID)"
[[ -n "${worker_user_id}" && -n "${room_id}" ]] || die "Worker Matrix identity is incomplete."
wait_for_worker_channel 0 || die "Worker Matrix channel did not become ready."
docker cp "${MATRIX_ROUNDTRIP}" "${MANAGER_CONTAINER}:${MANAGER_MATRIX_ROUNDTRIP}"
nonce="$(cat /proc/sys/kernel/random/uuid)"
agent_root="/root/hiclaw-fs/agents/${WORKER_NAME}"
read_target="matrix-read-probe-${nonce}.txt"
printf '%s' "${nonce}" | docker exec -i "${CONTAINER_NAME}" \
  sh -c 'umask 077; cat >"$1/$2"' _ "${agent_root}" "${read_target}"
log "Testing Matrix -> gated pi read -> Matrix round trip"
matrix_output="$(docker exec "${MANAGER_CONTAINER}" \
  "${MANAGER_MATRIX_ROUNDTRIP}" "${room_id}" "${worker_user_id}" "${nonce}" "${read_target}")"
printf '%s\n' "${matrix_output}"
grep -Fqx 'matrix_to_pi_response=pass' <<<"${matrix_output}" || die "Matrix-to-pi round trip failed."
read_evidence_files="$(docker exec "${CONTAINER_NAME}" grep -RlF --include=events.jsonl \
  "\"target\":\"${read_target}\"" \
  "${agent_root}/.tiangong/runtime/sessions" || true)"
[[ "$(grep -c . <<<"${read_evidence_files}")" == "1" ]] || \
  die "Expected exactly one Evidence chain for the Matrix read probe."
read_turn_id="$(docker exec "${CONTAINER_NAME}" jq -r --arg target "${read_target}" '
  select(.type == "gate.decided" and .toolName == "read" and .operation.target == $target)
  | .turnId
' "${read_evidence_files}")"
[[ -n "${read_turn_id}" ]] || die "Matrix read Gate evidence is missing."
read_execution_count="$(docker exec "${CONTAINER_NAME}" jq -s --arg turn "${read_turn_id}" '
  [.[] | select(
    .type == "tool.execution.completed" and
    .toolName == "read" and
    .turnId == $turn and
    .status == "success"
  )] | length
' "${read_evidence_files}")"
[[ "${read_execution_count}" == "1" ]] || die "Matrix read tool did not execute exactly once."
printf 'read_tool_event=pass\nfinal_response=pass\n'
harness_evidence="$(docker exec "${CONTAINER_NAME}" cat /tmp/tiangong-pi-harness.last-run)"
grep -Fqx 'harness=tiangong-pi' <<<"${harness_evidence}" || die "Tiangong pi harness was not selected."
grep -Fqx 'provider=agentteams-gateway' <<<"${harness_evidence}" || die "Unexpected pi harness provider."
grep -Fqx 'model=qwen3.5-plus' <<<"${harness_evidence}" || die "Unexpected pi harness model."
grep -Fqx 'status=pass' <<<"${harness_evidence}" || die "Pi harness did not complete successfully."
printf 'pi_harness_selection=pass\n'

log "Checking persistent session and in-memory-only credential boundary"
docker exec "${CONTAINER_NAME}" node --input-type=module -e '
  import { readFile, readdir } from "node:fs/promises";
  import { join } from "node:path";
  const worker = process.env.AGENTTEAMS_WORKER_NAME;
  const configPath = `/root/hiclaw-fs/agents/${worker}/openclaw.json`;
  const statePath = `/root/hiclaw-fs/agents/${worker}/.tiangong/runtime`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const credential = config.models.providers["agentteams-gateway"].apiKey;
  const runtimeDirectories = (await readdir("/tmp", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("tiangong-model-gateway-"));
  if (runtimeDirectories.length !== 1) throw new Error("expected exactly one Tiangong model runtime directory");
  const models = await readFile(join("/tmp", runtimeDirectories[0].name, "models.json"), "utf8");
  if (models.includes(credential) || /"(?:apiKey|headers|authorization)"/iu.test(models)) {
    throw new Error("credential-bearing fields entered the temporary model configuration");
  }
  const sessionFiles = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const candidate = join(path, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.name.endsWith(".jsonl")) sessionFiles.push(candidate);
    }
  }
  await walk(join(statePath, "sessions"));
  if (sessionFiles.length === 0) throw new Error("persistent pi session was not created");
  for (const file of sessionFiles) {
    if ((await readFile(file, "utf8")).includes(credential)) {
      throw new Error("Worker gateway credential entered a persistent session");
    }
  }
'
printf 'persistent_pi_session=pass\n'
printf 'runtime_credentials_in_memory=pass\n'

if [[ "${SMOKE_LEVEL}" == "basic" ]]; then
  log "Basic Worker smoke passed."
  exit 0
fi

approval_nonce="$(cat /proc/sys/kernel/random/uuid)"
approval_target="approval-probe-${approval_nonce}.txt"
docker cp "${MATRIX_APPROVAL_ROUNDTRIP}" \
  "${MANAGER_CONTAINER}:${MANAGER_MATRIX_APPROVAL_ROUNDTRIP}"
log "Requesting a gated write through Matrix"
pending_output="$(docker exec "${MANAGER_CONTAINER}" \
  "${MANAGER_MATRIX_APPROVAL_ROUNDTRIP}" request \
  "${room_id}" "${worker_user_id}" "${approval_nonce}")"
printf '%s\n' "${pending_output}"
approval_id="$(awk -F= '$1 == "approval_id" { print $2 }' <<<"${pending_output}")"
[[ "${approval_id}" =~ ^approval-[0-9a-f]{24}$ ]] || die "Invalid approval identifier."
if docker exec "${CONTAINER_NAME}" find "${agent_root}" -type f -name "${approval_target}" \
  -print -quit | grep -q .; then
  die "Pending write executed before approval."
fi

log "Restarting Worker before approval to verify pending recovery"
restart_started="$(date +%s)"
docker restart "${CONTAINER_NAME}" >/dev/null
wait_for_worker_channel "${restart_started}" || die "Worker did not become ready after restart."

log "Approving the persisted write through a later Matrix turn"
if ! approve_output="$(docker exec "${MANAGER_CONTAINER}" \
  "${MANAGER_MATRIX_APPROVAL_ROUNDTRIP}" approve \
  "${room_id}" "${worker_user_id}" "${approval_nonce}" "${approval_id}")"; then
  printf '[Tiangong] Approval diagnostics for %s:\n' "${approval_id}" >&2
  docker exec "${CONTAINER_NAME}" sh -lc '
    find "$1/.tiangong/runtime/sessions" -type f -name idempotency.json -exec \
      jq -c --arg id "$2" ".entries | to_entries[] | select(.value.approvalId == \$id) | {status:.value.status,errorCode:.value.errorCode}" {} +
  ' _ "${agent_root}" "${approval_id}" >&2 || true
  docker exec "${CONTAINER_NAME}" cat /tmp/tiangong-pi-harness.last-run >&2 || true
  docker logs --tail 80 "${CONTAINER_NAME}" 2>&1 | \
    grep -E 'embedded run done|ERROR|Error|error' >&2 || true
  die "Matrix approval turn failed."
fi
printf '%s\n' "${approve_output}"
target_path="$(docker exec "${CONTAINER_NAME}" find "${agent_root}" -type f \
  -name "${approval_target}" -print -quit)"
[[ -n "${target_path}" ]] || die "Approved write did not create its target."
[[ "$(docker exec "${CONTAINER_NAME}" cat "${target_path}")" == "${approval_nonce}" ]] || \
  die "Approved write content does not match."
printf 'matrix_write_restart_recovery=pass\n'

log "Replaying the same approval to verify exactly-once execution"
replay_output="$(docker exec "${MANAGER_CONTAINER}" \
  "${MANAGER_MATRIX_APPROVAL_ROUNDTRIP}" replay \
  "${room_id}" "${worker_user_id}" "${approval_nonce}" "${approval_id}")"
printf '%s\n' "${replay_output}"
evidence_files="$(docker exec "${CONTAINER_NAME}" grep -RlF --include=events.jsonl \
  "\"approvalId\":\"${approval_id}\"" \
  "${agent_root}/.tiangong/runtime/sessions" || true)"
[[ "$(grep -c . <<<"${evidence_files}")" == "1" ]] || \
  die "Expected exactly one Evidence chain for ${approval_id}."
evidence_file="${evidence_files}"
execution_count="$(docker exec "${CONTAINER_NAME}" jq -s \
  '[.[] | select(.type == "tool.execution.started" and .toolName == "write")] | length' \
  "${evidence_file}")"
replay_count="$(docker exec "${CONTAINER_NAME}" jq -s \
  '[.[] | select(.type == "tool.execution.replayed" and .toolName == "write")] | length' \
  "${evidence_file}")"
printf 'write_execution_count=%s\nwrite_replay_count=%s\n' \
  "${execution_count}" "${replay_count}"
[[ "${execution_count}" == "1" && "${replay_count}" == "1" ]] || \
  die "Approval replay was not exactly once."
printf 'matrix_write_exactly_once=pass\n'
if docker exec "${CONTAINER_NAME}" find \
  "${agent_root}/.tiangong/runtime/sessions" -type f -name write-content -print -quit | grep -q .; then
  die "Terminal write payload was not removed."
fi
printf 'terminal_write_payload_cleanup=pass\n'

log "Upstream Matrix, Worker-scoped gateway, and Tiangong pi harness passed."
