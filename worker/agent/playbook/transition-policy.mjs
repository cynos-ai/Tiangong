// Deterministic transition policy for the software-change-delivery TeamPlaybook.
//
// Pure functions over task-kind + decision + deploy/verify outcomes. No
// runtime state, no Practice model: this is the Phase-2-ready core that the
// closed TeamPlaybook resolver and the Leader wrap with immutable binding
// manifests (see worker/agent/team). maxRevisionWaves is fixed at 2; a
// revision beyond the limit, a blocker, or a timeout enters BLOCKED. A deploy
// whose post-verify fails rolls back to the previous digest; FAILED_SAFE
// requires the previous digest to verify, otherwise RECOVERY_REQUIRED.

export const TASK_KINDS = Object.freeze(["design", "implement", "assess", "release"]);
const TASK_KIND_INDEX = new Map(TASK_KINDS.map((kind, index) => [kind, index]));
export const MAX_REVISION_WAVES = 2;
export const DECISIONS = Object.freeze(["accept", "revision", "blocked"]);

export function nextTaskKindAfter({ taskKind, decision, revisionIndex }) {
  if (!TASK_KIND_INDEX.has(taskKind)) throw new Error(`Unknown task kind: ${taskKind}`);
  if (!Number.isInteger(revisionIndex) || revisionIndex < 0) {
    throw new TypeError("revisionIndex must be a non-negative integer");
  }
  if (decision === "blocked") return { status: "blocked" };
  switch (taskKind) {
    case "design":
      return decision === "accept"
        ? { status: "next", taskKind: "implement", revisionIndex: 0 }
        : { status: "blocked" };
    case "implement":
      return decision === "accept"
        ? { status: "next", taskKind: "assess", revisionIndex }
        : { status: "blocked" };
    case "assess":
      if (decision === "accept") {
        return { status: "next", taskKind: "release", revisionIndex };
      }
      if (decision === "revision") {
        if (revisionIndex + 1 >= MAX_REVISION_WAVES) return { status: "blocked" };
        return { status: "next", taskKind: "implement", revisionIndex: revisionIndex + 1 };
      }
      return { status: "blocked" };
    case "release":
      // release.accept hands off to the deploy/approval flow, not another task.
      return decision === "accept"
        ? { status: "awaiting_deploy", revisionIndex }
        : { status: "blocked" };
    default:
      return { status: "blocked" };
  }
}

// Deploy-side disposition. postVerify / rollback / verifyPrevious outcomes are
// the machine facts captured by the Operator adapter and Evidence.
export function dispositionForRelease({ postVerify, rollback, verifyPrevious }) {
  if (postVerify === "pass") return { disposition: "delivered" };
  if (postVerify === "fail") {
    if (rollback !== "done") return { disposition: "recovery_required" };
    if (verifyPrevious === "pass") return { disposition: "failed_safe" };
    if (verifyPrevious === "fail") return { disposition: "recovery_required" };
    return { disposition: "recovery_required" };
  }
  if (postVerify === "uncertain") return { disposition: "recovery_required" };
  return { disposition: "pending" };
}

// Reduce a chain of task decisions to the current chain head + whether the
// design→...→assess sequence is blocked or awaiting release.
export function reduceTaskChain(decisions) {
  if (!Array.isArray(decisions)) throw new TypeError("decisions must be an array");
  let revisionIndex = 0;
  let lastKind = "design";
  let lastDecision = null;
  for (const entry of decisions) {
    if (!entry || !TASK_KIND_INDEX.has(entry.taskKind)) {
      throw new Error(`Unknown task kind in chain: ${entry?.taskKind}`);
    }
    const step = nextTaskKindAfter({
      taskKind: entry.taskKind,
      decision: entry.decision,
      revisionIndex: entry.revisionIndex,
    });
    if (step.status === "blocked") {
      return { status: "blocked", at: entry };
    }
    if (step.status === "awaiting_deploy") {
      return { status: "awaiting_deploy", revisionIndex: entry.revisionIndex };
    }
    if (step.status === "next") {
      lastKind = step.taskKind;
      revisionIndex = step.revisionIndex;
      lastDecision = entry.decision;
    }
  }
  return { status: "awaiting_task", nextTaskKind: lastKind, revisionIndex, lastDecision };
}
