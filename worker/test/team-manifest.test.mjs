import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256 } from "../agent/canonical-json.mjs";
import {
  createProjectBinding,
  createTaskBinding,
  isProjectBinding,
  isTaskBinding,
  verifyBindingDigest,
} from "../agent/team/manifest.mjs";

const PLAYBOOK_DIGEST = sha256("playbook-software-change-delivery-1.0.0");
const CONTRACT_DIGEST = sha256("acceptance-contract");
const CREATED_AT = "2026-08-01T12:00:00Z";

function sampleProject(overrides = {}) {
  return createProjectBinding({
    projectId: "proj-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookId: "software-change-delivery",
    playbookVersion: "1.0.0",
    playbookDigest: PLAYBOOK_DIGEST,
    requester: "@manager:example.test",
    roleBindings: {
      team_leader: "tiangong-leader",
      designer: "tiangong-designer",
      implementor: "tiangong-implementor",
      assessor: "tiangong-assessor",
      operator: "tiangong-operator",
    },
    createdAt: CREATED_AT,
    ...overrides,
  });
}

function sampleTask(overrides = {}) {
  return createTaskBinding({
    taskId: "task-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "proj-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookStepId: "implement.1",
    taskKind: "implement",
    revisionIndex: 0,
    assignee: "tiangong-implementor",
    completionContractDigest: CONTRACT_DIGEST,
    sourceProfileDigest: sha256("implementor-profile"),
    sourceSkillId: "implementor-v1",
    sourceSkillDigest: sha256("implementor-skill"),
    inputRefs: ["result-design-1"],
    createdAt: CREATED_AT,
    ...overrides,
  });
}

test("project binding is immutable and carries a canonical digest", () => {
  const binding = sampleProject();
  assert.equal(binding.kind, "tiangong.project-binding");
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.contentDigest.length, 64);
  assert.equal(isProjectBinding(binding), true);
  assert.equal(verifyBindingDigest(binding), true);
  assert.throws(() => {
    binding.projectId = "mutated";
  }, TypeError);
  // Deterministic: same input -> same digest.
  assert.equal(sampleProject().contentDigest, binding.contentDigest);
});

test("task binding is immutable and carries a canonical digest", () => {
  const binding = sampleTask();
  assert.equal(binding.kind, "tiangong.task-binding");
  assert.equal(binding.taskKind, "implement");
  assert.equal(binding.revisionIndex, 0);
  assert.equal(isTaskBinding(binding), true);
  assert.equal(verifyBindingDigest(binding), true);
  assert.throws(() => {
    binding.taskKind = "assess";
  }, TypeError);
});

test("distinct inputs produce distinct digests", () => {
  const a = sampleTask({ taskId: "task-11111111-1111-4111-8111-111111111111" });
  const b = sampleTask({ taskId: "task-22222222-2222-4222-8222-222222222222" });
  assert.notEqual(a.contentDigest, b.contentDigest);
  // revisionIndex change also changes the digest.
  const revised = sampleTask({ revisionIndex: 1 });
  assert.notEqual(revised.contentDigest, sampleTask().contentDigest);
});

test("tampering with a stored binding breaks digest verification", () => {
  const binding = sampleProject();
  const tampered = { ...binding, projectId: "proj-tampered" };
  assert.equal(isProjectBinding(tampered), false);
  assert.equal(verifyBindingDigest(tampered), false);
  assert.equal(verifyBindingDigest({ ...binding, contentDigest: "0".repeat(64) }), false);
  assert.equal(verifyBindingDigest(null), false);
});

test("project binding rejects unsupported roles and bad ids", () => {
  assert.throws(
    () => sampleProject({ roleBindings: { superuser: "tiangong-leader" } }),
    /Unsupported team role/u,
  );
  assert.throws(
    () => sampleProject({ roleBindings: {} }),
    /exactly the five required team roles/u,
  );
  assert.throws(
    () => sampleProject({ projectId: "has spaces" }),
    /invalid format/u,
  );
  assert.throws(
    () => sampleProject({ playbookDigest: "not-a-digest" }),
    /invalid format/u,
  );
  assert.throws(
    () => sampleProject({ requester: "manager" }),
    /invalid format/u,
  );
});

test("task binding rejects unknown kinds, negative revisions, and duplicate refs", () => {
  assert.throws(() => sampleTask({ taskKind: "coordinate" }), /Unsupported task kind/u);
  assert.throws(() => sampleTask({ revisionIndex: -1 }), /non-negative integer/u);
  assert.throws(() => sampleTask({ revisionIndex: 1.5 }), /non-negative integer/u);
  assert.throws(
    () => sampleTask({ inputRefs: ["dup", "dup"] }),
    /duplicates/u,
  );
  assert.throws(
    () => sampleTask({ completionContractDigest: "short" }),
    /invalid format/u,
  );
});

test("canonical digest excludes the digest field itself", () => {
  const binding = sampleTask();
  const { contentDigest, ...rest } = binding;
  assert.equal(sha256(canonicalJson(rest)), contentDigest);
});
