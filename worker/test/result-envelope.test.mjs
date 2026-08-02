import assert from "node:assert/strict";
import test from "node:test";

import { createDeploymentOutcome } from "../agent/deployment/client.mjs";
import {
  createChangeRevisionRef,
  isChangeRevisionRef,
} from "../agent/work/change-revision-ref.mjs";
import {
  createResultEnvelope,
  isResultEnvelope,
} from "../agent/work/result-envelope.mjs";

const DIGEST = "a".repeat(64);
const CONTRACT = "c".repeat(64);
const PLAYBOOK = "b".repeat(64);
const TASK_BINDING = "d".repeat(64);
const AT = "2026-08-01T00:00:00Z";

const BINDING = {
  producer: "tiangong-worker",
  playbookDigest: PLAYBOOK,
  taskBindingDigest: TASK_BINDING,
  sourceProfileDigest: "e".repeat(64),
  sourceSkillId: "professional-v1",
  skillDigest: "f".repeat(64),
};

test("createChangeRevisionRef seals and digests the reference", () => {
  const ref = createChangeRevisionRef({
    producerTaskId: "task-impl-1",
    artifactPath: "artifacts/change-1.tar",
    artifactDigest: DIGEST,
    revision: 0,
  });
  assert.equal(ref.kind, "tiangong.change-revision-ref");
  assert.equal(isChangeRevisionRef(ref), true);
  assert.equal(Object.isFrozen(ref), true);
  assert.match(ref.contentDigest, /^[0-9a-f]{64}$/);
});

test("createChangeRevisionRef rejects unsafe paths and a non-64-hex digest", () => {
  assert.throws(
    () => createChangeRevisionRef({ producerTaskId: "t", artifactPath: "p", artifactDigest: "nothex", revision: 0 }),
    /64-hex digest/,
  );
  for (const artifactPath of ["/absolute", "../escape", "safe/../escape", "safe//file"]) {
    assert.throws(
      () => createChangeRevisionRef({ producerTaskId: "t", artifactPath, artifactDigest: DIGEST, revision: 0 }),
      /artifactPath/,
    );
  }
});

test("a design result envelope carries a claim without a revision ref", () => {
  const env = createResultEnvelope({
    ...BINDING,
    taskId: "t1",
    projectId: "p1",
    taskKind: "design",
    revisionIndex: 0,
    sourceRole: "designer",
    completionContractDigest: CONTRACT,
    claim: "scope is X, approach is Y",
    createdAt: AT,
  });
  assert.equal(env.taskKind, "design");
  assert.equal(env.claim, "scope is X, approach is Y");
  assert.equal(env.changeRevisionRef, undefined);
  assert.equal(isResultEnvelope(env), true);
});

test("an implement result must seal a changeRevisionRef unless it is a blocker", () => {
  assert.throws(
    () =>
      createResultEnvelope({
        ...BINDING,
        taskId: "t2",
        projectId: "p1",
        taskKind: "implement",
        revisionIndex: 0,
        sourceRole: "implementor",
        completionContractDigest: CONTRACT,
        claim: "done",
        createdAt: AT,
      }),
    /must seal a changeRevisionRef/,
  );
  // with a sealed ref it is accepted
  const env = createResultEnvelope({
    ...BINDING,
    taskId: "t2",
    projectId: "p1",
    taskKind: "implement",
    revisionIndex: 0,
    sourceRole: "implementor",
    completionContractDigest: CONTRACT,
    claim: "implemented and self-checked",
    changeRevisionRef: { producerTaskId: "t2", artifactPath: "artifacts/r0.tar", artifactDigest: DIGEST, revision: 0 },
    createdAt: AT,
  });
  assert.equal(isChangeRevisionRef(env.changeRevisionRef), true);
});

