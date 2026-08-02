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

function invocationIdentity(validated) {
  return {
    contractVersion: "runner-command-v1",
    runId: validated.runId,
    command: validated.command,
    cwd: validated.cwd,
    timeoutMs: validated.timeoutMs,
    outputLimitBytes: validated.outputLimitBytes,
  };
}

export function runnerRunIdForTask(taskBinding) {
  const digest = taskBinding?.contentDigest;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new TypeError("Runner Task binding requires an immutable content digest");
  }
  const value = digest.slice(0, 32).split("");
  value[12] = "4";
  value[16] = ((Number.parseInt(value[16], 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `run-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function runnerInvocationIdentity(request) {
  const validated = validateCommandRequest(request);
  const operation = invocationIdentity(validated);
  const invocationKey = sha256(operation);
  return Object.freeze({
    validated,
    invocationKey,
    requestDigest: sha256({ ...operation, invocationKey }),
  });
}

function replayFromJournal(entry, key) {
  if (entry.status === "completed") return { ...entry.result, replayed: true };
  if (entry.status === "outcome_uncertain") {
    return { outcome: "outcome_uncertain", invocationKey: key, reason: entry.reason, replayed: true };
  }
  if (entry.status === "executing") {
    return {
      outcome: "outcome_uncertain",
      invocationKey: key,
      reason: "RUNNER_EXECUTION_IN_PROGRESS_OR_INTERRUPTED",
      replayed: true,
    };
  }
  throw new Error("RUNNER_JOURNAL_ENTRY_INVALID");
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
  const { validated, invocationKey: key, requestDigest } = runnerInvocationIdentity(request);
  const journal = deps?.journal;

  if (typeof deps?.executor !== "function") {
    const error = new Error("RunnerPort has no validated disposable executor");
    error.code = "TIANGONG_RUNNER_UNAVAILABLE";
    throw error;
  }
  if (deps?.env === null || typeof deps?.env !== "object") {
    throw new TypeError("RunnerPort requires an explicit sanitized environment");
  }
  assertNoForbiddenEnv(deps.env);

  if (journal) {
    if (typeof journal.begin !== "function" || typeof journal.complete !== "function" ||
        typeof journal.recordUncertain !== "function") {
      throw new TypeError("RunnerPort journal does not implement the durable execution contract");
    }
    const begun = await journal.begin(key, requestDigest);
    if (begun?.execute !== true) return replayFromJournal(begun?.entry, key);
  }

  let raw;
  try {
    raw = await deps.executor({
      ...validated,
      invocationKey: key,
      env: Object.freeze({ ...deps.env }),
    });
  } catch {
    const reason = "RUNNER_EXECUTOR_FAILED";
    if (journal) await journal.recordUncertain(key, requestDigest, reason);
    return { outcome: "outcome_uncertain", invocationKey: key, reason };
  }

  if (raw?.status === "interrupted") {
    const reason = "RUNNER_COMMAND_INTERRUPTED";
    if (journal) await journal.recordUncertain(key, requestDigest, reason);
    return { outcome: "outcome_uncertain", invocationKey: key, reason };
  }

  if (raw?.status !== "completed" || !Number.isInteger(raw.exitCode) || raw.exitCode < 0 || raw.exitCode > 255 ||
      typeof raw.stdout !== "string" || typeof raw.stderr !== "string" ||
      (raw.durationMs !== undefined && (!Number.isSafeInteger(raw.durationMs) || raw.durationMs < 0))) {
    const reason = "RUNNER_RESULT_INVALID";
    if (journal) await journal.recordUncertain(key, requestDigest, reason);
    return { outcome: "outcome_uncertain", invocationKey: key, reason };
  }

  let runnerEvidence;
  try {
    runnerEvidence = validateRunnerEvidence(raw.runnerEvidence, validated, key);
  } catch {
    const reason = "RUNNER_EVIDENCE_INVALID";
    if (journal) await journal.recordUncertain(key, requestDigest, reason);
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
  if (journal) {
    try {
      await journal.complete(key, requestDigest, result);
    } catch {
      const reason = "RUNNER_JOURNAL_COMPLETION_FAILED";
      try {
        await journal.recordUncertain(key, requestDigest, reason);
      } catch {
        // The executing record remains authoritative and blocks automatic replay.
      }
      return { outcome: "outcome_uncertain", invocationKey: key, reason };
    }
  }
  return { ...result, replayed: false };
}
