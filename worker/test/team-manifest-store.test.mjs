import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import {
  createProjectBinding,
  createTaskBinding,
} from "../agent/team/manifest.mjs";
import {
  defaultTiangongRoot,
  projectBindingFile,
  resolveTeamPath,
  taskBindingFile,
} from "../agent/team/shared-fs.mjs";
import {
  readProjectBinding,
  readTaskBinding,
  removeTaskTree,
  writeProjectBinding,
  writeTaskBinding,
} from "../agent/team/manifest-store.mjs";

const PLAYBOOK_DIGEST = sha256("playbook-1");
const CONTRACT_DIGEST = sha256("contract");
const CREATED_AT = "2026-08-01T12:00:00Z";

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-team-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sampleProject() {
  return createProjectBinding({
    projectId: "proj-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookId: "software-change-delivery",
    playbookVersion: "1.0.0",
    playbookDigest: PLAYBOOK_DIGEST,
    requester: "@manager:example.test",
    roleBindings: {
      team_leader: "leader",
      designer: "designer",
      implementor: "impl",
      assessor: "assessor",
      operator: "operator",
    },
    createdAt: CREATED_AT,
  });
}

function sampleTask() {
  return createTaskBinding({
    taskId: "task-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "proj-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    playbookStepId: "implement.1",
    taskKind: "implement",
    revisionIndex: 0,
    assignee: "impl",
    completionContractDigest: CONTRACT_DIGEST,
    sourceProfileDigest: sha256("implementor-profile"),
    sourceSkillId: "implementor-v1",
    sourceSkillDigest: sha256("implementor-skill"),
    inputRefs: [],
    createdAt: CREATED_AT,
  });
}

test("shared-fs resolves bindings inside AgentTeams Project/Task records and rejects escape", () => {
  const root = "/tmp/tiangong-team-root";
  const file = projectBindingFile("proj-1", root);
  assert.equal(file, join(root, "projects", "proj-1", "tiangong", "project-binding.json"));
  // "..", separators, empty, and leading-dot segments are rejected.
  assert.throws(() => resolveTeamPath(["..", "x"], root), /Invalid team path segment/u);
  assert.throws(() => resolveTeamPath(["a/b"], root), /Invalid team path segment/u);
  assert.throws(() => resolveTeamPath([""], root), /Invalid team path segment/u);
  assert.throws(() => resolveTeamPath([".hidden"], root), /Invalid team path segment/u);
});

test("shared-fs default root points at the AgentTeams shared namespace", () => {
  assert.equal(defaultTiangongRoot(), "/root/agentteams-fs/shared");
});

test("manifest store writes and reads back a verified project binding", async () => {
  await withRoot(async (root) => {
    const binding = sampleProject();
    const filePath = await writeProjectBinding(binding, { rootDir: root });
    assert.equal(filePath, projectBindingFile(binding.projectId, root));
    const read = await readProjectBinding(binding.projectId, { rootDir: root });
    assert.deepEqual(read, binding);
  });
});

test("manifest store writes a binding exactly once (immutable)", async () => {
  await withRoot(async (root) => {
    const binding = sampleProject();
    await writeProjectBinding(binding, { rootDir: root });
    await assert.rejects(
      () => writeProjectBinding(binding, { rootDir: root }),
      /EEXIST|already/u,
    );
  });
});

test("manifest store fails closed on a tampered manifest", async () => {
  await withRoot(async (root) => {
    const binding = sampleProject();
    const filePath = projectBindingFile(binding.projectId, root);
    await writeProjectBinding(binding, { rootDir: root });
    const tampered = { ...binding, roleBindings: { ...binding.roleBindings, assessor: "evil" } };
    await writeFile(filePath, JSON.stringify(tampered), { mode: 0o600 });
    await assert.rejects(
      () => readProjectBinding(binding.projectId, { rootDir: root }),
      /failed digest verification/u,
    );
  });
});

test("manifest store reports a missing manifest", async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      () => readProjectBinding("proj-missing", { rootDir: root }),
      /No project binding manifest/u,
    );
  });
});

test("task binding store roundtrip, immutability, and cleanup", async () => {
  await withRoot(async (root) => {
    const task = sampleTask();
    await writeTaskBinding(task, { rootDir: root });
    const read = await readTaskBinding(task.taskId, { rootDir: root });
    assert.deepEqual(read, task);
    await assert.rejects(() => writeTaskBinding(task, { rootDir: root }), /EEXIST|already/u);
    await removeTaskTree(task.taskId, { rootDir: root });
    await assert.rejects(
      () => readTaskBinding(task.taskId, { rootDir: root }),
      /No task binding manifest/u,
    );
  });
});
