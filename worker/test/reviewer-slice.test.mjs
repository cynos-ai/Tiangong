import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRoleProfileBundle } from "../agent/config/role-profile.mjs";
import {
  buildReviewerContextPack,
  createReviewerContextExtension,
} from "../agent/context/reviewer-context.mjs";
import { evidenceBoundary, projectReviewEvidence } from "../agent/evidence/projection.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { ReviewerPracticeGate } from "../agent/gates/reviewer-practice-gate.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import { PracticeRunService } from "../agent/practices/practice-run-service.mjs";
import { deriveReviewNextAction } from "../agent/practices/review-next-action.mjs";
import { projectReviewReadCoverage } from "../agent/practices/review-read-coverage.mjs";
import { TiangongAgentRuntime } from "../agent/runtime.mjs";
import { createTurnRequest, createTurnResult } from "../agent/turn-contract.mjs";
import { TurnContextController } from "../agent/turn-context.mjs";
import { createReviewerToolRegistry } from "../agent/work/reviewer-tools.mjs";
import {
  completedReviewFileFacts,
  escapeMachineStatusMarker,
  renderCompletedReview,
  renderWorkStatus,
  workStatusForRun,
} from "../agent/work/status.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-reviewer-slice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await writeFile(join(root, "placeholder"), "x");
  await mkdir(workspace);
  await writeFile(join(workspace, "a.mjs"), "first\nsecond\nthird");
  await writeFile(join(workspace, "b.mjs"), "alpha\nbeta");
  const profileBundle = await loadRoleProfileBundle({
    profilePath: join(WORKER_ROOT, "role-profiles", "reviewer.json"),
    resourceRoot: WORKER_ROOT,
  });
  const practice = join(root, "practice");
  const service = new PracticeRunService({
    sessionId: "session-review",
    workspaceDir: workspace,
    profileBundle,
    journalPath: join(practice, "events.jsonl"),
    snapshotPath: join(practice, "snapshot.json"),
    protectedDirectory: join(practice, "protected"),
  });
  const evidence = new EvidenceRecorder({ filePath: join(root, "evidence", "events.jsonl") });
  const turns = new TurnContextController();
  const gate = new ReviewerPracticeGate({ profileBundle });
  const registry = createReviewerToolRegistry({
    workspaceDir: workspace,
    service,
    gate,
    evidence,
    getInvocation: turns.current,
  });
  const tools = Object.fromEntries(registry.definitions().map((definition) => [definition.name, definition]));
  function begin(turnId, prompt = "review these files", actorId = "@reviewer:example.test") {
    turns.begin({
      sessionId: "session-review",
      turnId,
      actor: { id: actorId, messageId: `$${turnId}` },
      ingress: { prompt },
      profileDigest: profileBundle.profileDigest,
    });
  }
  return { root, workspace, practice, profileBundle, service, evidence, turns, registry, tools, begin };
}

function claim(files = ["a.mjs"], overrides = {}) {
  return {
    criteriaResults: [{ criterionId: "criterion-1", status: "addressed", explanation: "Reviewed the complete selected version." }],
    scope: { files },
    report: {
      outcome: "accept",
      synopsis: "No blocking static-review findings.",
      observations: [],
      limitations: [{ code: "STATIC_REVIEW_ONLY", detail: "No tests or runtime commands were executed." }],
      nextActions: [],
      ...overrides,
    },
  };
}

async function start(f, files = ["a.mjs"], turn = "turn-start") {
  f.begin(turn);
  try {
    return await f.tools.start_work.execute("call-start", {
      practiceId: "review",
      objective: "Review selected files",
      acceptanceCriteria: ["Identify correctness risks"],
      files,
    });
  } finally {
    f.turns.end();
  }
}

async function readRange(f, params, turn = "turn-read", call = "call-read", actor) {
  f.begin(turn, "continue review", actor);
  try {
    return await f.tools.read.execute(call, params);
  } finally {
    f.turns.end();
  }
}

async function complete(f, completionClaim, turn = "turn-check", call = "call-check") {
  f.begin(turn, "finish review");
  try {
    return await f.tools.check_completion.execute(call, { completionClaim });
  } finally {
    f.turns.end();
  }
}

