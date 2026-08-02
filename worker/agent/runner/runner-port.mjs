import { sha256 } from "../canonical-json.mjs";
import { assertNoForbiddenEnv, validateCommandRequest } from "./runner-policy.mjs";

// RunnerPort: run a validated command in the run-owned disposable runner,
// bound by the isolation policy. A completed command can be replayed from the
// idempotency journal; an interrupted command is marked outcome_uncertain and
// is never retried automatically.

function truncate(value, limit) {
  const text = typeof value === "string" ? value : "";
  if (Buffer.byteLength(text) <= limit) return text;
  const trimmed = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8");
  return `${trimmed}\n[truncated at ${limit} bytes]`;
}

function invocationKey(validated) {
  return sha256({
    runId: validated.runId,
    command: validated.command,
    cwd: validated.cwd,
  });
}

function validateRunnerEvidence(value, validated, key) {
  if (value === undefined) return undefined;
  if (
    value === null || typeof value !== "object" || value.schemaVersion !== 1 ||
    value.runId !== validated.runId || value.invocationKey !== key ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.imageId) ||
    !/^[0-9a-f]{64}$/u.test(value.policyDigest) ||
    !/^[0-9a-f]{64}$/u.test(value.containerConfigDigest) ||
    !/^[0-9a-f]{64}$/u.test(value.fixtureDigest)
  ) {
    throw new Error("RUNNER_EVIDENCE_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: value.runId,
    invocationKey: value.invocationKey,
    imageId: value.imageId,
    policyDigest: value.policyDigest,
    containerConfigDigest: value.containerConfigDigest,
    fixtureDigest: value.fixtureDigest,
  });
}

export async function runCommand(request, deps) {
  const validated = validateCommandRequest(request);
  const key = invocationKey(validated);
  const journal = deps?.journal;

  if (journal) {
    const saved = await journal.lookup(key);
    if (saved?.status === "completed") {
      return { ...saved.result, replayed: true };
    }
    if (saved?.status === "outcome_uncertain") {
      return { outcome: "outcome_uncertain", invocationKey: key, reason: saved.reason, replayed: true };
    }
  }

  if (typeof deps?.executor !== "function") {
    const error = new Error("RunnerPort has no validated disposable executor");
    error.code = "TIANGONG_RUNNER_UNAVAILABLE";
    throw error;
  }
  if (deps?.env === null || typeof deps?.env !== "object") {
    throw new TypeError("RunnerPort requires an explicit sanitized environment");
  }
  assertNoForbiddenEnv(deps.env);

  let raw;
  try {
    raw = await deps.executor({
      ...validated,
      invocationKey: key,
      env: Object.freeze({ ...deps.env }),
    });
  } catch {
    const reason = "RUNNER_EXECUTOR_FAILED";
    if (journal) await journal.recordUncertain(key, reason);
    return { outcome: "outcome_uncertain", invocationKey: key, reason };
  }

  if (raw?.status === "interrupted") {
    if (journal) await journal.recordUncertain(key, "command interrupted");
    return { outcome: "outcome_uncertain", invocationKey: key, reason: "command interrupted" };
  }

  if (raw?.status !== "completed" || !Number.isInteger(raw.exitCode) || raw.exitCode < 0 || raw.exitCode > 255) {
    const reason = "RUNNER_RESULT_INVALID";
    if (journal) await journal.recordUncertain(key, reason);
    return { outcome: "outcome_uncertain", invocationKey: key, reason };
  }

  let runnerEvidence;
  try {
    runnerEvidence = validateRunnerEvidence(raw.runnerEvidence, validated, key);
  } catch {
    const reason = "RUNNER_EVIDENCE_INVALID";
    if (journal) await journal.recordUncertain(key, reason);
    return { outcome: "outcome_uncertain", invocationKey: key, reason };
  }

  const result = {
    outcome: "completed",
    invocationKey: key,
    exitCode: raw.exitCode,
    stdout: truncate(raw.stdout, validated.outputLimitBytes),
    stderr: truncate(raw.stderr, validated.outputLimitBytes),
    durationMs: raw.durationMs ?? null,
    ...(runnerEvidence ? { runnerEvidence } : {}),
  };
  if (journal) await journal.record(key, result);
  return { ...result, replayed: false };
}
