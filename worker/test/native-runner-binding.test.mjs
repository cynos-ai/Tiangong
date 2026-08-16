import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createControlProfile, createMemberConfig, createTaskSpec, createTeamConfig, createWorkSpec } from "../agent/team/coordination-store.mjs";
import { createProjectBinding, createTaskBinding } from "../agent/team/manifest.mjs";
import {
  createNativeRunnerDeploymentBinding,
  materializeNativeRunnerBinding,
  nativeRunnerWorkerEnvironment,
  prepareNativeRunnerDeployment,
} from "../agent/team/native-runner-binding.mjs";

const NOW = "2026-08-16T04:00:00Z";

function fixture() {
  const profile = createControlProfile({ profileId: "profile-native-binding", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-native-binding", revision: 1, leaderMemberId: "leader-native-binding", memberIds: ["leader-native-binding", "member-native-binding"], controlProfileId: profile.profileId, createdAt: NOW });
  const work = createWorkSpec({ workId: "work-native-binding", revision: 1, objective: "Implement the bounded change", scope: "fixture", completionContract: "one result", createdAt: NOW });
  const member = createMemberConfig({ memberId: "member-native-binding", teamId: team.teamId, workerName: "worker-native-binding", matrixUserId: "@member-native-binding:example.test", role: "implementor", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const task = createTaskSpec({ taskId: "task-native-binding", workId: work.workId, assigneeMemberId: member.memberId, objective: "Run the bounded implementation", completionContract: "one bounded result", inputRefs: [], createdAt: NOW });
  const projectBinding = createProjectBinding({ projectId: "project-native-binding", playbookId: "software-change-delivery", playbookVersion: "1.0.0", playbookDigest: sha256("playbook-native-binding"), requester: "@requester:example.test", roleBindings: { team_leader: "worker-leader-native-binding", designer: "worker-designer-native-binding", implementor: member.workerName, assessor: "worker-assessor-native-binding", operator: "worker-operator-native-binding" }, createdAt: NOW });
  const taskBinding = createTaskBinding({ taskId: task.taskId, projectId: projectBinding.projectId, playbookStepId: "software-change-delivery-transition-v1", taskKind: "implement", revisionIndex: 0, assignee: member.workerName, objective: task.objective, completionContractDigest: sha256(task.completionContract), sourceProfileDigest: sha256("profile-native-binding"), sourceSkillId: "implementor-controlled-implementation-v1", sourceSkillDigest: sha256("skill-native-binding"), inputRefs: [], createdAt: NOW });
  return { task: { spec: task, status: "assigned" }, member, projectBinding, taskBinding };
}

test("deployment binding joins Coordination TaskSpec to explicit legacy Runner authority", () => {
  const value = fixture();
  const prepared = createNativeRunnerDeploymentBinding(value);
  assert.equal(prepared.binding.taskId, value.task.spec.taskId);
  assert.equal(prepared.binding.workId, value.task.spec.workId);
  assert.equal(prepared.binding.assigneeMemberId, value.member.memberId);
  assert.match(prepared.binding.runId, /^run-/u);
  const otherMember = createMemberConfig({ memberId: value.member.memberId, teamId: value.member.teamId, workerName: "other-worker", matrixUserId: value.member.matrixUserId, role: value.member.role, controlProfileId: value.member.controlProfileId, enabled: true, createdAt: value.member.createdAt });
  assert.throws(() => createNativeRunnerDeploymentBinding({ ...value, member: otherMember }), /do not match/u);
  assert.throws(() => createNativeRunnerDeploymentBinding({ ...value, task: { ...value.task, status: "reported" } }), /assigned Coordination Task/u);
});

test("deployment prepares broker first and materializes an idempotent receipt", async () => {
  const value = fixture();
  const calls = [];
  const prepared = await prepareNativeRunnerDeployment({ ...value, preparationClient: { prepare: async (input) => { calls.push(input); return { taskId: value.task.spec.taskId, taskBindingDigest: value.taskBinding.contentDigest, bindingDigest: "a".repeat(64), endpointDigest: "b".repeat(64), replayed: false, schemaVersion: 1, status: "ready" }; } } });
  assert.equal(calls.length, 1);
  assert.equal(prepared.brokerReceipt.status, "ready");
  const root = await mkdtemp(join(tmpdir(), "tiangong-native-binding-"));
  try {
    const path = join(root, "binding.json");
    const first = await materializeNativeRunnerBinding({ filePath: path, binding: prepared.binding });
    const replay = await materializeNativeRunnerBinding({ filePath: path, binding: prepared.binding });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).bindingDigest, prepared.binding.bindingDigest);
    assert.deepEqual(nativeRunnerWorkerEnvironment({ bindingPath: path, journalPath: join(root, "journal.jsonl"), memberId: value.member.memberId, workerName: value.member.workerName }), {
      TIANGONG_NATIVE_RUNNER_ENABLED: "1",
      TIANGONG_NATIVE_RUNNER_EXEC_POLICY: "deny",
      TIANGONG_RUNNER_BINDING_FILE: path,
      TIANGONG_NATIVE_RUNNER_JOURNAL_FILE: join(root, "journal.jsonl"),
      TIANGONG_MEMBER_ID: value.member.memberId,
      AGENTTEAMS_WORKER_NAME: value.member.workerName,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
