// Reconstruct the deterministic task-decision chain for a project so the
// Leader's dispatch tool can enforce TransitionPolicy before creating a task.
//
// The chain is built only from immutable, digest-verified manifests (never
// from Task prose or model state): each dispatched task binding plus its
// terminal decision, ordered by createdAt. A task that has been dispatched but
// not yet decided contributes nothing; once decided it is terminal (the
// architecture opens a new Task on revision rather than reopening one).

import { dispositionForRelease, reduceTaskChain } from "../playbook/transition-policy.mjs";
import { isResultEnvelope } from "../work/result-envelope.mjs";
import { listTaskBindingsForProject, readTaskDecisions, readTaskResult } from "./manifest-store.mjs";

export async function projectChain(projectId, deps) {
  const tasks = await listTaskBindingsForProject(projectId, deps);
  const chain = [];
  for (const task of tasks) {
    const decisions = await readTaskDecisions(task.taskId, deps);
    if (decisions.length === 0) {
      throw new Error(`Project has an undecided Task: ${task.taskId}`);
    }
    if (decisions.length !== 1) {
      throw new Error(`Task has conflicting terminal decisions: ${task.taskId}`);
    }
    const terminal = decisions[0];
    chain.push({
      taskKind: task.taskKind,
      decision: terminal.decision,
      revisionIndex: task.revisionIndex,
    });
  }
  return chain;
}

// A task-level blocker is terminal for the current demo request, but it is not
// a safe delivery or rollback outcome. Map it to RECOVERY_REQUIRED so the
// Leader can report the authenticated requester through the gated terminal
// report path. Non-blocked chains are not terminal here: DELIVERED and
// FAILED_SAFE require independent Operator deploy/verify facts.
export function terminalDispositionForTaskChain(chain, options) {
  const reduced = reduceTaskChain(chain, options);
  return reduced.status === "blocked" ? "RECOVERY_REQUIRED" : null;
}

export async function projectDisposition(projectId, deps) {
  const chain = await projectChain(projectId, deps);
  const reduced = reduceTaskChain(chain, { maxRevisionWaves: deps?.maxRevisionWaves });
  if (reduced.status === "blocked") return "RECOVERY_REQUIRED";
  if (reduced.status !== "awaiting_deploy") return null;
  const tasks = await listTaskBindingsForProject(projectId, deps);
  const releases = tasks.filter((task) => task.taskKind === "release" && task.revisionIndex === reduced.revisionIndex);
  if (releases.length !== 1) throw new Error("Terminal project chain must have exactly one release Task");
  const result = await readTaskResult(releases[0].taskId, deps);
  if (!isResultEnvelope(result) || !result.releaseOutcome || result.releaseOutcome.taskId !== releases[0].taskId) {
    throw new Error("Accepted release Task lacks a valid machine deployment outcome");
  }
  const outcome = result.releaseOutcome;
  const derived = dispositionForRelease({
    postVerify: outcome.postVerifyHealthy ? "pass" : "fail",
    rollback: outcome.rollbackPerformed ? "done" : "not_done",
    verifyPrevious: outcome.previousVerifyHealthy === true ? "pass" : (outcome.previousVerifyHealthy === false ? "fail" : "unknown"),
  }).disposition;
  const disposition = {
    delivered: "DELIVERED",
    failed_safe: "FAILED_SAFE",
    recovery_required: "RECOVERY_REQUIRED",
  }[derived] ?? null;
  if (disposition !== outcome.disposition) throw new Error("Deployment outcome conflicts with the deterministic terminal disposition");
  return disposition;
}
