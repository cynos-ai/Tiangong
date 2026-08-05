import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createDeploymentOutcome } from "../agent/deployment/client.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { TurnGateState } from "../agent/gates/turn-state.mjs";
import { RUNNER_BROKER_ENDPOINT_DIGEST } from "../agent/runner/preparation-client.mjs";
import { TeamCoordinationGate } from "../agent/team/tool-wrapper.mjs";
import {
  projectDisposition,
} from "../agent/team/project-chain.mjs";
import {
  readTaskBinding,
  readTaskDecisions,
  readTaskResult,
  listTaskBindingsForProject,
} from "../agent/team/manifest-store.mjs";
import { submitResult } from "../agent/team/team-task-port.mjs";
import { createLeaderToolRegistry } from "../agent/work/leader-tools.mjs";
import { createChangeRevisionRef } from "../agent/work/change-revision-ref.mjs";
import { createResultEnvelope } from "../agent/work/result-envelope.mjs";
import { readPlaybookManifest } from "../agent/playbook/resolver.mjs";

const PLAYBOOK = readPlaybookManifest("software-change-delivery");
const LEADER = "phase4-leader";
const DESIGNER = "phase4-designer";
const IMPLEMENTOR = "phase4-implementor";
const ASSESSOR = "phase4-assessor";
const OPERATOR = "phase4-operator";
const PROJECT_ID = "phase4-run-r-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLE_BINDINGS = {
  designer: DESIGNER,
  implementor: IMPLEMENTOR,
  assessor: ASSESSOR,
  operator: OPERATOR,
};

let timeIndex = 0;
function nextTime() {
  const second = String(timeIndex++).padStart(2, "0");
  return `2026-08-04T00:00:${second}Z`;
}

function channel() {
  const calls = [];
  return {
    calls,
    async waitForTeamIdentity(role) { return { team: "phase4-team", role }; },
    async assertTeamIdentity(role) { return { team: "phase4-team", role }; },
    async assertTeamRoster() {
      return { roomId: "!phase4:example.test", roomIdDigest: "a".repeat(64), memberDigests: [] };
    },
    async notifyAssignee(worker, projectId, taskId, digest) {
      calls.push({ kind: "notifyAssignee", worker, projectId, taskId, digest });
      return { queued: true, delivered: false };
    },
    async notifyLeader(worker, projectId, taskId, digest) {
      calls.push({ kind: "notifyLeader", worker, projectId, taskId, digest });
      return { queued: true, delivered: false };
    },
    async reportRequester(requester, projectId, disposition, reportDigest) {
      calls.push({ kind: "reportRequester", requester, projectId, disposition, reportDigest });
      return { queued: true, delivered: false };
    },
  };
}

function depsFor(rootDir, workerName) {
  const evidence = new EvidenceRecorder({
    filePath: join(rootDir, "evidence.jsonl"),
    clock: () => new Date("2026-08-04T00:00:00.000Z"),
  });
  return {
    rootDir,
    env: {
      AGENTTEAMS_WORKER_NAME: workerName,
      AGENTTEAMS_WORKER_ROLE: workerName === LEADER ? "team_leader" : "worker",
      AGENTTEAMS_WORKER_ROOM_ID: `room-${workerName}`,
      AGENTTEAMS_MATRIX_DOMAIN: "example.test",
    },
    channel: channel(),
    sync: {
      async beforeRead() {},
      async afterWrite() {},
    },
    evidence,
    gate: new TeamCoordinationGate(),
    getInvocation: () => ({
      sessionId: `session-${workerName}`,
      turnId: `turn-${workerName}`,
      actor: { id: "@human:example.test" },
      turnState: new TurnGateState(),
      resumed: false,
    }),
    now: nextTime,
    runnerBrokerPreparation: {
      async prepare({ taskBinding }) {
        return {
          schemaVersion: 1,
          status: "ready",
          taskId: taskBinding.taskId,
          taskBindingDigest: taskBinding.contentDigest,
          bindingDigest: sha256(`runner-binding:${taskBinding.taskId}`),
          endpointDigest: RUNNER_BROKER_ENDPOINT_DIGEST,
          replayed: false,
        };
      },
    },
  };
}

