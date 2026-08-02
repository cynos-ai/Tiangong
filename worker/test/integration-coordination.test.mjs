// End-to-end deterministic integration of the Phase-2-ready contracts:
// software-change-delivery TeamPlaybook (resolver + registry) + TransitionPolicy
// + TeamTaskPort (shared-FS manifests) + WorkRunStore + ResultEnvelope, walked
// through a full design -> implement -> assess(revision) -> implement@1 ->
// assess(accept) -> release -> DELIVERED flow with idempotency and the
// negative gates. No live stack: every side effect is a fake adapter or an
// in-memory/injected store. This is the deterministic proof that the contracts
// compose before the Practice clean cut wires them into the active runtime.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertTransitionAllowed, assertResultCurrent, dispositionForRelease, reduceTaskChain } from "../agent/playbook/transition-policy.mjs";
import { buildProjectBinding, buildTaskBinding, readPlaybookManifest } from "../agent/playbook/resolver.mjs";
import { createTaskDecision, dispatchTask, recordTaskDecision, resolveAssignedTask, submitResult, createProject } from "../agent/team/team-task-port.mjs";
import { WorkRunStore } from "../agent/work/work-run-store.mjs";
import { createResultEnvelope } from "../agent/work/result-envelope.mjs";

const LEADER = "tiangong-leader";
const DESIGNER = "tiangong-designer";
const IMPL = "tiangong-implementor";
const ASSESS = "tiangong-assessor";
const OP = "tiangong-operator";
const ROLE_BINDINGS = { team_leader: LEADER, designer: DESIGNER, implementor: IMPL, assessor: ASSESS, operator: OP };
const PROJECT_ID = "proj-integ-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T = (n) => `2026-08-01T12:0${n}:00Z`;

function channel() {
  const calls = [];
  return {
    calls,
    async assertTeamIdentity(role) { return { team: "team-1", role }; },
    async assertTeamRoster() { return { roomId: "!team:example.test", roomIdDigest: "f".repeat(64), memberDigests: [] }; },
    async notifyAssignee(w, t, d) {
      calls.push({ kind: "notifyAssignee", worker: w, taskId: t });
      return { queued: true, delivered: false };
    },
    async notifyLeader(t) {
      calls.push({ kind: "notifyLeader", taskId: t });
      return { queued: true, delivered: false };
    },
  };
}
function evidence() {
  const events = [];
  return { events, async append(e) { events.push(e); } };
}
function depsFor(worker, root, ch) {
  return {
    rootDir: root,
    env: {
      AGENTTEAMS_WORKER_NAME: worker,
      AGENTTEAMS_WORKER_ROLE: worker === LEADER ? "team_leader" : "worker",
      AGENTTEAMS_WORKER_ROOM_ID: `room-${worker}`,
      AGENTTEAMS_MATRIX_DOMAIN: "example.test",
    },
    channel: ch,
    sync: { async beforeRead() {}, async afterWrite() {} },
    evidence: evidence(),
  };
}
function runStore(dir) {
  return new WorkRunStore({ directory: dir, now: () => T(5) });
}

