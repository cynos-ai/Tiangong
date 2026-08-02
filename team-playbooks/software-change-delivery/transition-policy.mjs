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

// maxRevisionWaves is driven by the bound playbook; it defaults to the
// built-in limit so the pure step logic stays usable without a playbook.
export function nextTaskKindAfter({ taskKind, decision, revisionIndex, maxRevisionWaves = MAX_REVISION_WAVES }) {
  if (!TASK_KIND_INDEX.has(taskKind)) throw new Error(`Unknown task kind: ${taskKind}`);
  if (!Number.isInteger(revisionIndex) || revisionIndex < 0) {
    throw new TypeError("revisionIndex must be a non-negative integer");
  }
  if (!DECISIONS.includes(decision)) throw new Error(`Unknown task decision: ${decision}`);
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
        if (revisionIndex >= maxRevisionWaves) return { status: "blocked" };
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
export function reduceTaskChain(decisions, { maxRevisionWaves = MAX_REVISION_WAVES } = {}) {
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
      maxRevisionWaves,
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

// ---- Binding-aware policy (architecture §7 / §17 gate 5) -------------------
//
// The pure step logic above is wrapped with the immutable Project/Task
// binding so the policy can reject an illegal role for a step, a step out of
// order, and a decision that reuses an expired (prior-revision) result. These
// take explicit maps (roleBindings, taskKindRoles) so the module stays free
// of runtime/Practice imports; the closed TeamPlaybook resolver wires them.

export const DEFAULT_TASK_KIND_ROLES = Object.freeze({
  design: "designer",
  implement: "implementor",
  assess: "assessor",
  release: "operator",
});

export function findRoleForWorker(roleBindings, workerName) {
  if (roleBindings === null || typeof roleBindings !== "object") return undefined;
  for (const [role, name] of Object.entries(roleBindings)) {
    if (name === workerName) return role;
  }
  return undefined;
}

// Reject a task whose assignee does not own its taskKind role.
export function assertTaskKindRole({ taskBinding, roleBindings, taskKindRoles = DEFAULT_TASK_KIND_ROLES }) {
  const role = findRoleForWorker(roleBindings, taskBinding.assignee);
  if (!role) {
    throw new Error(`Assignee ${taskBinding.assignee} is not in roleBindings`);
  }
  const expected = taskKindRoles[taskBinding.taskKind];
  if (!expected) throw new Error(`Unknown taskKind role for ${taskBinding.taskKind}`);
  if (role !== expected) {
    throw new Error(
      `taskKind ${taskBinding.taskKind} must be owned by ${expected}, not ${role}`,
    );
  }
  return role;
}

// Reject a task that is not the deterministic next step for the chain.
export function assertNextTask({ taskBinding, chain = [], maxRevisionWaves = MAX_REVISION_WAVES }) {
  const reduced = reduceTaskChain(chain, { maxRevisionWaves });
  if (reduced.status === "blocked") {
    throw new Error("Project is BLOCKED; no further task is allowed");
  }
  if (reduced.status === "awaiting_deploy") {
    throw new Error("Project is awaiting deploy; no further task step is allowed");
  }
  if (reduced.nextTaskKind !== taskBinding.taskKind) {
    throw new Error(
      `Expected next task ${reduced.nextTaskKind}, got ${taskBinding.taskKind}`,
    );
  }
  if (reduced.revisionIndex !== taskBinding.revisionIndex) {
    throw new Error(
      `Expected revisionIndex ${reduced.revisionIndex}, got ${taskBinding.revisionIndex}`,
    );
  }
  return reduced;
}

// Combined gate for creating a task against a project binding + the chain so
// far. Runs role authorization + step order; the decision-side result check
// (assertResultCurrent) is applied when a decision is recorded.
export function assertTransitionAllowed({
  projectBinding,
  taskBinding,
  chain = [],
  taskKindRoles = DEFAULT_TASK_KIND_ROLES,
  maxRevisionWaves = MAX_REVISION_WAVES,
}) {
  if (!projectBinding?.roleBindings) throw new Error("project binding is missing roleBindings");
  assertTaskKindRole({ taskBinding, roleBindings: projectBinding.roleBindings, taskKindRoles });
  return assertNextTask({ taskBinding, chain, maxRevisionWaves });
}

// Reject a decision that reuses an expired result. An accept must reference
// the latest submitted result digest and the task's current revision; a
// decision cannot be recorded against a prior revision's result.
export function assertResultCurrent({ decision, taskBinding, latestResultDigest }) {
  if (decision.taskId !== taskBinding.taskId) {
    throw new Error("Decision taskId does not match the task");
  }
  if (decision.revisionIndex !== taskBinding.revisionIndex) {
    throw new Error(
      `Decision targets revision ${decision.revisionIndex} but the task is at revision ${taskBinding.revisionIndex}`,
    );
  }
  if (["accept", "revision"].includes(decision.decision)) {
    if (!latestResultDigest) throw new Error(`Cannot ${decision.decision} without a submitted result`);
    if (!decision.resultDigest || decision.resultDigest !== latestResultDigest) {
      throw new Error(`${decision.decision} must bind the current result digest`);
    }
  }
  return decision;
}

// Bind the terminal decision to the ResultEnvelope's machine semantics. Model
// prose cannot turn a blocker into success or suppress an assessor-requested
// revision. A blocked decision may exist without a result (for example an
// external prerequisite failure); once a result exists, every decision must
// bind its exact digest.
export function assertDecisionResultCompatible({ decision, taskBinding, result }) {
  assertResultCurrent({
    decision,
    taskBinding,
    latestResultDigest: result?.contentDigest,
  });
  if (!result) {
    if (decision.resultDigest) throw new Error("Decision cannot bind a missing ResultEnvelope");
    return decision;
  }
  if (decision.resultDigest !== result.contentDigest) {
    throw new Error("Decision must bind the current ResultEnvelope digest");
  }
  if (result.blocker && decision.decision !== "blocked") {
    throw new Error("A blocker ResultEnvelope requires a blocked decision");
  }
  if (decision.decision === "accept" && result.revisionRequest) {
    throw new Error("A revision-request ResultEnvelope cannot be accepted");
  }
  if (decision.decision === "revision" &&
      (taskBinding.taskKind !== "assess" || !result.revisionRequest || result.blocker)) {
    throw new Error("Revision requires a non-blocked assessor revision request");
  }
  return decision;
}
