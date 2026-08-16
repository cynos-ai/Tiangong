// Code-owned recovery classification for a Worker restart. This is a local
// machine fact, not a model decision: an unresolved started phase is never
// treated as a safe retry merely because the process disappeared.

const ACTIVE_PHASES = new Set(["executing", "waiting_approval", "verifying"]);

export function classifyWorkRunRecovery(state, { ownerPresent = false } = {}) {
  if (!state || typeof state !== "object") {
    return Object.freeze({ status: "missing", action: "open" });
  }
  if (state.terminal === true || ["finalized", "abandoned"].includes(state.phase)) {
    return Object.freeze({ status: "terminal", action: "replay", phase: state.phase });
  }
  if (state.phase === "planned") {
    return Object.freeze({ status: "ready", action: "start", phase: state.phase });
  }
  if (state.phase === "blocked") {
    return Object.freeze({ status: "ready", action: "resume-after-policy", phase: state.phase });
  }
  if (ACTIVE_PHASES.has(state.phase)) {
    return Object.freeze({
      status: ownerPresent ? "owned" : "recovery_required",
      action: ownerPresent ? "continue" : "privileged-reconcile",
      phase: state.phase,
      reasonCode: ownerPresent ? undefined : "WORK_RUN_OWNER_LOST",
    });
  }
  return Object.freeze({ status: "recovery_required", action: "privileged-reconcile", phase: state.phase });
}