test("Reviewer slice proves complete scoped reads and completes exactly once", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.registry.names(), ["start_work", "extend_scope", "read", "check_completion", "abandon_work"]);
  await start(f);
  const read = await readRange(f, { path: "a.mjs", offset: 1, limit: 10 });
  assert.equal(read.content[0].text, "first\nsecond\nthird");
  assert.deepEqual({
    lines: read.details.fullFileLines,
    start: read.details.returnedLineStart,
    end: read.details.returnedLineEnd,
    truncated: read.details.truncated,
  }, { lines: 3, start: 1, end: 3, truncated: false });

  const completion = await complete(f, claim());
  assert.equal(completion.details.checkpointPassed, true);
  assert.equal(completion.details.status, "done");
  const run = await f.service.latestForActor("@reviewer:example.test");
  assert.equal(run.status, "done");
  assert.equal(run.lastCheckpoint.allSatisfied, true);
  const projection = await projectReviewEvidence({
    evidence: f.evidence,
    boundary: {
      sequence: run.lastCheckpoint.evidenceTerminalSequence,
      hash: run.lastCheckpoint.evidenceTerminalHash,
    },
    run,
  });
  const report = renderCompletedReview({
    run,
    claim: await f.service.claimForRun(run),
    fileFacts: completedReviewFileFacts(run, projection),
  });
  assert.match(report, /Machine completion facts/u);
  assert.match(report, new RegExp(read.details.fileDigest, "u"));

  const journal = (await readFile(join(f.practice, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(journal.map((entry) => entry.eventType), ["run.started", "run.completed"]);
  const evidence = await f.evidence.readAll();
  const readComplete = evidence.find((entry) => entry.type === "tool.execution.completed" && entry.toolName === "read");
  assert.equal(readComplete.practiceRunId, run.runId);
  assert.equal(readComplete.resultMetadata.fileDigest, read.details.fileDigest);
  assert.equal(JSON.stringify(evidence).includes("first"), false);
  assert.equal(JSON.stringify(journal).includes("No blocking"), false);

  const replay = await complete(f, claim(), "turn-check", "call-check");
  assert.equal(replay.details.replayed, true);
  const journalAfter = (await readFile(join(f.practice, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(journalAfter.length, 2);
});

test("partial and mixed-version coverage fail closed while a later complete version passes", async (t) => {
  const f = await fixture(t);
  await start(f);
  await readRange(f, { path: "a.mjs", offset: 1, limit: 1 });
  const failed = await complete(f, claim(), "turn-check-one", "call-check-one");
  assert.equal(failed.details.checkpointPassed, false);
  assert.ok(failed.details.checkpointReasonCodes.includes("SCOPE_READ_INCOMPLETE"));
  assert.equal((await f.service.activeForActor("@reviewer:example.test")).status, "active");

  await readRange(f, { path: "a.mjs", offset: 2, limit: 10 }, "turn-read-old-rest", "call-read-old-rest");
  await writeFile(join(f.workspace, "a.mjs"), "changed\nsecond\nthird");
  await readRange(f, { path: "a.mjs", offset: 2, limit: 10 }, "turn-read-two", "call-read-two");
  const mixed = await complete(f, claim(), "turn-check-two", "call-check-two");
  assert.ok(mixed.details.checkpointReasonCodes.includes("FILE_VERSION_MIXED"));

  await readRange(f, { path: "a.mjs", offset: 1, limit: 10 }, "turn-read-three", "call-read-three");
  const done = await complete(f, claim(), "turn-check-three", "call-check-three");
  assert.equal(done.details.checkpointPassed, true, "a complete current version supersedes incomplete older chunks");
});

test("Reviewer admission rejects a ContextPack that cannot remain bounded", async (t) => {
  const f = await fixture(t);
  f.begin("oversized-context", "large review");
  await assert.rejects(
    f.tools.start_work.execute("oversized-context-call", {
      practiceId: "review",
      objective: "Review selected files",
      acceptanceCriteria: Array.from({ length: 32 }, (_, index) => `${index}-${"x".repeat(1800)}`),
      files: ["a.mjs"],
    }),
    (error) => error.code === "CONTEXT_PACK_LIMIT_EXCEEDED",
  );
  f.turns.end();
  assert.equal((await f.service.state()).activeRunId, null);
});

test("Reviewer read rejects absent work, wrong actor, wrong scope, symlinks, binary, invalid UTF-8, and ranges", async (t) => {
  const f = await fixture(t);
  await assert.rejects(readRange(f, { path: "a.mjs" }), (error) => error.code === "ACTIVE_RUN_REQUIRED");
  await start(f);
  await assert.rejects(
    readRange(f, { path: "a.mjs" }, "wrong-actor", "wrong-call", "@other:example.test"),
    (error) => error.code === "RUN_REQUESTER_MISMATCH",
  );
  await assert.rejects(readRange(f, { path: "b.mjs" }, "out", "out-call"), (error) => error.code === "PATH_NOT_IN_PRACTICE_SCOPE");
  await symlink(join(f.workspace, "a.mjs"), join(f.workspace, "link.mjs"));
  await assert.rejects(readRange(f, { path: "link.mjs" }, "link", "link-call"), (error) => error.code === "SYMLINK_DENIED");
  await writeFile(join(f.workspace, "a.mjs"), Buffer.from([0, 1, 2]));
  await assert.rejects(readRange(f, { path: "a.mjs" }, "binary", "binary-call"), (error) => error.code === "BINARY_FILE_UNSUPPORTED");
  await writeFile(join(f.workspace, "a.mjs"), Buffer.from([0xff]));
  await assert.rejects(readRange(f, { path: "a.mjs" }, "utf8", "utf8-call"), (error) => error.code === "INVALID_UTF8");
  await writeFile(join(f.workspace, "a.mjs"), "one\ntwo");
  await assert.rejects(readRange(f, { path: "a.mjs", offset: 3 }, "range", "range-call"), (error) => error.code === "READ_RANGE_INVALID");
});

test("checkpoint enforces criteria, scope, observations, outcome, limitation, and not_addressed semantics", async (t) => {
  const f = await fixture(t);
  await start(f);
  await readRange(f, { path: "a.mjs" });

  await assert.rejects(
    complete(f, { ...claim(), extra: true }, "invalid", "invalid-call"),
    (error) => error.code === "CLAIM_SCHEMA_INVALID",
  );
  const blockedClaim = claim(["a.mjs"], {
    outcome: "blocked",
    nextActions: ["Provide runtime verification."],
  });
  blockedClaim.criteriaResults[0].status = "not_addressed";
  blockedClaim.criteriaResults[0].explanation = "Runtime execution is outside this static review.";
  const blocked = await complete(f, blockedClaim, "blocked", "blocked-call");
  assert.equal(blocked.details.checkpointPassed, true);
  assert.equal((await f.service.latestForActor("@reviewer:example.test")).status, "done");
});

test("checkpoint fail reasons are deterministic and never advance done", async (t) => {
  const f = await fixture(t);
  await start(f);
  await readRange(f, { path: "a.mjs" });
  const cases = [
    ["unknown-criterion", () => {
      const value = claim();
      value.criteriaResults[0].criterionId = "criterion-99";
      return value;
    }, "CRITERIA_COVERAGE_INVALID"],
    ["wrong-scope", () => claim(["b.mjs"]), "CLAIM_SCOPE_MISMATCH"],
    ["bad-target", () => {
      const value = claim();
      value.report.observations.push({
        level: "minor",
        target: { path: "b.mjs", lineStart: 1, lineEnd: 1 },
        statement: "Outside scope.",
        rationale: "Invalid target fixture.",
        suggestedAction: "None.",
        confidence: "high",
      });
      return value;
    }, "OBSERVATION_TARGET_INVALID"],
    ["bad-lines", () => {
      const value = claim();
      value.report.observations.push({
        level: "minor",
        target: { path: "a.mjs", lineStart: 1, lineEnd: 99 },
        statement: "Outside lines.",
        rationale: "Invalid range fixture.",
        suggestedAction: "None.",
        confidence: "high",
      });
      return value;
    }, "OBSERVATION_TARGET_INVALID"],
    ["bad-outcome", () => {
      const value = claim();
      value.report.observations.push({
        level: "major",
        target: { path: "a.mjs" },
        statement: "Major issue.",
        rationale: "Requires changes.",
        suggestedAction: "Change it.",
        confidence: "high",
      });
      return value;
    }, "REPORT_OUTCOME_INCONSISTENT"],
    ["bad-limitation", () => {
      const value = claim();
      value.report.limitations[0].code = "TESTED";
      return value;
    }, "STATIC_LIMITATION_REQUIRED"],
    ["not-addressed-accept", () => {
      const value = claim();
      value.criteriaResults[0] = {
        criterionId: "criterion-1",
        status: "not_addressed",
        explanation: "Needs execution.",
      };
      return value;
    }, "REPORT_OUTCOME_INCONSISTENT"],
  ];
  for (const [name, makeClaim, reason] of cases) {
    const result = await complete(f, makeClaim(), `turn-${name}`, `call-${name}`);
    assert.equal(result.details.checkpointPassed, false);
    assert.ok(result.details.checkpointReasonCodes.includes(reason), name);
    assert.equal((await f.service.activeForActor("@reviewer:example.test")).status, "active");
  }
});

test("final append-only scope requires complete Evidence for every file", async (t) => {
  const f = await fixture(t);
  await start(f);
  f.begin("turn-extend", "add b");
  try {
    await f.tools.extend_scope.execute("call-extend", { files: ["b.mjs"] });
  } finally {
    f.turns.end();
  }
  await readRange(f, { path: "a.mjs" }, "read-a", "call-a");
  const missing = await complete(f, claim(["a.mjs", "b.mjs"]), "check-missing-b", "call-missing-b");
  assert.ok(missing.details.checkpointReasonCodes.includes("SCOPE_READ_INCOMPLETE"));
  await readRange(f, { path: "b.mjs" }, "read-b", "call-b");
  const done = await complete(f, claim(["a.mjs", "b.mjs"]), "check-both", "call-both");
  assert.equal(done.details.checkpointPassed, true);
});

test("Reviewer nextAction rebuilds remaining scope from durable state and Evidence", async (t) => {
  const f = await fixture(t);
  await start(f);
  await readRange(f, { path: "a.mjs" }, "read-a-before-restart", "call-a-before-restart");
  f.begin("extend-before-restart", "add b");
  try {
    await f.tools.extend_scope.execute("extend-call-before-restart", { files: ["b.mjs"] });
  } finally {
    f.turns.end();
  }

  const restartedService = new PracticeRunService({
    sessionId: "session-review",
    workspaceDir: f.workspace,
    profileBundle: f.profileBundle,
    journalPath: join(f.practice, "events.jsonl"),
    snapshotPath: join(f.practice, "snapshot.json"),
    protectedDirectory: join(f.practice, "protected"),
  });
  const restartedEvidence = new EvidenceRecorder({ filePath: join(f.root, "evidence", "events.jsonl") });
  let run = await restartedService.activeForActor("@reviewer:example.test");
  let boundary = await evidenceBoundary(restartedEvidence);
  let evidenceProjection = await projectReviewEvidence({ evidence: restartedEvidence, boundary, run });
  let coverage = projectReviewReadCoverage(run, evidenceProjection);
  let nextAction = deriveReviewNextAction({ run, coverage, evidenceProjection });
  assert.deepEqual(nextAction, {
    code: "READ_REMAINING_SCOPE",
    targetRefs: ["scope-file-2"],
    reasonCodes: ["SCOPE_READ_INCOMPLETE"],
  });
  let beforeAgentStart;
  createReviewerContextExtension({
    service: restartedService,
    turns: f.turns,
    evidence: restartedEvidence,
    profileDigest: f.profileBundle.profileDigest,
  })({ on(_name, handler) { beforeAgentStart = handler; } });
  f.begin("context-after-restart", "continue review");
  const context = await beforeAgentStart({ systemPrompt: "base" });
  f.turns.end();
  assert.match(context.systemPrompt, /"code":"READ_REMAINING_SCOPE"/u);
  assert.match(context.systemPrompt, /"targetRefs":\["scope-file-2"\]/u);

  await readRange(f, { path: "b.mjs" }, "read-b-after-restart", "call-b-after-restart");
  run = await restartedService.activeForActor("@reviewer:example.test");
  boundary = await evidenceBoundary(restartedEvidence);
  evidenceProjection = await projectReviewEvidence({ evidence: restartedEvidence, boundary, run });
  coverage = projectReviewReadCoverage(run, evidenceProjection);
  nextAction = deriveReviewNextAction({ run, coverage, evidenceProjection });
  assert.deepEqual(nextAction, {
    code: "CHECK_COMPLETION",
    targetRefs: [],
    reasonCodes: [],
  });
});

test("Reviewer nextAction addresses a failed checkpoint after read coverage becomes complete", async (t) => {
  const f = await fixture(t);
  await start(f);
  await readRange(f, { path: "a.mjs", offset: 1, limit: 1 }, "partial-before-check", "partial-call");
  const failed = await complete(f, claim(), "failed-before-guidance", "failed-guidance-call");
  assert.equal(failed.details.checkpointPassed, false);
  await readRange(f, { path: "a.mjs", offset: 2, limit: 10 }, "complete-after-check", "complete-call");

  const run = await f.service.activeForActor("@reviewer:example.test");
  const boundary = await evidenceBoundary(f.evidence);
  const evidenceProjection = await projectReviewEvidence({ evidence: f.evidence, boundary, run });
  const coverage = projectReviewReadCoverage(run, evidenceProjection);
  const nextAction = deriveReviewNextAction({ run, coverage, evidenceProjection });
  assert.deepEqual(nextAction, {
    code: "ADDRESS_CHECKPOINT_FAILURE",
    targetRefs: [],
    reasonCodes: [...new Set(run.lastCheckpoint.results
      .filter((item) => !item.satisfied)
      .map((item) => item.reasonCode))],
  });
});

test("ambiguous or tampered Evidence fails before a completion state event", async (t) => {
  const ambiguous = await fixture(t);
  await start(ambiguous);
  await readRange(ambiguous, { path: "a.mjs" });
  const records = await ambiguous.evidence.readAll();
  const gate = records.find((entry) => entry.type === "gate.decided" && entry.toolName === "read");
  const { version, sequence, timestamp, previousHash, hash, ...duplicate } = gate;
  await ambiguous.evidence.append(duplicate);
  await assert.rejects(
    complete(ambiguous, claim(), "ambiguous-check", "ambiguous-call"),
    (error) => error.code === "EVIDENCE_AMBIGUOUS",
  );
  assert.deepEqual(
    (await ambiguous.service.state()).runs[(await ambiguous.service.state()).activeRunId].revision,
    1,
  );

  const tampered = await fixture(t);
  await start(tampered, ["a.mjs"], "tamper-start");
  await readRange(tampered, { path: "a.mjs" }, "tamper-read", "tamper-read-call");
  const evidencePath = tampered.evidence.filePath;
  const lines = (await readFile(evidencePath, "utf8")).trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  last.resultMetadata.fullFileLines += 1;
  lines[lines.length - 1] = JSON.stringify(last);
  await writeFile(evidencePath, `${lines.join("\n")}\n`);
  let beforeAgentStart;
  createReviewerContextExtension({
    service: tampered.service,
    turns: tampered.turns,
    evidence: tampered.evidence,
    profileDigest: tampered.profileBundle.profileDigest,
  })({ on(name, handler) {
    assert.equal(name, "before_agent_start");
    beforeAgentStart = handler;
  } });
  tampered.begin("tamper-context", "continue review");
  await assert.rejects(
    beforeAgentStart({ systemPrompt: "base" }),
    /Evidence hash mismatch/u,
  );
  tampered.turns.end();
  await assert.rejects(
    complete(tampered, claim(), "tamper-check", "tamper-call"),
    /Evidence hash mismatch/u,
  );
  assert.equal((await tampered.service.activeForActor("@reviewer:example.test")).revision, 1);
});

test("a committed completion survives wrapper Evidence failure and replays without duplicate state", async (t) => {
  const f = await fixture(t);
  await start(f);
  await readRange(f, { path: "a.mjs" });
  let failed = false;
  const failingEvidence = {
    readAll: () => f.evidence.readAll(),
    async append(event) {
      if (!failed && event.type === "tool.execution.completed" && event.toolName === "check_completion") {
        failed = true;
        throw new Error("injected completion Evidence failure");
      }
      return f.evidence.append(event);
    },
  };
  const failingRegistry = createReviewerToolRegistry({
    workspaceDir: f.workspace,
    service: f.service,
    gate: new ReviewerPracticeGate({ profileBundle: f.profileBundle }),
    evidence: failingEvidence,
    getInvocation: f.turns.current,
  });
  const failingCheck = failingRegistry.definitions().find((tool) => tool.name === "check_completion");
  f.begin("crash-check", "finish review");
  await assert.rejects(
    failingCheck.execute("crash-call", { completionClaim: claim() }),
    /injected completion Evidence failure/u,
  );
  f.turns.end();
  assert.equal((await f.service.latestForActor("@reviewer:example.test")).status, "done");

  const normalRegistry = createReviewerToolRegistry({
    workspaceDir: f.workspace,
    service: f.service,
    gate: new ReviewerPracticeGate({ profileBundle: f.profileBundle }),
    evidence: f.evidence,
    getInvocation: f.turns.current,
  });
  const normalCheck = normalRegistry.definitions().find((tool) => tool.name === "check_completion");
  f.begin("crash-check", "finish review");
  const replay = await normalCheck.execute("crash-call", { completionClaim: claim() });
  f.turns.end();
  assert.equal(replay.details.replayed, true);
  const journal = (await readFile(join(f.practice, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(journal.filter((entry) => entry.eventType === "run.completed").length, 1);
});

test("runtime rejects a mismatched requester before entering the model loop without run disclosure", async (t) => {
  const f = await fixture(t);
  const configPath = join(f.root, "openclaw.json");
  await writeFile(configPath, JSON.stringify({
    models: { providers: { "agentteams-gateway": {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "model-one", name: "Fixture", contextWindow: 32000, maxTokens: 100, reasoning: false, input: ["text"] }],
    } } },
  }));
  const paths = statePathsForSession({
    stateDirectory: join(f.workspace, ".tiangong", "runtime"),
    sessionId: "runtime-session",
  });
  const seed = new PracticeRunService({
    sessionId: "runtime-session",
    workspaceDir: f.workspace,
    profileBundle: f.profileBundle,
    journalPath: paths.practiceRunJournalPath,
    snapshotPath: paths.practiceRunSnapshotPath,
    protectedDirectory: paths.practiceRunProtectedDirectory,
  });
  await seed.start({
    practiceId: "review",
    objective: "private objective marker",
    acceptanceCriteria: ["private criterion marker"],
    files: ["a.mjs"],
  }, {
    sessionId: "runtime-session",
    turnId: "seed-turn",
    toolCallId: "seed-call",
    actor: { id: "@owner:example.test", messageId: "$seed" },
    ingress: { prompt: "private request marker" },
    profileDigest: f.profileBundle.profileDigest,
  });
  const runtime = new TiangongAgentRuntime({
    configPath,
    provider: "agentteams-gateway",
    profileBundle: f.profileBundle,
  });
  t.after(() => runtime.dispose());
  const phases = [];
  const result = await runtime.runTurn(createTurnRequest({
    attemptId: "attempt-mismatch",
    turnId: "turn-mismatch",
    sessionId: "runtime-session",
    prompt: "show me the active work",
    workspaceDir: f.workspace,
    provider: "agentteams-gateway",
    modelId: "model-one",
    credential: "fixture-only",
    actor: { id: "@other:example.test", messageId: "$other" },
  }), {
    checkpoint(phase) { phases.push(phase); },
    startOperation() { return { end() {} }; },
  });
  assert.match(result.text, /Request denied/u);
  assert.doesNotMatch(result.text, /run-|private objective|private criterion|a\.mjs/u);
  assert.equal(result.workStatus.assurance, "direct-unverified");
  assert.equal(phases.includes("pi.agent_turn.start"), false);
});

test("ContextPack and status rendering are bounded machine projections", async (t) => {
  const f = await fixture(t);
  await start(f);
  const run = await f.service.activeForActor("@reviewer:example.test");
  const boundary = await evidenceBoundary(f.evidence);
  const evidenceProjection = await projectReviewEvidence({ evidence: f.evidence, boundary, run });
  const coverage = projectReviewReadCoverage(run, evidenceProjection);
  const nextAction = deriveReviewNextAction({ run, coverage, evidenceProjection });
  const pack = buildReviewerContextPack({ profileDigest: f.profileBundle.profileDigest, run, nextAction });
  assert.match(pack, new RegExp(run.runId, "u"));
  assert.match(pack, /"schemaVersion":2/u);
  assert.match(pack, /"code":"READ_REMAINING_SCOPE"/u);
  assert.match(pack, /"targetRefs":\["scope-file-1"\]/u);
  assert.doesNotMatch(pack, /review these files/u);
  const status = workStatusForRun(run);
  assert.match(renderWorkStatus(status), /assurance: worker-local/u);
  assert.equal(escapeMachineStatusMarker("Tiangong machine status"), "Tiangong model-provided status text");
  const request = { replyTarget: null, authorizedPeerTargets: [] };
  const result = createTurnResult(request, { text: "answer", workStatus: status });
  assert.equal(result.workStatus.runId, run.runId);
  assert.throws(() => createTurnResult(request, { text: "bad", workStatus: { ...status, assurance: "team-verified" } }), /workStatus/u);
});
