// Concern: a forward-looking, non-authoritative soft hint (architecture §11).
//
// A Concern points at an evidence gap, scope drift, or risk. It can NEVER
// authorize, complete, block, or mutate state — it is only returned for the
// runtime/SOUL to surface. Authoritative decisions come from Gate,
// Checkpoint+Evidence, and TransitionPolicy. This module has no side effects.

import { canonicalJson, sha256 } from "../canonical-json.mjs";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
export const CONCERN_SEVERITIES = Object.freeze(["info", "warning"]);
const SEVERITY_SET = new Set(CONCERN_SEVERITIES);
const MESSAGE_MAX = 1024;

function demandString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}
function demandPattern(value, name, pattern) {
  demandString(value, name);
  if (!pattern.test(value)) throw new Error(`${name} has an invalid format: ${value}`);
  return value;
}

export function createConcern(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("concern input must be an object");
  }
  if (!SEVERITY_SET.has(input.severity)) throw new Error(`Unsupported severity: ${input.severity}`);
  const message = demandString(input.message, "message");
  if (message.length > MESSAGE_MAX) throw new Error("message exceeds the maximum length");
  const base = {
    kind: "tiangong.concern",
    schemaVersion: 1,
    concernId: demandPattern(input.concernId, "concernId", ID_PATTERN),
    severity: input.severity,
    code: demandPattern(input.code, "code", ID_PATTERN),
    message,
    at: demandPattern(input.at, "at", ISO_PATTERN),
  };
  if (input.projectId !== undefined) base.projectId = demandPattern(input.projectId, "projectId", ID_PATTERN);
  if (input.taskId !== undefined) base.taskId = demandPattern(input.taskId, "taskId", ID_PATTERN);
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

// Deterministic Concern emitter over the current coordination state. Returns
// only non-authoritative hints; it reads state and never mutates it.
export function emitConcerns(state, { now } = {}) {
  const at = typeof now === "function" ? now() : new Date().toISOString();
  const concerns = [];
  let n = 0;
  const add = (severity, code, message, refs = {}) => {
    n += 1;
    concerns.push(
      createConcern({ concernId: `concern-${n}`, severity, code, message, at, ...refs }),
    );
  };

  const result = state?.resultEnvelope;
  if (result && !result.blocker && (result.claim || result.taskKind) && (result.evidenceRefs ?? []).length === 0) {
    add(
      "warning",
      "accept-without-evidence",
      `A ${result.taskKind ?? ""} result carries a claim but no Evidence refs; a claim is not Evidence.`,
      { projectId: result.projectId, taskId: result.taskId },
    );
  }
  if (result && (result.taskKind === "implement" || result.taskKind === "release") && !result.blocker && (result.artifactRefs ?? []).length === 0) {
    add(
      "warning",
      "claim-without-artifact",
      `${result.taskKind} result has no artifact refs to verify or deploy.`,
      { projectId: result.projectId, taskId: result.taskId },
    );
  }

  const chain = Array.isArray(state?.chain) ? state.chain : [];
  const maxRevisionWaves = Number.isInteger(state?.maxRevisionWaves) ? state.maxRevisionWaves : 2;
  const revisions = chain.filter((e) => e?.decision === "revision").length;
  if (revisions > 0 && revisions >= maxRevisionWaves - 1) {
    add(
      "warning",
      "revision-waves-nearly-exhausted",
      `Project has used ${revisions} of ${maxRevisionWaves} revision waves; another revision will BLOCK.`,
      state?.projectId ? { projectId: state.projectId } : {},
    );
  }

  if (state?.workRunPhase === "blocked") {
    add(
      "warning",
      "work-run-blocked",
      "A Worker WorkRun is blocked; recovery or abandonment is needed before further progress.",
      state?.taskId ? { taskId: state.taskId } : {},
    );
  }

  return Object.freeze(concerns);
}
