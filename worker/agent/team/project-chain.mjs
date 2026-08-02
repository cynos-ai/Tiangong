// Reconstruct the deterministic task-decision chain for a project so the
// Leader's dispatch tool can enforce TransitionPolicy before creating a task.
//
// The chain is built only from immutable, digest-verified manifests (never
// from Task prose or model state): each dispatched task binding plus its
// terminal decision, ordered by createdAt. A task that has been dispatched but
// not yet decided contributes nothing; once decided it is terminal (the
// architecture opens a new Task on revision rather than reopening one).

import { reduceTaskChain } from "../playbook/transition-policy.mjs";
import { listTaskBindingsForProject, readTaskDecisions } from "./manifest-store.mjs";

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
  return terminalDispositionForTaskChain(await projectChain(projectId, deps), {
    maxRevisionWaves: deps?.maxRevisionWaves,
  });
}