function leaderRegistry(rootDir) {
  const deps = depsFor(rootDir, LEADER);
  deps.getProjectDisposition = (projectId) => projectDisposition(projectId, deps);
  return {
    deps,
    registry: createLeaderToolRegistry({ playbook: PLAYBOOK, deps }),
  };
}

function tool(registry, name) {
  const definition = registry.definitions().find((entry) => entry.name === name);
  assert.ok(definition, `missing Leader tool: ${name}`);
  return definition;
}

function resultFor(task, { changeRevisionRef, revisionRequest, releaseOutcome, claim = `${task.taskKind} complete` }) {
  return createResultEnvelope({
    taskId: task.taskId,
    projectId: task.projectId,
    producer: task.assignee,
    taskKind: task.taskKind,
    revisionIndex: task.revisionIndex,
    sourceRole: {
      design: "designer",
      implement: "implementor",
      assess: "assessor",
      release: "operator",
    }[task.taskKind],
    playbookDigest: PLAYBOOK.contentDigest,
    taskBindingDigest: task.contentDigest,
    completionContractDigest: task.completionContractDigest,
    sourceProfileDigest: task.sourceProfileDigest,
    sourceSkillId: task.sourceSkillId,
    skillDigest: task.sourceSkillDigest,
    claim,
    evidenceRefs: [`evidence-${task.taskId}`],
    ...(changeRevisionRef ? { changeRevisionRef } : {}),
    ...(revisionRequest ? { revisionRequest } : {}),
    ...(releaseOutcome ? { releaseOutcome } : {}),
    createdAt: nextTime(),
  });
}

async function dispatch(registry, params) {
  return (await tool(registry, "team_dispatch_task").execute(`dispatch-${params.taskId}`, {
    projectId: PROJECT_ID,
    objective: `Complete ${params.taskKind} revision ${params.revisionIndex}.`,
    ...params,
  })).details;
}

async function decide(registry, taskId, decision) {
  return (await tool(registry, "team_decide_task").execute(`decide-${taskId}-${decision}`, {
    taskId,
    decision,
  })).details;
}

async function submit(rootDir, task, result) {
  return submitResult(result, depsFor(rootDir, task.assignee));
}

async function task(rootDir, taskId) {
  return readTaskBinding(taskId, { rootDir });
}