// Dispatch + resolve + Worker WorkRun lifecycle + submit a ResultEnvelope-backed
// result + Leader accept. Returns the decision chain entry to append.
async function runStep({ pb, project, root, chain, taskKind, revisionIndex, assignee, roleStores, decide }) {
  const taskId = `task-${taskKind}-${revisionIndex}-${assignee}`;
  const task = buildTaskBinding({
    playbook: pb,
    taskId,
    projectId: PROJECT_ID,
    taskKind,
    revisionIndex,
    assignee,
    completionContractDigest: pb.completionSchemaDigest,
    createdAt: T(1),
  });
  // TransitionPolicy gates creation: legal role + deterministic next step
  assertTransitionAllowed({ projectBinding: project, taskBinding: task, chain, taskKindRoles: pb.taskKindRoles, maxRevisionWaves: pb.maxRevisionWaves });

  const leaderCh = channel();
  await dispatchTask(task, depsFor(LEADER, root, leaderCh));
  assert.equal(leaderCh.calls.some((c) => c.kind === "notifyAssignee" && c.worker === assignee), true);

  // Worker-local WorkRun lifecycle
  const store = roleStores[assignee];
  const run = await store.open({ runId: `run-${taskId}`, taskId, role: pb.taskKindRoles[taskKind], skillId: `${taskKind}-v1`, objective: taskKind, scope: taskKind, completionContractDigest: pb.completionSchemaDigest, createdAt: T(1) });
  await store.transition(run.binding.runId, "executing");
  await store.transition(run.binding.runId, "verifying");
  await store.transition(run.binding.runId, "finalized");

  // The structured deliverable (ResultEnvelope) is constructed from the same
  // binding; the simple stored result carries its digest as the authoritative
  // result digest the Leader records against.
  const envelopeInput = {
    taskId,
    projectId: PROJECT_ID,
    taskKind,
    revisionIndex,
    producer: assignee,
    sourceRole: pb.taskKindRoles[taskKind],
    playbookDigest: pb.contentDigest,
    taskBindingDigest: task.contentDigest,
    completionContractDigest: pb.completionSchemaDigest,
    sourceProfileDigest: task.sourceProfileDigest,
    sourceSkillId: task.sourceSkillId,
    skillDigest: task.sourceSkillDigest,
    createdAt: T(2),
  };
  if (["implement", "assess", "release"].includes(taskKind)) {
    const producerTaskId = `task-implement-${revisionIndex}-${IMPL}`;
    envelopeInput.changeRevisionRef = {
      producerTaskId,
      artifactPath: `artifacts/${producerTaskId}.tar`,
      artifactDigest: pb.contentDigest,
      revision: revisionIndex,
    };
    envelopeInput.claim = taskKind === "implement" ? `sealed revision ${revisionIndex}` : `${taskKind} complete`;
    if (taskKind === "assess" && decide === "revision") {
      envelopeInput.claim = "needs revision";
      envelopeInput.revisionRequest = { summary: "edge case uncovered" };
    }
  } else {
    envelopeInput.claim = `${taskKind} complete`;
  }
  const envelope = createResultEnvelope(envelopeInput);

  const stored = envelope;
  const workerCh = channel();
  await submitResult(stored, depsFor(assignee, root, workerCh));
  assert.equal(workerCh.calls.some((c) => c.kind === "notifyLeader"), true);

  if (!decide) return undefined; // release hands off to deploy, no task decision

  const decision = createTaskDecision({
    taskId,
    projectId: PROJECT_ID,
    playbookDigest: pb.contentDigest,
    decision: decide,
    revisionIndex,
    decidedBy: LEADER,
    resultDigest: stored.contentDigest,
    createdAt: T(3),
  });
  // gate: accept must reference the current result
  assertResultCurrent({ decision, taskBinding: task, latestResultDigest: stored.contentDigest });
  await recordTaskDecision(decision, depsFor(LEADER, root, channel()));
  return { taskKind, decision: decide, revisionIndex };
}

