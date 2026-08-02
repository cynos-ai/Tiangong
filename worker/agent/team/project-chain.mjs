// Reconstruct the deterministic task-decision chain for a project so the
// Leader's dispatch tool can enforce TransitionPolicy before creating a task.
//
// The chain is built only from immutable, digest-verified manifests (never
// from Task prose or model state): each dispatched task binding plus its
// terminal decision, ordered by createdAt. A task that has been dispatched but
// not yet decided contributes nothing; once decided it is terminal (the
// architecture opens a new Task on revision rather than reopening one).

import { listTaskBindingsForProject, readTaskDecisions } from "./manifest-store.mjs";

function byCreatedAt(a, b) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export async function projectChain(projectId, deps) {
  const tasks = await listTaskBindingsForProject(projectId, deps);
  const chain = [];
  for (const task of tasks) {
    const decisions = await readTaskDecisions(task.taskId, deps);
    if (decisions.length === 0) continue;
    const terminal = [...decisions].sort(byCreatedAt).at(-1);
    chain.push({
      taskKind: task.taskKind,
      decision: terminal.decision,
      revisionIndex: task.revisionIndex,
    });
  }
  return chain;
}
