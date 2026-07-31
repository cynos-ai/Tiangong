#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker-reviewer:dev"
readonly WORKER_NAME="tiangong-reviewer-smoke"
readonly CONTAINER_NAME="agentteams-worker-${WORKER_NAME}"
readonly CONTROLLER_CONTAINER="agentteams-controller"
readonly MANAGER_CONTAINER="agentteams-manager"
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/reviewer-smoke-worker.yaml"
readonly BUILD_WORKER_IMAGE="${REPO_ROOT}/scripts/build-worker-image.sh"
readonly MATRIX_ROUNDTRIP="${SCRIPT_DIR}/matrix-reviewer-roundtrip.sh"
readonly STATE_ORACLE="${SCRIPT_DIR}/reviewer-state-oracle.mjs"
readonly ORACLE_POLICY="${SCRIPT_DIR}/reviewer-oracle-policy.mjs"
readonly MANAGER_MANIFEST="/tmp/tiangong-reviewer-smoke-worker.yaml"
readonly MANAGER_MATRIX_ROUNDTRIP="/tmp/tiangong-matrix-reviewer-roundtrip.sh"
readonly WORKER_STATE_ORACLE="/tmp/tiangong-reviewer-state-oracle.mjs"
readonly WORKER_ORACLE_POLICY="/tmp/reviewer-oracle-policy.mjs"
readonly SMOKE_LEVEL="${TIANGONG_REVIEWER_SMOKE_LEVEL:-recovery}"
created=0
room_id=""

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
  local mirror_path="/root/hiclaw-fs/agents/${WORKER_NAME}"
  docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force \
    "${storage_path}" >/dev/null 2>&1
  docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "${mirror_path}"
  docker exec "${MANAGER_CONTAINER}" rm -rf -- "${mirror_path}"
  ! docker exec "${CONTROLLER_CONTAINER}" mc ls "${storage_path}" 2>/dev/null | grep -q . &&
    ! docker exec "${CONTROLLER_CONTAINER}" test -e "${mirror_path}" &&
    ! docker exec "${MANAGER_CONTAINER}" test -e "${mirror_path}"
}