test("a blocker envelope does not require a claim or a revision ref", () => {
  const env = createResultEnvelope({
    ...BINDING,
    taskId: "t3",
    projectId: "p1",
    taskKind: "implement",
    revisionIndex: 0,
    sourceRole: "implementor",
    completionContractDigest: CONTRACT,
    blocker: "blocked on missing dependency",
    createdAt: AT,
  });
  assert.equal(env.blocker, "blocked on missing dependency");
  assert.equal(env.claim, undefined);
});

test("a revision request is only allowed on an assessor result", () => {
  assert.throws(
    () =>
      createResultEnvelope({
        ...BINDING,
        taskId: "t4",
        projectId: "p1",
        taskKind: "design",
        revisionIndex: 0,
        sourceRole: "designer",
        completionContractDigest: CONTRACT,
        claim: "x",
        revisionRequest: { summary: "please revise" },
        createdAt: AT,
      }),
    /Only an assessor result may carry a revision request/,
  );
  const assess = createResultEnvelope({
    ...BINDING,
    taskId: "t5",
    projectId: "p1",
    taskKind: "assess",
    revisionIndex: 0,
    sourceRole: "assessor",
    completionContractDigest: CONTRACT,
    claim: "revision needed",
    changeRevisionRef: {
      producerTaskId: "t-implement-0",
      artifactPath: "objects/revision-0",
      artifactDigest: DIGEST,
      revision: 0,
    },
    revisionRequest: { summary: "tests missing for edge case" },
    createdAt: AT,
  });
  assert.equal(assess.revisionRequest.summary, "tests missing for edge case");
});

test("a release result requires a consistent machine deployment outcome", () => {
  const ref = createChangeRevisionRef({ producerTaskId: "implement-release", artifactPath: "revision.tar", artifactDigest: DIGEST, revision: 0 });
  assert.throws(() => createResultEnvelope({ ...BINDING, taskId: "release-1", projectId: "p1", taskKind: "release", revisionIndex: 0, sourceRole: "operator", completionContractDigest: CONTRACT, claim: "deployed", changeRevisionRef: ref, createdAt: AT }), /machine deployment outcome/);
  const outcome = createDeploymentOutcome({ taskId: "release-1", targetId: "target-a", operationDigest: "9".repeat(64), previousDigest: "8".repeat(64), currentDigest: DIGEST, changeRevisionRef: ref, disposition: "DELIVERED", postVerifyHealthy: true, rollbackPerformed: false, previousVerifyHealthy: null });
  const release = createResultEnvelope({ ...BINDING, taskId: "release-1", projectId: "p1", taskKind: "release", revisionIndex: 0, sourceRole: "operator", completionContractDigest: CONTRACT, claim: "machine deploy complete", changeRevisionRef: ref, releaseOutcome: outcome, createdAt: AT });
  assert.equal(release.releaseOutcome.disposition, "DELIVERED");
  assert.equal(isResultEnvelope(release), true);
  assert.throws(() => createResultEnvelope({ ...BINDING, taskId: "release-other", projectId: "p1", taskKind: "release", revisionIndex: 0, sourceRole: "operator", completionContractDigest: CONTRACT, claim: "forged", changeRevisionRef: ref, releaseOutcome: outcome, createdAt: AT }), /does not match/);
});

test("createResultEnvelope rejects unsupported task kinds and roles", () => {
  assert.throws(
    () =>
      createResultEnvelope({
        ...BINDING,
        taskId: "t",
        projectId: "p",
        taskKind: "rocket",
        revisionIndex: 0,
        sourceRole: "designer",
        completionContractDigest: CONTRACT,
        claim: "x",
        createdAt: AT,
      }),
    /Unsupported task kind/,
  );
  assert.throws(
    () =>
      createResultEnvelope({
        ...BINDING,
        taskId: "t",
        projectId: "p",
        taskKind: "design",
        revisionIndex: 0,
        sourceRole: "wizard",
        completionContractDigest: CONTRACT,
        claim: "x",
        createdAt: AT,
      }),
    /Unsupported source role/,
  );
});
