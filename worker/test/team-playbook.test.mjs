import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_TASK_KIND_ROLES,
  assertNextTask,
  assertResultCurrent,
  assertTaskKindRole,
  assertTransitionAllowed,
  reduceTaskChain,
} from "../agent/playbook/transition-policy.mjs";
import { closedPlaybookRegistries, findPlaybook } from "../agent/playbook/registry.mjs";
import {
  DEFAULT_PLAYBOOK_ROOT,
  buildProjectBinding,
  buildTaskBinding,
  readPlaybookManifest,
} from "../agent/playbook/resolver.mjs";

const ROLE_BINDINGS = {
  team_leader: "leader-w",
  designer: "design-w",
  implementor: "impl-w",
  assessor: "assess-w",
  operator: "op-w",
};

test("the closed registry exposes the software-change-delivery playbook", () => {
  const entry = findPlaybook("software-change-delivery", "1.0.0");
  assert.equal(entry.playbookId, "software-change-delivery");
  assert.equal(entry.version, "1.0.0");
  assert.deepEqual(entry.roleSlots, ["team_leader", "designer", "implementor", "assessor", "operator"]);
  assert.deepEqual(entry.taskKinds, ["design", "implement", "assess", "release"]);
  assert.equal(closedPlaybookRegistries().playbooks["software-change-delivery@1.0.0"], entry);
  assert.equal(Object.isFrozen(entry), true);
});

test("readPlaybookManifest verifies the on-disk digest against the closed registry", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  assert.equal(pb.playbookId, "software-change-delivery");
  assert.equal(pb.version, "1.0.0");
  assert.deepEqual(pb.taskKindRoles, DEFAULT_TASK_KIND_ROLES);
  assert.equal(pb.maxRevisionWaves, 2);
});

test("readPlaybookManifest rejects a tampered manifest", () => {
  const real = readFileSyncReal();
  const dir = mkdtempSync(path.join(tmpdir(), "tiangong-pb-"));
  mkdirSync(path.join(dir, "software-change-delivery"), { recursive: true });
  const target = path.join(dir, "software-change-delivery", "manifest.json");
  writeFileSync(target, real); // genuine manifest loads fine
  assert.ok(readPlaybookManifest("software-change-delivery", { root: dir }));

  const tampered = JSON.parse(real);
  tampered.maxRevisionWaves = 5; // changes digest AND diverges from registry field
  writeFileSync(target, JSON.stringify(tampered));
  assert.throws(() => readPlaybookManifest("software-change-delivery", { root: dir }), /digest|diverges/i);
  rmSync(dir, { recursive: true, force: true });
});

test("buildProjectBinding and buildTaskBinding carry the verified playbook digest", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  const project = buildProjectBinding({
    playbook: pb,
    projectId: "P1",
    roleBindings: ROLE_BINDINGS,
    createdAt: "2026-08-01T00:00:00Z",
  });
  assert.equal(project.playbookDigest, pb.contentDigest);
  assert.equal(project.kind, "tiangong.project-binding");

  const task = buildTaskBinding({
    playbook: pb,
    taskId: "T1",
    projectId: "P1",
    taskKind: "design",
    revisionIndex: 0,
    assignee: "design-w",
    completionContractDigest: pb.contentDigest,
    createdAt: "2026-08-01T00:00:01Z",
  });
  assert.equal(task.playbookStepId, "software-change-delivery-transition-v1:design");
  assert.equal(project.contentDigest.length, 64);
});

test("assertTaskKindRole authorizes the owner and rejects an illegal role", () => {
  assert.doesNotThrow(() =>
    assertTaskKindRole({ taskBinding: { taskKind: "design", assignee: "design-w" }, roleBindings: ROLE_BINDINGS }),
  );
  // design task assigned to the implementor worker -> illegal
  assert.throws(
    () => assertTaskKindRole({ taskBinding: { taskKind: "design", assignee: "impl-w" }, roleBindings: ROLE_BINDINGS }),
    /must be owned by designer/,
  );
  // worker not in roleBindings
  assert.throws(
    () => assertTaskKindRole({ taskBinding: { taskKind: "design", assignee: "ghost" }, roleBindings: ROLE_BINDINGS }),
    /not in roleBindings/,
  );
});

test("assertNextTask rejects a step out of order", () => {
  // empty chain -> design@0 is next
  assert.doesNotThrow(() => assertNextTask({ taskBinding: { taskKind: "design", revisionIndex: 0 } }));
  // implement before design is accepted -> wrong step
  assert.throws(
    () => assertNextTask({ taskBinding: { taskKind: "implement", revisionIndex: 0 } }),
    /Expected next task design/,
  );
  // a blocked chain admits no task
  assert.throws(
    () =>
      assertNextTask({
        taskBinding: { taskKind: "design", revisionIndex: 0 },
        chain: [{ taskKind: "design", decision: "blocked", revisionIndex: 0 }],
      }),
    /BLOCKED/,
  );
});