async function withRoot(fn) {
  const rootDir = await mkdtemp(join(tmpdir(), "tiangong-phase4-"));
  try {
    await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("Phase 4 Run R keeps revision, recovery disposition, and Leader restart state machine-bound", async () => {
  await withRoot(async (rootDir) => {
    const first = leaderRegistry(rootDir);
    await tool(first.registry, "team_create_project").execute("create-project", {
      projectId: PROJECT_ID,
      roleBindings: ROLE_BINDINGS,
    });
    await dispatch(first.registry, {
      taskId: "phase4-design-0",
      taskKind: "design",
      revisionIndex: 0,
      assignee: DESIGNER,
    });
    const design = await task(rootDir, "phase4-design-0");
    await submit(rootDir, design, resultFor(design, { claim: "bounded design" }));

    // Restart at submit-before-accept: the new Leader instance reads the
    // durable ResultEnvelope and creates the one terminal decision.
    const afterDesignRestart = leaderRegistry(rootDir);
    assert.equal((await decide(afterDesignRestart.registry, design.taskId, "accept")).replayed, false);

    await dispatch(afterDesignRestart.registry, {
      taskId: "phase4-implement-0",
      taskKind: "implement",
      revisionIndex: 0,
      assignee: IMPLEMENTOR,
      inputRefs: [design.taskId],
    });
    const implement0 = await task(rootDir, "phase4-implement-0");
    const revision0 = createChangeRevisionRef({
      producerTaskId: implement0.taskId,
      artifactPath: "objects/phase4/revision-0.tar",
      artifactDigest: sha256("phase4-artifact-revision-0"),
      revision: 0,
    });
    await submit(rootDir, implement0, resultFor(implement0, { changeRevisionRef: revision0, claim: "revision zero" }));
    await decide(afterDesignRestart.registry, implement0.taskId, "accept");

    await dispatch(afterDesignRestart.registry, {
      taskId: "phase4-assess-0",
      taskKind: "assess",
      revisionIndex: 0,
      assignee: ASSESSOR,
      inputRefs: [implement0.taskId],
    });
    const assess0 = await task(rootDir, "phase4-assess-0");
    await submit(rootDir, assess0, resultFor(assess0, {
      changeRevisionRef: revision0,
      revisionRequest: { summary: "The Assessor-only verification condition is not satisfied." },
      claim: "revision required",
    }));
    await decide(afterDesignRestart.registry, assess0.taskId, "revision");

    // Restart immediately after the transition boundary. Replaying the same
    // immutable dispatch is safe and does not create a second Task binding.
    const afterTransitionRestart = leaderRegistry(rootDir);
    const implement1Dispatch = await dispatch(afterTransitionRestart.registry, {
      taskId: "phase4-implement-1",
      taskKind: "implement",
      revisionIndex: 1,
      assignee: IMPLEMENTOR,
      inputRefs: [assess0.taskId],
    });
    assert.equal(implement1Dispatch.replayed, false);
    const implement1Replay = await dispatch(afterTransitionRestart.registry, {
      taskId: "phase4-implement-1",
      taskKind: "implement",
      revisionIndex: 1,
      assignee: IMPLEMENTOR,
      inputRefs: [assess0.taskId],
    });
    assert.equal(implement1Replay.replayed, true);
    assert.equal((await listTaskBindingsForProject(PROJECT_ID, { rootDir })).filter((entry) => entry.taskId === "phase4-implement-1").length, 1);
    const implement1 = await task(rootDir, "phase4-implement-1");
    const revision1 = createChangeRevisionRef({
      producerTaskId: implement1.taskId,
      artifactPath: "objects/phase4/revision-1.tar",
      artifactDigest: sha256("phase4-artifact-revision-1"),
      revision: 1,
    });
    assert.notEqual(revision1.artifactDigest, revision0.artifactDigest);
    await submit(rootDir, implement1, resultFor(implement1, { changeRevisionRef: revision1, claim: "revision one" }));
    await decide(afterTransitionRestart.registry, implement1.taskId, "accept");

    await dispatch(afterTransitionRestart.registry, {
      taskId: "phase4-assess-1",
      taskKind: "assess",
      revisionIndex: 1,
      assignee: ASSESSOR,
      inputRefs: [implement1.taskId],
    });
    const assess1 = await task(rootDir, "phase4-assess-1");
    await submit(rootDir, assess1, resultFor(assess1, { changeRevisionRef: revision1, claim: "revision one accepted" }));
    await decide(afterTransitionRestart.registry, assess1.taskId, "accept");

    await assert.rejects(
      () => dispatch(afterTransitionRestart.registry, {
        taskId: "phase4-release-stale",
        taskKind: "release",
        revisionIndex: 0,
        assignee: OPERATOR,
        inputRefs: [assess0.taskId],
      }),
      /Expected revisionIndex 1/u,
    );

    await dispatch(afterTransitionRestart.registry, {
      taskId: "phase4-release-1",
      taskKind: "release",
      revisionIndex: 1,
      assignee: OPERATOR,
      inputRefs: [assess1.taskId],
    });
    const release = await task(rootDir, "phase4-release-1");

    // Restart while the release Task is durable but before its deployment
    // verification Result arrives. No Leader memory is needed to resume.
    const beforeVerifyRestart = leaderRegistry(rootDir);
    await assert.rejects(
      () => tool(beforeVerifyRestart.registry, "team_check_result").execute("check-before-verify", { taskId: release.taskId }),
      (error) => error?.code === "ENOENT",
    );

    const previousDigest = sha256("phase4-previous");
    const failedSafeOutcome = createDeploymentOutcome({
      taskId: release.taskId,
      targetId: "phase4-target",
      operationDigest: sha256("phase4-operation"),
      previousDigest,
      currentDigest: previousDigest,
      changeRevisionRef: revision1,
      disposition: "FAILED_SAFE",
      postVerifyHealthy: false,
      rollbackPerformed: true,
      previousVerifyHealthy: true,
    });
    await submit(rootDir, release, resultFor(release, {
      changeRevisionRef: revision1,
      releaseOutcome: failedSafeOutcome,
      claim: "new change was not delivered; previous digest restored and verified",
    }));

    const afterVerifyRestart = leaderRegistry(rootDir);
    const acceptedRelease = await decide(afterVerifyRestart.registry, release.taskId, "accept");
    assert.equal(acceptedRelease.terminalDisposition, "FAILED_SAFE");
    const reportTool = tool(afterVerifyRestart.registry, "team_report");
    const summary = "New change was not delivered; previous digest was restored and verified.";
    assert.equal((await reportTool.execute("report-failed-safe", {
      projectId: PROJECT_ID,
      summary,
      disposition: "FAILED_SAFE",
    })).details.queued, true);

    // Restart after deployment verification: exact decision and report replay
    // return the durable identities rather than creating a second transition or
    // terminal-report object.
    const finalRestart = leaderRegistry(rootDir);
    const decisionReplay = await decide(finalRestart.registry, release.taskId, "accept");
    assert.equal(decisionReplay.replayed, true);
    const reportReplay = await tool(finalRestart.registry, "team_report").execute("report-failed-safe-replay", {
      projectId: PROJECT_ID,
      summary,
      disposition: "FAILED_SAFE",
    });
    assert.equal(reportReplay.details.queued, true);

    assert.equal(await projectDisposition(PROJECT_ID, { rootDir }), "FAILED_SAFE");
    const storedReport = JSON.parse(await readFile(join(rootDir, "projects", PROJECT_ID, "tiangong", "terminal-report.json"), "utf8"));
    assert.equal(storedReport.disposition, "FAILED_SAFE");
    assert.equal((await readTaskDecisions(release.taskId, { rootDir })).length, 1);
    assert.equal((await readTaskResult(release.taskId, { rootDir })).releaseOutcome.disposition, "FAILED_SAFE");

    const evidence = await new EvidenceRecorder({
      filePath: join(rootDir, "evidence.jsonl"),
      clock: () => new Date("2026-08-04T00:00:00.000Z"),
    }).readAll();
    assert.ok(evidence.some((event) => event.type === "team.task.decision" && event.taskId === assess0.taskId));
    assert.ok(evidence.some((event) => event.type === "team.task.dispatch.replay" && event.taskId === implement1.taskId));
    assert.ok(evidence.some((event) => event.type === "team.report.delivered" && event.disposition === "FAILED_SAFE"));
  });
});

test("Phase 4 rollback uncertainty never upgrades to FAILED_SAFE", async () => {
  await withRoot(async (rootDir) => {
    const first = leaderRegistry(rootDir);
    await tool(first.registry, "team_create_project").execute("create-project", {
      projectId: PROJECT_ID,
      roleBindings: ROLE_BINDINGS,
    });
    // Use the pure disposition boundary here as the focused negative oracle;
    // the deployment broker tests separately prove both physical fault modes.
    const ref = createChangeRevisionRef({
      producerTaskId: "phase4-implement-negative",
      artifactPath: "objects/phase4/negative.tar",
      artifactDigest: sha256("phase4-negative-artifact"),
      revision: 0,
    });
    const outcome = createDeploymentOutcome({
      taskId: "phase4-release-negative",
      targetId: "phase4-target-negative",
      operationDigest: sha256("phase4-negative-operation"),
      previousDigest: sha256("phase4-negative-previous"),
      currentDigest: ref.artifactDigest,
      changeRevisionRef: ref,
      disposition: "RECOVERY_REQUIRED",
      postVerifyHealthy: false,
      rollbackPerformed: false,
      previousVerifyHealthy: null,
    });
    assert.equal(outcome.disposition, "RECOVERY_REQUIRED");
    assert.notEqual(outcome.currentDigest, outcome.previousDigest);
  });
});
