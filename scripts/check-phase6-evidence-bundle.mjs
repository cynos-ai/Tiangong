#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_MANIFEST = "smoke-testing/runs/2026-08-05-phase6-evidence-bundle/manifest.json";
const ALLOWED_OUTCOMES = new Set(["DELIVERED", "FAILED_SAFE", "RECOVERY_REQUIRED", "FAIL_CLOSED"]);

function fail(message) {
  throw new Error(`PHASE6_EVIDENCE_INVALID: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function repositoryPath(path, field) {
  assert(typeof path === "string" && path.length > 0, `${field} must be a non-empty path`);
  const absolute = resolve(ROOT, path);
  const relativePath = relative(ROOT, absolute);
  const escaped = relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\");
  assert(!escaped, `${field} escapes the repository: ${path}`);
  return absolute;
}

async function sha256(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function main() {
  const manifestPath = process.argv[2] || DEFAULT_MANIFEST;
  const manifest = JSON.parse(await readFile(repositoryPath(manifestPath, "manifest"), "utf8"));

  assert(manifest.kind === "tiangong.phase6-evidence-bundle", "unexpected bundle kind");
  assert(manifest.schemaVersion === 2, "unsupported bundle schema version");
  assert(manifest.status === "pass" && manifest.acceptance === "accepted", "bundle is not accepted");
  assert(manifest.acceptanceCriterion?.id === "safe-convergence-v1", "safe-convergence criterion is not selected");
  assert(manifest.acceptanceCriterion.nominalDeliveredRequired === false, "nominal DELIVERED requirement must be explicit");
  assert(Array.isArray(manifest.acceptanceCriterion.allowedRunOutcomes), "allowed outcome list is missing");
  for (const outcome of ALLOWED_OUTCOMES) {
    assert(manifest.acceptanceCriterion.allowedRunOutcomes.includes(outcome), `allowed outcome missing: ${outcome}`);
  }

  assert(Array.isArray(manifest.runs) && manifest.runs.length >= 3, "run evidence is incomplete");
  for (const run of manifest.runs) {
    assert(typeof run.id === "string" && run.id.length > 0, "run id is missing");
    assert(ALLOWED_OUTCOMES.has(run.machineDisposition), `invalid outcome for ${run.id}`);
    repositoryPath(run.path, `${run.id}.path`);
    if (run.verification) repositoryPath(run.verification, `${run.id}.verification`);
    if (run.machineDisposition === "FAIL_CLOSED") {
      assert(typeof run.stableErrorCode === "string" && run.stableErrorCode.length > 0, `${run.id} has no stable error code`);
      const sideEffects = run.downstreamSideEffects;
      assert(sideEffects && Object.values(sideEffects).every((value) => value === false), `${run.id} has an unproven downstream side effect`);
    }
  }

  const cleanRerun = manifest.independentVerification?.independentCleanRerun;
  assert(cleanRerun?.status === "pass" && cleanRerun.acceptedOutcome === "FAIL_CLOSED", "independent clean rerun is not accepted");
  assert(manifest.independentVerification?.teammateIndependentRerun?.status === "deferred", "teammate-rerun decision is not explicit");
  assert(manifest.cleanup?.status === "pass", "cleanup is not proven");

  let artifactsVerified = 0;
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, "artifact digest index is empty");
  for (const artifact of manifest.artifacts) {
    const path = repositoryPath(artifact.path, "artifact.path");
    assert(/^[a-f0-9]{64}$/u.test(artifact.sha256), `invalid artifact digest: ${artifact.path}`);
    assert(await sha256(path) === artifact.sha256, `artifact digest mismatch: ${artifact.path}`);
    artifactsVerified += 1;
  }

  process.stdout.write(`${JSON.stringify({
    status: "pass",
    criterion: manifest.acceptanceCriterion.id,
    runs: manifest.runs.length,
    artifactsVerified,
    independentCleanRerun: cleanRerun.acceptedOutcome,
    teammateIndependentRerun: manifest.independentVerification.teammateIndependentRerun.status,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