test("assertResultCurrent rejects an expired result and a missing one", () => {
  const digest = "a".repeat(64);
  const task = { taskId: "T1", revisionIndex: 0 };
  assert.doesNotThrow(() =>
    assertResultCurrent({ decision: { taskId: "T1", revisionIndex: 0, decision: "accept", resultDigest: digest }, taskBinding: task, latestResultDigest: digest }),
  );
  // accept referencing a different (stale) digest
  assert.throws(
    () => assertResultCurrent({ decision: { taskId: "T1", revisionIndex: 0, decision: "accept", resultDigest: "b".repeat(64) }, taskBinding: task, latestResultDigest: digest }),
    /expired result digest/,
  );
  // accept with no submitted result
  assert.throws(
    () => assertResultCurrent({ decision: { taskId: "T1", revisionIndex: 0, decision: "accept" }, taskBinding: task, latestResultDigest: undefined }),
    /without a submitted result/,
  );
  // decision against a prior revision
  assert.throws(
    () => assertResultCurrent({ decision: { taskId: "T1", revisionIndex: 0, decision: "accept", resultDigest: digest }, taskBinding: { taskId: "T1", revisionIndex: 1 }, latestResultDigest: digest }),
    /revision 0 but the task is at revision 1/,
  );
});

test("assertTransitionAllowed authorizes the full design->implement handoff and rejects a wrong assignee", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  const project = buildProjectBinding({
    playbook: pb,
    projectId: "P2",
    roleBindings: ROLE_BINDINGS,
    createdAt: "2026-08-01T00:00:00Z",
  });
  // design first, owned by designer
  assert.doesNotThrow(() =>
    assertTransitionAllowed({
      projectBinding: project,
      taskBinding: buildTaskBinding({ playbook: pb, taskId: "T1", projectId: "P2", taskKind: "design", revisionIndex: 0, assignee: "design-w", completionContractDigest: pb.contentDigest, createdAt: "2026-08-01T00:00:01Z" }),
      chain: [],
    }),
  );
  // implement owned by the assessor worker -> illegal role
  assert.throws(
    () =>
      assertTransitionAllowed({
        projectBinding: project,
        taskBinding: buildTaskBinding({ playbook: pb, taskId: "T2", projectId: "P2", taskKind: "implement", revisionIndex: 0, assignee: "assess-w", completionContractDigest: pb.contentDigest, createdAt: "2026-08-01T00:00:02Z" }),
        chain: [{ taskKind: "design", decision: "accept", revisionIndex: 0 }],
      }),
    /must be owned by implementor/,
  );
  // after design.accept, the next task must be implement (assess is out of order)
  assert.throws(
    () =>
      assertTransitionAllowed({
        projectBinding: project,
        taskBinding: buildTaskBinding({ playbook: pb, taskId: "T3", projectId: "P2", taskKind: "assess", revisionIndex: 0, assignee: "assess-w", completionContractDigest: pb.contentDigest, createdAt: "2026-08-01T00:00:03Z" }),
        chain: [{ taskKind: "design", decision: "accept", revisionIndex: 0 }],
      }),
    /Expected next task implement/,
  );
});

test("an assessor revision opens a new implement wave and a prior result cannot be reused", () => {
  const pb = readPlaybookManifest("software-change-delivery");
  const chain = [
    { taskKind: "design", decision: "accept", revisionIndex: 0 },
    { taskKind: "implement", decision: "accept", revisionIndex: 0 },
    { taskKind: "assess", decision: "revision", revisionIndex: 0 },
  ];
  const reduced = reduceTaskChain(chain, { maxRevisionWaves: pb.maxRevisionWaves });
  assert.equal(reduced.status, "awaiting_task");
  assert.equal(reduced.nextTaskKind, "implement");
  assert.equal(reduced.revisionIndex, 1);
  // the new implement task must be at revision 1 and owned by the implementor
  const project = buildProjectBinding({ playbook: pb, projectId: "P3", roleBindings: ROLE_BINDINGS, createdAt: "2026-08-01T00:00:00Z" });
  assert.doesNotThrow(() =>
    assertTransitionAllowed({
      projectBinding: project,
      taskBinding: buildTaskBinding({ playbook: pb, taskId: "T-impl-1", projectId: "P3", taskKind: "implement", revisionIndex: 1, assignee: "impl-w", completionContractDigest: pb.contentDigest, createdAt: "2026-08-01T00:00:10Z" }),
      chain,
    }),
  );
  // an accept decision carrying the stale rev-0 result digest is rejected
  const staleResult = "0".repeat(64);
  assert.throws(
    () =>
      assertResultCurrent({
        decision: { taskId: "T-impl-0", revisionIndex: 0, decision: "accept", resultDigest: staleResult },
        taskBinding: { taskId: "T-impl-0", revisionIndex: 1 },
        latestResultDigest: "1".repeat(64),
      }),
    /revision 0 but the task is at revision 1/,
  );
});

function readFileSyncReal() {
  return readFileSync(path.join(DEFAULT_PLAYBOOK_ROOT, "software-change-delivery", "manifest.json"), "utf8");
}
