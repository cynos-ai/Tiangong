#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker:dev"
readonly REVIEWER_IMAGE="tiangong-worker-reviewer:dev"
readonly EXPECTED_NODE_VERSION="v22.23.1"
readonly EXPECTED_PI_VERSION="0.82.0"

command -v docker >/dev/null 2>&1 || {
  printf 'ERROR: docker is required.\n' >&2
  exit 1
}

docker info >/dev/null 2>&1 || {
  printf 'ERROR: the Docker daemon is unavailable.\n' >&2
  exit 1
}

build_args=(--pull)
if [[ -n "${TIANGONG_OTEL_EXPORTER_ENDPOINT:-}" ]]; then
  build_args+=(--build-arg "TIANGONG_OTEL_EXPORTER_ENDPOINT=${TIANGONG_OTEL_EXPORTER_ENDPOINT}")
fi

printf '[Tiangong] Building %s\n' "${IMAGE}"
docker build "${build_args[@]}" --target default --tag "${IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building trusted profile image %s\n' "${REVIEWER_IMAGE}"
docker build "${build_args[@]}" --target reviewer --tag "${REVIEWER_IMAGE}" "${REPO_ROOT}/worker"

actual_node_version="$(docker run --rm --entrypoint node "${IMAGE}" --version)"
[[ "${actual_node_version}" == "${EXPECTED_NODE_VERSION}" ]] || {
  printf 'ERROR: expected Node.js %s, got %s.\n' "${EXPECTED_NODE_VERSION}" "${actual_node_version}" >&2
  exit 1
}

actual_pi_version="$(docker run --rm --entrypoint pi "${IMAGE}" --version)"
[[ "${actual_pi_version}" == "${EXPECTED_PI_VERSION}" ]] || {
  printf 'ERROR: expected pi %s, got %s.\n' "${EXPECTED_PI_VERSION}" "${actual_pi_version}" >&2
  exit 1
}

actual_flock_version="$(docker run --rm --entrypoint /usr/bin/flock "${IMAGE}" --version)"
grep -Fq 'flock from util-linux ' <<<"${actual_flock_version}" || {
  printf 'ERROR: the Worker image lacks the required util-linux kernel flock binding.\n' >&2
  exit 1
}

docker run --rm --workdir /opt/tiangong-worker --entrypoint node "${IMAGE}" \
  --input-type=module -e '
    import {
      createWorkerObservability,
      resolveObservabilityConfig,
    } from "./observability/tracing.mjs";
    const config = resolveObservabilityConfig(undefined, process.env);
    const expected = Boolean(process.env.TIANGONG_OTEL_EXPORTER_ENDPOINT);
    if (config.enabled !== expected) process.exit(1);
    const observability = createWorkerObservability({ config });
    await observability.shutdown();
  '
