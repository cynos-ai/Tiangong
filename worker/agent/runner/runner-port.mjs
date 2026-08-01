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

  if (deps?.env) {
    assertNoForbiddenEnv(deps.env);
  }

  let raw;
  try {
    raw = await deps.executor({ ...validated, env: deps?.env });
  } catch (error) {
    if (journal) await journal.recordUncertain(key, error?.message ?? "executor threw");
    return { outcome: "outcome_uncertain", invocationKey: key, reason: error?.message ?? "executor threw" };
  }

  if (raw?.status === "interrupted") {
    if (journal) await journal.recordUncertain(key, "command interrupted");
    return { outcome: "outcome_uncertain", invocationKey: key, reason: "command interrupted" };
  }

  const result = {
    outcome: "completed",
    invocationKey: key,
    exitCode: raw.exitCode,
    stdout: truncate(raw.stdout, validated.outputLimitBytes),
    stderr: truncate(raw.stderr, validated.outputLimitBytes),
    durationMs: raw.durationMs ?? null,
  };
  if (journal) await journal.record(key, result);
  return { ...result, replayed: false };
}