test("full coordination: design -> implement -> assess revision -> implement@1 -> assess accept -> release -> DELIVERED", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-integ-"));
  try {
    const pb = readPlaybookManifest("software-change-delivery");
    const project = buildProjectBinding({ playbook: pb, projectId: PROJECT_ID, requester: "@manager:example.test", roleBindings: ROLE_BINDINGS, createdAt: T(0) });
    await createProject(project, depsFor(LEADER, root, channel()));
    const roleStores = {
      [DESIGNER]: runStore(join(root, "designer")),
      [IMPL]: runStore(join(root, "implementor")),
      [ASSESS]: runStore(join(root, "assessor")),
      [OP]: runStore(join(root, "operator")),
    };

    const chain = [];
    chain.push(await runStep({ pb, project, root, chain, taskKind: "design", revisionIndex: 0, assignee: DESIGNER, roleStores, decide: "accept" }));
    chain.push(await runStep({ pb, project, root, chain, taskKind: "implement", revisionIndex: 0, assignee: IMPL, roleStores, decide: "accept" }));
    chain.push(await runStep({ pb, project, root, chain, taskKind: "assess", revisionIndex: 0, assignee: ASSESS, roleStores, decide: "revision" }));

    // after a revision, the next task must be implement@1
    const afterRevision = reduceTaskChain(chain, { maxRevisionWaves: pb.maxRevisionWaves });
    assert.equal(afterRevision.status, "awaiting_task");
    assert.equal(afterRevision.nextTaskKind, "implement");
    assert.equal(afterRevision.revisionIndex, 1);

    chain.push(await runStep({ pb, project, root, chain, taskKind: "implement", revisionIndex: 1, assignee: IMPL, roleStores, decide: "accept" }));
    chain.push(await runStep({ pb, project, root, chain, taskKind: "assess", revisionIndex: 1, assignee: ASSESS, roleStores, decide: "accept" }));

    // release hands off to deploy
    await runStep({ pb, project, root, chain, taskKind: "release", revisionIndex: 1, assignee: OP, roleStores, decide: undefined });
    const beforeDeploy = reduceTaskChain([...chain, { taskKind: "release", decision: "accept", revisionIndex: 1 }], { maxRevisionWaves: pb.maxRevisionWaves });
    assert.equal(beforeDeploy.status, "awaiting_deploy");

    const delivered = dispositionForRelease({ postVerify: "pass" });
    assert.equal(delivered.disposition, "delivered");
    // a failed post-verify without a verified rollback is recovery required
    assert.equal(dispositionForRelease({ postVerify: "fail", rollback: "done", verifyPrevious: "fail" }).disposition, "recovery_required");
    assert.equal(dispositionForRelease({ postVerify: "fail", rollback: "done", verifyPrevious: "pass" }).disposition, "failed_safe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch is idempotent across the integration boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-integ-idem-"));
  try {
    const pb = readPlaybookManifest("software-change-delivery");
    const project = buildProjectBinding({ playbook: pb, projectId: PROJECT_ID, requester: "@manager:example.test", roleBindings: ROLE_BINDINGS, createdAt: T(0) });
    await createProject(project, depsFor(LEADER, root, channel()));
    const task = buildTaskBinding({ playbook: pb, taskId: "task-design-0-idem", projectId: PROJECT_ID, taskKind: "design", revisionIndex: 0, assignee: DESIGNER, completionContractDigest: pb.completionSchemaDigest, createdAt: T(1) });
    assertTransitionAllowed({ projectBinding: project, taskBinding: task, chain: [] });
    const ch1 = channel();
    await dispatchTask(task, depsFor(LEADER, root, ch1));
    const ch2 = channel();
    const replayed = await dispatchTask(task, depsFor(LEADER, root, ch2));
    assert.equal(replayed.replayed, true);
    assert.equal(ch2.calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the policy rejects an illegal role and an expired result within the flow", async () => {
  const pb = readPlaybookManifest("software-change-delivery");
  const project = buildProjectBinding({ playbook: pb, projectId: PROJECT_ID, requester: "@manager:example.test", roleBindings: ROLE_BINDINGS, createdAt: T(0) });
  // assessor assigned to a design task -> illegal role
  const wrongRole = buildTaskBinding({ playbook: pb, taskId: "task-x", projectId: PROJECT_ID, taskKind: "design", revisionIndex: 0, assignee: ASSESS, completionContractDigest: pb.completionSchemaDigest, createdAt: T(1) });
  assert.throws(() => assertTransitionAllowed({ projectBinding: project, taskBinding: wrongRole, chain: [] }), /must be owned by designer/);
  // an accept referencing a stale result digest is rejected
  const fresh = "a".repeat(64);
  const stale = "b".repeat(64);
  assert.throws(
    () => assertResultCurrent({ decision: { taskId: "t", revisionIndex: 0, decision: "accept", resultDigest: stale }, taskBinding: { taskId: "t", revisionIndex: 0 }, latestResultDigest: fresh }),
    /bind the current result digest/,
  );
});