docker run --rm --workdir /opt/tiangong-worker --entrypoint node "${IMAGE}" \
  --input-type=module -e '
    import { mkdir, rm } from "node:fs/promises";
    import { CapturedArtifactStore } from "./agent/artifacts/store.mjs";
    import { sha256 } from "./agent/canonical-json.mjs";
    const stateDirectory = "/tmp/tiangong-artifact-image-contract";
    await mkdir(stateDirectory, { mode: 0o700 });
    try {
      const store = new CapturedArtifactStore({ stateDirectory, sessionId: "image-contract" });
      const binding = {
        kind: "practice_target",
        sessionHash: store.sessionHash,
        actorId: "@image:example.test",
        practiceRunId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        targetId: "target-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        invocationIdentity: sha256("image-invocation"),
        sourceOperationDigest: sha256("image-operation"),
      };
      const receipt = await store.put({
        binding,
        purpose: "review_target_chunk",
        ordinal: 0,
        mediaType: "text/plain;charset=utf-8",
        encoding: "utf-8",
        truncated: false,
        producerId: "review-target-consume",
        producerVersion: 1,
        transformVersion: 1,
        canonicalBytes: Buffer.from("image contract\n"),
      });
      const expectedContentIdentity = Object.fromEntries([
        "purpose", "ordinal", "contentDigest", "contentBytes", "contentLines",
        "mediaType", "encoding", "truncated", "producerId", "producerVersion",
        "transformVersion",
      ].map((key) => [key, receipt[key]]));
      const resolved = await store.readFromEvidence({
        artifactRefDigest: receipt.artifactRefDigest,
        artifactKey: receipt.artifactKey,
        expectedBinding: binding,
        expectedContentIdentity,
      });
      if (resolved.bytes.toString("utf8") !== "image contract\n") process.exit(1);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  '

reconciliation_help="$(docker run --rm --entrypoint tiangong-reconcile "${IMAGE}" --help)"
grep -Fq 'tiangong-reconcile inspect' <<<"${reconciliation_help}" || {
  printf 'ERROR: the Worker reconciliation entrypoint is unavailable.\n' >&2
  exit 1
}
retention_help="$(docker run --rm --entrypoint tiangong-retain "${IMAGE}" --help)"
grep -Fq 'tiangong-retain compact' <<<"${retention_help}" || {
  printf 'ERROR: the Worker retention entrypoint is unavailable.\n' >&2
  exit 1
}

kernel_profile="$(docker run --rm --entrypoint node "${IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role kernel)"
reviewer_profile="$(docker run --rm --entrypoint node "${REVIEWER_IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role reviewer)"
docker run --rm --workdir /opt/tiangong-worker --entrypoint node "${REVIEWER_IMAGE}" \
  --input-type=module -e '
    const [
      { CapturedArtifactStore },
      { loadFixedRoleProfileBundle },
      { EvidenceRecorder },
      { ReviewerPracticeGate },
      { PracticeRunService },
      { TurnContextController },
      { createReviewerToolRegistry },
    ] = await Promise.all([
      import("./agent/artifacts/store.mjs"),
      import("./agent/config/role-profile.mjs"),
      import("./agent/evidence/recorder.mjs"),
      import("./agent/gates/reviewer-practice-gate.mjs"),
      import("./agent/practices/practice-run-service.mjs"),
      import("./agent/turn-context.mjs"),
      import("./agent/work/reviewer-tools.mjs"),
    ]);
    const profileBundle = await loadFixedRoleProfileBundle();
    const turns = new TurnContextController();
    const stateDirectory = "/tmp/tiangong-image-contract-state";
    const service = new PracticeRunService({
      sessionId: "image-contract",
      workspaceDir: "/root/hiclaw-fs",
      profileBundle,
      journalPath: "/tmp/tiangong-image-contract/events.jsonl",
      snapshotPath: "/tmp/tiangong-image-contract/snapshot.json",
      protectedDirectory: "/tmp/tiangong-image-contract/protected",
      artifactStore: new CapturedArtifactStore({ stateDirectory, sessionId: "image-contract" }),
    });
    const registry = createReviewerToolRegistry({
      workspaceDir: "/root/hiclaw-fs",
      service,
      gate: new ReviewerPracticeGate({ profileBundle }),
      evidence: new EvidenceRecorder({ filePath: "/tmp/tiangong-image-contract/evidence.jsonl" }),
      getInvocation: turns.current,
      inspectionLockPath: "/tmp/tiangong-image-contract/directory-inspection-lock-target",
    });
    if (registry.names().join(",") !== "start_work,extend_scope,read,inspect_directory,check_completion,abandon_work") process.exit(1);
  '
node -e '
  const [kernel, reviewer] = process.argv.slice(1).map(JSON.parse);
  if (kernel.roleId !== "kernel" || kernel.runtimeReady !== true) process.exit(1);
  if (reviewer.roleId !== "reviewer" || reviewer.runtimeReady !== true) process.exit(1);
  if (reviewer.schemaVersion !== 2 || reviewer.targetKindIds.join(",") !== "file,directory_snapshot") process.exit(1);
  if (reviewer.materializedTargetKindIds.join(",") !== "file,directory_snapshot") process.exit(1);
  if (reviewer.toolIds.join(",") !== "start_work,extend_scope,read,inspect_directory,check_completion,abandon_work") process.exit(1);
  if (reviewer.materializedToolIds.join(",") !== "start_work,extend_scope,read,inspect_directory,check_completion,abandon_work") process.exit(1);
' "${kernel_profile}" "${reviewer_profile}"

printf '[Tiangong] Worker image ready: %s (Node.js %s, pi %s, fixed kernel profile)\n' \
  "${IMAGE}" "${actual_node_version}" "${actual_pi_version}"
printf '[Tiangong] Reviewer profile image validated: %s (runtimeReady=true; deterministic Reviewer slice)\n' \
  "${REVIEWER_IMAGE}"