wait_for_worker_channel() {
  local since="$1" worker_logs
  for _ in $(seq 1 90); do
    worker_logs="$(docker logs --since "${since}" "${CONTAINER_NAME}" 2>&1 || true)"
    if [[ "$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}' 2>/dev/null)" == "true" ]] &&
        docker exec "${CONTAINER_NAME}" openclaw health >/dev/null 2>&1 &&
        grep -Fq "[matrix] joined room ${room_id}" <<<"${worker_logs}" &&
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
    "${MANAGER_MANIFEST}" "${MANAGER_MATRIX_ROUNDTRIP}" >/dev/null 2>&1 || cleanup_failed=1
  if docker exec "${MANAGER_CONTAINER}" test -e "${MANAGER_MANIFEST}" 2>/dev/null ||
      docker exec "${MANAGER_CONTAINER}" test -e "${MANAGER_MATRIX_ROUNDTRIP}" 2>/dev/null; then
    cleanup_failed=1
  fi
  if ((created == 1)); then
    log "Deleting temporary Reviewer Worker ${WORKER_NAME}"
    docker exec "${MANAGER_CONTAINER}" hiclaw delete worker "${WORKER_NAME}" >/dev/null 2>&1 || cleanup_failed=1
    for _ in $(seq 1 60); do
      if ! worker_json >/dev/null 2>&1 &&
          ! docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"; then
        break
      fi
      sleep 1
    done
    if worker_json >/dev/null 2>&1 ||
        docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"; then
      printf '[Tiangong] ERROR: temporary Reviewer Worker cleanup did not finish.\n' >&2
      cleanup_failed=1
    else
      purge_smoke_storage || cleanup_failed=1
    fi
  fi

  if ((cleanup_failed == 0)); then
    printf 'reviewer_cleanup=pass\n'
  else
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fixture_digest() {
  docker exec "${CONTAINER_NAME}" node -e '
    const { readFileSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

practice_paths() {
  local target="$1" agent_root="$2" journal session_hash
  journal="$(docker exec "${CONTAINER_NAME}" grep -RlF --include=events.jsonl \
    "\"${target}\"" "${agent_root}/.tiangong/runtime/practice-runs" || true)"
  [[ "$(grep -c . <<<"${journal}")" == "1" ]] || die "Expected exactly one PracticeRun journal for ${target}."
  session_hash="$(basename "$(dirname "${journal}")")"
  printf '%s\n%s\n%s\n' \
    "${journal}" \
    "$(dirname "${journal}")/snapshot.json" \
    "${agent_root}/.tiangong/runtime/evidence/${session_hash}/events.jsonl"
}

run_oracle() {
  docker exec "${CONTAINER_NAME}" node "${WORKER_STATE_ORACLE}" "$@"
}

assert_harness() {
  local phase="$1" harness
  harness="$(docker exec "${CONTAINER_NAME}" cat /tmp/tiangong-pi-harness.last-run)"
  grep -Fqx 'harness=tiangong-pi' <<<"${harness}" || die "Tiangong pi Harness was not selected."
  grep -Fqx 'provider=agentteams-gateway' <<<"${harness}" || die "Unexpected Reviewer provider."
  grep -Fqx 'model=qwen3.5-plus' <<<"${harness}" || die "Unexpected Reviewer model."
  grep -Fqx 'status=pass' <<<"${harness}" || die "Reviewer Harness did not complete."
  printf 'reviewer_harness_%s=pass\n' "${phase}"
}

diagnose_reviewer_state() {
  local journal_path="$1" evidence_path="$2" evidence_directory
  evidence_directory="$(dirname "${evidence_path}")"
  printf '[Tiangong] Sanitized Reviewer failure diagnostics:\n' >&2
  docker exec "${CONTAINER_NAME}" jq -sc '
    group_by([.eventType, .runRevision])
    | map({eventType:.[0].eventType,runRevision:.[0].runRevision,count:length})
  ' "${journal_path}" >&2 || true
  docker exec "${CONTAINER_NAME}" sh -c '
    find "$1" -maxdepth 1 -type f -name "events.jsonl*" -exec cat {} +
  ' _ "${evidence_directory}" | jq -sc '
    group_by([.toolName // "none", .type, .status // "none", .errorCode // "none"])
    | map({tool:.[0].toolName,type:.[0].type,status:(.[0].status // "none"),errorCode:(.[0].errorCode // "none"),count:length})
  ' >&2 || true
  docker exec "${CONTAINER_NAME}" sh -c '
    grep -E "^(harness|provider|model|status)=" /tmp/tiangong-pi-harness.last-run 2>/dev/null || true
  ' >&2 || true
}

wait_for_remote_journal() {
  local journal_path="$1" session_hash="$2" expected remote_path actual
  expected="$(fixture_digest "${journal_path}")"
  remote_path="agentteams/agentteams-storage/agents/${WORKER_NAME}/.tiangong/runtime/practice-runs/${session_hash}/events.jsonl"
  for _ in $(seq 1 90); do
    actual="$(docker exec "${CONTROLLER_CONTAINER}" sh -c \
      'mc cat "$1" 2>/dev/null | sha256sum | cut -d" " -f1' _ "${remote_path}" 2>/dev/null || true)"
    if [[ "${actual}" == "${expected}" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

[[ "${SMOKE_LEVEL}" == "basic" || "${SMOKE_LEVEL}" == "recovery" ||
    "${SMOKE_LEVEL}" == "journey" ]] ||
  die "TIANGONG_REVIEWER_SMOKE_LEVEL must be basic, recovery, or journey."
for command in docker jq grep; do
  command -v "${command}" >/dev/null 2>&1 || die "Missing required command: ${command}"
done
for file in "${MANIFEST}" "${MATRIX_ROUNDTRIP}" "${STATE_ORACLE}" "${ORACLE_POLICY}"; do
  [[ -f "${file}" ]] || die "Missing Reviewer smoke asset: ${file}"
done
[[ -x "${MATRIX_ROUNDTRIP}" ]] || die "Reviewer Matrix helper is not executable."
docker info >/dev/null 2>&1 || die "The Docker daemon is unavailable."
for container in "${MANAGER_CONTAINER}" "${CONTROLLER_CONTAINER}"; do
  [[ "$(docker inspect "${container}" --format '{{.State.Running}}' 2>/dev/null)" == "true" ]] ||
    die "${container} is not running."
done
if worker_json >/dev/null 2>&1 || docker ps -a --format '{{.Names}}' | grep -Fqx "${CONTAINER_NAME}"; then
  die "Reserved Reviewer smoke Worker already exists; refusing to replace it."
fi
purge_smoke_storage || die "Reserved Reviewer storage could not be made empty."

"${BUILD_WORKER_IMAGE}"
docker cp "${MANIFEST}" "${MANAGER_CONTAINER}:${MANAGER_MANIFEST}"
docker cp "${MATRIX_ROUNDTRIP}" "${MANAGER_CONTAINER}:${MANAGER_MATRIX_ROUNDTRIP}"
log "Creating temporary Reviewer Worker ${WORKER_NAME}"
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
      die "Reviewer Worker entered Failed phase."
      ;;
  esac
  sleep 3
done
[[ "${phase}" == "Running" ]] || die "Reviewer Worker did not reach Running phase within 240 seconds."
actual_image="$(docker inspect "${CONTAINER_NAME}" --format '{{.Config.Image}}')"
actual_image_id="$(docker inspect "${CONTAINER_NAME}" --format '{{.Image}}')"
expected_image_id="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
[[ "${actual_image}" == "${IMAGE}" && "${actual_image_id}" == "${expected_image_id}" ]] ||
  die "Reviewer Worker did not run the locally verified Reviewer image."
profile="$(docker exec "${CONTAINER_NAME}" node /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role reviewer)"
node -e '
  const profile = JSON.parse(process.argv[1]);
  const tools = "start_work,extend_scope,read,check_completion,abandon_work";
  if (profile.roleId !== "reviewer" || profile.runtimeReady !== true ||
      profile.toolIds.join(",") !== tools || profile.materializedToolIds.join(",") !== tools) process.exit(1);
' "${profile}" || die "Reviewer profile or active tool surface is invalid."
printf 'reviewer_image_id=%s\nreviewer_profile_digest=%s\nreviewer_tool_surface=pass\n' \
  "${actual_image_id}" "$(jq -r '.profileDigest' <<<"${profile}")"

worker_user_id="$(docker exec "${CONTAINER_NAME}" jq -r '.channels.matrix.userId // empty' \
  "/root/hiclaw-fs/agents/${WORKER_NAME}/openclaw.json")"
room_id="$(docker exec "${CONTAINER_NAME}" printenv AGENTTEAMS_WORKER_ROOM_ID)"
[[ -n "${worker_user_id}" && -n "${room_id}" ]] || die "Reviewer Matrix identity is incomplete."
wait_for_worker_channel 0 || die "Reviewer Matrix channel did not become ready."
docker cp "${STATE_ORACLE}" "${CONTAINER_NAME}:${WORKER_STATE_ORACLE}"
docker cp "${ORACLE_POLICY}" "${CONTAINER_NAME}:${WORKER_ORACLE_POLICY}"

nonce="$(cat /proc/sys/kernel/random/uuid)"
agent_root="/root/hiclaw-fs/agents/${WORKER_NAME}"
if [[ "${SMOKE_LEVEL}" == "basic" ]]; then
  target="reviewer-basic-${nonce}.txt"
  target_path="${agent_root}/${target}"
  printf 'harmless-reviewer-basic:%s' "${nonce}" | docker exec -i "${CONTAINER_NAME}" \
    sh -c 'umask 077; cat >"$1"' _ "${target_path}"
  digest="$(fixture_digest "${target_path}")"
  log "Running Reviewer Basic Matrix turn"
  output="$(docker exec "${MANAGER_CONTAINER}" "${MANAGER_MATRIX_ROUNDTRIP}" \
    basic "${room_id}" "${worker_user_id}" "${nonce}")"
  printf '%s\n' "${output}"
  mapfile -t paths < <(practice_paths "${target}" "${agent_root}")
  oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
    "${target}" "${digest}" - - done 1 1 all)"
  printf '%s\n' "${oracle}"
  [[ "$(jq -r '.status' <<<"${oracle}")" == "done" &&
      "$(jq -r '.checkpoint' <<<"${oracle}")" == "passed" ]] || die "Reviewer Basic oracle failed."
  printf 'reviewer_basic_machine_oracle=pass\n'
  assert_harness basic
else
  target_a="reviewer-recovery-a-${nonce}.txt"
  target_b="reviewer-recovery-b-${nonce}.txt"
  path_a="${agent_root}/${target_a}"
  path_b="${agent_root}/${target_b}"
  printf 'harmless-reviewer-recovery-a:%s' "${nonce}" | docker exec -i "${CONTAINER_NAME}" \
    sh -c 'umask 077; cat >"$1"' _ "${path_a}"
  digest_a="$(fixture_digest "${path_a}")"

  log "Starting Reviewer recovery run with file A"
  start_output="$(docker exec "${MANAGER_CONTAINER}" "${MANAGER_MATRIX_ROUNDTRIP}" \
    recovery-start "${room_id}" "${worker_user_id}" "${nonce}")"
  printf '%s\n' "${start_output}"
  mapfile -t paths < <(practice_paths "${target_a}" "${agent_root}")
  start_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
    "${target_a}" "${digest_a}" - - active 1 1 a-only)"
  printf '%s\n' "${start_oracle}"

  printf 'harmless-reviewer-recovery-b:%s' "${nonce}" | docker exec -i "${CONTAINER_NAME}" \
    sh -c 'umask 077; cat >"$1"' _ "${path_b}"
  digest_b="$(fixture_digest "${path_b}")"
  log "Appending file B in a later Matrix turn"
  extend_output="$(docker exec "${MANAGER_CONTAINER}" "${MANAGER_MATRIX_ROUNDTRIP}" \
    recovery-extend "${room_id}" "${worker_user_id}" "${nonce}")"
  printf '%s\n' "${extend_output}"
  extend_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
    "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" active 2 2 a-only)"
  printf '%s\n' "${extend_oracle}"
  for field in runId objectiveDigest criteriaDigest; do
    [[ "$(jq -r ".${field}" <<<"${start_oracle}")" == "$(jq -r ".${field}" <<<"${extend_oracle}")" ]] ||
      die "Reviewer ${field} changed during scope extension."
  done
  assert_harness pre_restart

  journal_digest_before_restart="$(fixture_digest "${paths[0]}")"
  session_hash="$(basename "$(dirname "${paths[0]}")")"
  wait_for_remote_journal "${paths[0]}" "${session_hash}" ||
    die "Current PracticeRun journal did not become durable in the owned storage prefix."
  printf 'reviewer_recovery_practice_remote_durable=pass\n'
  snapshot_remote="agentteams/agentteams-storage/agents/${WORKER_NAME}/.tiangong/runtime/practice-runs/${session_hash}/snapshot.json"
  log "Stopping after derived snapshot deletion to prove journal-owned recovery"
  restart_started="$(date +%s)"
  docker exec "${CONTAINER_NAME}" rm -f -- "${paths[1]}"
  if docker exec "${CONTAINER_NAME}" test -e "${paths[1]}"; then
    die "Derived PracticeRun snapshot remained locally before restart."
  fi
  docker stop "${CONTAINER_NAME}" >/dev/null
  docker exec "${CONTROLLER_CONTAINER}" mc rm --force "${snapshot_remote}" >/dev/null 2>&1
  docker exec "${CONTROLLER_CONTAINER}" rm -f -- \
    "/root/hiclaw-fs/agents/${WORKER_NAME}/.tiangong/runtime/practice-runs/${session_hash}/snapshot.json"
  docker exec "${MANAGER_CONTAINER}" rm -f -- \
    "/root/hiclaw-fs/agents/${WORKER_NAME}/.tiangong/runtime/practice-runs/${session_hash}/snapshot.json"
  if docker exec "${CONTROLLER_CONTAINER}" mc stat "${snapshot_remote}" >/dev/null 2>&1; then
    die "Derived PracticeRun snapshot could not be removed from owned storage before restart."
  fi
  docker start "${CONTAINER_NAME}" >/dev/null
  wait_for_worker_channel "${restart_started}" || die "Reviewer Worker did not become ready after restart."
  if ! recovered_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
      "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" active 2 2 a-only)"; then
    printf '[Tiangong] ERROR: post-restart journal digest=%s expected=%s\n' \
      "$(fixture_digest "${paths[0]}" 2>/dev/null || true)" "${journal_digest_before_restart}" >&2
    die "PracticeRun did not validate after snapshot deletion and restart."
  fi
  journal_digest_after_restart="$(fixture_digest "${paths[0]}")"
  [[ "${journal_digest_after_restart}" == "${journal_digest_before_restart}" ]] ||
    die "PracticeRun journal changed during snapshot deletion or restart."
  docker exec "${CONTAINER_NAME}" test -f "${paths[1]}" || die "PracticeRun snapshot was not rebuilt from journal."
  [[ "$(jq -r '.runId' <<<"${recovered_oracle}")" == "$(jq -r '.runId' <<<"${start_oracle}")" ]] ||
    die "Restart did not recover the original PracticeRun."
  for field in runId objectiveDigest criteriaDigest evidenceTerminalHash evidenceTerminalSequence; do
    [[ "$(jq -r ".${field}" <<<"${extend_oracle}")" == "$(jq -r ".${field}" <<<"${recovered_oracle}")" ]] ||
      die "Reviewer ${field} changed during machine recovery."
  done
  printf 'reviewer_recovery_snapshot_rebuilt=pass\n'
  printf 'reviewer_recovery_journal_recovery=pass\n'
  printf 'reviewer_recovery_machine_oracle=pass\n'

  if [[ "${SMOKE_LEVEL}" == "recovery" ]]; then
    printf 'reviewer_recovery_result=PASS\n'
  else
    log "Journey canary: reading file B after recovery"
    journey_continue=1
    if ! read_output="$(docker exec "${MANAGER_CONTAINER}" "${MANAGER_MATRIX_ROUNDTRIP}" \
        journey-read "${room_id}" "${worker_user_id}" "${nonce}")"; then
      diagnose_reviewer_state "${paths[0]}" "${paths[2]}"
      safety_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
        "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" active 2 2 safe-active)" ||
        die "Journey read failure did not leave a verifiably safe active run."
      printf '%s\nreviewer_journey_result=INCONCLUSIVE\n' "${safety_oracle}"
      journey_continue=0
    else
      printf '%s\n' "${read_output}"
      if ! read_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
          "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" active 2 2 all-at-least-once)"; then
        diagnose_reviewer_state "${paths[0]}" "${paths[2]}"
        safety_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
          "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" active 2 2 safe-active)" ||
          die "Invalid Journey read did not leave a verifiably safe active run."
        printf '%s\nreviewer_journey_result=NO_VALID_READ_EVIDENCE\n' "${safety_oracle}"
        journey_continue=0
      else
        [[ "$(jq -r '.runId' <<<"${read_oracle}")" == "$(jq -r '.runId' <<<"${start_oracle}")" ]] ||
          die "Post-restart read did not remain in the original PracticeRun."
        printf 'reviewer_journey_post_restart_read=pass\n'
      fi
    fi

    if ((journey_continue == 1)); then
      log "Journey canary: checking completion in a separate final Matrix turn"
      if ! complete_output="$(docker exec "${MANAGER_CONTAINER}" "${MANAGER_MATRIX_ROUNDTRIP}" \
          journey-check "${room_id}" "${worker_user_id}" "${nonce}")"; then
        diagnose_reviewer_state "${paths[0]}" "${paths[2]}"
        safety_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
          "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" active 2 2 all-at-least-once)" ||
          die "Journey completion failure did not leave a verifiably safe active run."
        printf '%s\nreviewer_journey_result=INCONCLUSIVE\n' "${safety_oracle}"
      else
        printf '%s\n' "${complete_output}"
        if ! final_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
            "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" done 2 2 all-at-least-once)"; then
          diagnose_reviewer_state "${paths[0]}" "${paths[2]}"
          safety_oracle="$(run_oracle "${paths[0]}" "${paths[1]}" "${paths[2]}" \
            "${target_a}" "${digest_a}" "${target_b}" "${digest_b}" active 2 2 all-at-least-once)" ||
            die "Journey completion could not be classified as safe no-progress."
          printf '%s\nreviewer_journey_result=NO_VALID_COMPLETION\n' "${safety_oracle}"
        else
          printf '%s\n' "${final_oracle}"
          for field in runId objectiveDigest criteriaDigest; do
            [[ "$(jq -r ".${field}" <<<"${start_oracle}")" == "$(jq -r ".${field}" <<<"${final_oracle}")" ]] ||
              die "Reviewer ${field} changed across restart and completion."
          done
          [[ "$(jq -r '.scopeRevisedCount' <<<"${final_oracle}")" == "1" &&
              "$(jq -r '.runCompletedCount' <<<"${final_oracle}")" == "1" &&
              "$(jq -r '.checkpointScopeDigest == .scopeDigest' <<<"${final_oracle}")" == "true" ]] ||
            die "Reviewer journey transition or final-scope oracle failed."
          printf 'reviewer_journey_machine_oracle=pass\n'
          printf 'reviewer_journey_result=PASS\n'
          assert_harness journey_terminal
        fi
      fi
    fi
  fi
fi

log "Reviewer ${SMOKE_LEVEL} verification completed with machine state and Evidence oracles."
