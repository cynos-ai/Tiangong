import { Type } from "typebox";

import { sha256 } from "../canonical-json.mjs";
import { evidenceBoundary, projectReviewEvidence } from "../evidence/projection.mjs";
import { ReviewInspectionBoundary } from "../practices/review-inspection-lock.mjs";
import { TiangongToolRegistry } from "../tools/registry.mjs";
import { createGatedTool } from "../tools/wrapper.mjs";
import {
  directoryInspectionEvidenceMetadata,
  executeDirectoryInspection,
  prepareDirectoryInspection,
  REVIEWER_DIRECTORY_DEFINITION,
} from "./reviewer-directory.mjs";
import {
  executeReviewerRead,
  prepareReviewerRead,
  REVIEWER_READ_DEFINITION,
  reviewerReadEvidenceMetadata,
} from "./reviewer-read.mjs";
import { durableReviewerReplay } from "./reviewer-replay.mjs";
import {
  executeRepositoryInspection,
  prepareRepositoryInspection,
  repositoryInspectionEvidenceMetadata,
  REVIEWER_REPOSITORY_DEFINITION,
} from "./reviewer-repository.mjs";
import { createReviewerStateToolRegistry } from "./state-tools.mjs";

const TARGET_ID = Type.String({ minLength: 43, maxLength: 43 });
const OBSERVATION_TARGET = Type.Union([
  Type.Object({ targetId: TARGET_ID }, { additionalProperties: false }),
  Type.Object({ targetId: TARGET_ID, lineStart: Type.Integer({ minimum: 1 }), lineEnd: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  Type.Object({ targetId: TARGET_ID, memberPath: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
  Type.Object({
    targetId: TARGET_ID,
    memberPath: Type.String({ minLength: 1, maxLength: 1024 }),
    lineStart: Type.Integer({ minimum: 1 }),
    lineEnd: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
]);

const CLAIM = Type.Object({
  criteriaResults: Type.Array(Type.Object({
    criterionId: Type.String({ minLength: 1, maxLength: 64 }),
    status: Type.Union([Type.Literal("addressed"), Type.Literal("not_addressed")]),
    explanation: Type.String({ minLength: 1, maxLength: 16384 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
  scope: Type.Object({
    targetIds: Type.Array(TARGET_ID, { minItems: 1, maxItems: 64 }),
  }, { additionalProperties: false }),
  report: Type.Object({
    outcome: Type.Union([Type.Literal("accept"), Type.Literal("changes_requested"), Type.Literal("blocked")]),
    synopsis: Type.String({ minLength: 1, maxLength: 16384 }),
    observations: Type.Array(Type.Object({
      level: Type.Union([Type.Literal("critical"), Type.Literal("major"), Type.Literal("minor"), Type.Literal("note")]),
      target: OBSERVATION_TARGET,
      statement: Type.String({ minLength: 1, maxLength: 16384 }),
      rationale: Type.String({ minLength: 1, maxLength: 16384 }),
      suggestedAction: Type.String({ minLength: 1, maxLength: 16384 }),
      confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    }, { additionalProperties: false }), { maxItems: 256 }),
    limitations: Type.Array(Type.Object({
      code: Type.Literal("STATIC_REVIEW_ONLY"),
      detail: Type.String({ minLength: 1, maxLength: 16384 }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 1 }),
    nextActions: Type.Array(Type.String({ minLength: 1, maxLength: 16384 }), { maxItems: 256 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const CHECK_DEFINITION = Object.freeze({
  name: "check_completion",
  label: "Check review completion",
  description: "Submit the structured target-bound static-review claim for machine checkpoint evaluation.",
  parameters: Type.Object({ completionClaim: CLAIM }, { additionalProperties: false }),
});

function invocationForTool(invocation, toolCallId) {
  return {
    sessionId: invocation.sessionId,
    turnId: invocation.turnId,
    toolCallId,
    actor: invocation.actor,
    ingress: invocation.ingress,
    profileDigest: invocation.profileDigest,
  };
}

function completionToolResult(result) {
  const failed = result.checkpointResult.results.filter((item) => !item.satisfied).map((item) => item.reasonCode);
  return {
    content: [{
      type: "text",
      text: result.checkpointResult.allSatisfied
        ? `Review checkpoint passed. PracticeRun is done with outcome ${result.claim.report.outcome}.`
        : `Review checkpoint failed; PracticeRun remains active. Reasons: ${failed.join(", ")}.`,
    }],
    details: {
      replayed: result.replayed === true,
      stateEventId: result.stateEventId,
      stateEventHash: result.terminalHash,
      stateSequence: result.sequence,
      eventType: result.eventType,
      runId: result.run.runId,
      status: result.run.status,
      runRevision: result.run.revision,
      scopeRevision: result.run.scope.revision,
      checkpointPassed: result.checkpointResult.allSatisfied,
      checkpointReasonCodes: failed,
      claimDigest: result.checkpointResult.claimDigest,
      evidenceTerminalHash: result.checkpointResult.evidenceTerminalHash,
    },
  };
}

export function createReviewerToolRegistry({ service, gate, evidence, getInvocation, inspectionLockPath }) {
  const registry = new TiangongToolRegistry();
  const stateRegistry = createReviewerStateToolRegistry({ service, gate, evidence, getInvocation });
  for (const definition of stateRegistry.definitions()) registry.register(definition);

  const readPrepared = new WeakMap();
  registry.register(createGatedTool({
    definition: REVIEWER_READ_DEFINITION,
    category: "read-only",
    async beforeProposal(params, { toolCallId, invocation }) {
      const toolInvocation = invocationForTool(invocation, toolCallId);
      const replay = await durableReviewerReplay({ service, evidence, toolName: "read", params, invocation: toolInvocation });
      if (replay) return replay;
      const prepared = await prepareReviewerRead({ service, params, invocation: toolInvocation });
      readPrepared.set(prepared.operation, prepared);
      return prepared;
    },
    async summarize(_params, { preflight }) { return preflight.operation; },
    gate,
    evidence,
    getInvocation,
    async executeOperation({ operation, actionDigest }) {
      const prepared = readPrepared.get(operation);
      readPrepared.delete(operation);
      if (!prepared || sha256(operation) !== actionDigest) {
        throw new Error("Prepared review read does not match its wrapped operation");
      }
      return executeReviewerRead(prepared, { service, actionDigest });
    },
    completionMetadata: reviewerReadEvidenceMetadata,
    resultProjection(result) {
      return { content: result.content, details: result.details };
    },
  }));

  const inspectionPrepared = new WeakMap();
  registry.register(createGatedTool({
    definition: REVIEWER_DIRECTORY_DEFINITION,
    category: "read-only",
    async beforeProposal(params, { toolCallId, invocation }) {
      const toolInvocation = invocationForTool(invocation, toolCallId);
      const replay = await durableReviewerReplay({
        service, evidence, toolName: "inspect_directory", params, invocation: toolInvocation,
      });
      if (replay) return replay;
      const prepared = await prepareDirectoryInspection({ service, params, invocation: toolInvocation });
      inspectionPrepared.set(prepared.operation, prepared);
      return prepared;
    },
    async summarize(_params, { preflight }) { return preflight.operation; },
    gate,
    evidence,
    getInvocation,
    executionBoundary: new ReviewInspectionBoundary({ evidence, lockPath: inspectionLockPath }),
    async executeOperation({ operation, actionDigest }) {
      const prepared = inspectionPrepared.get(operation);
      inspectionPrepared.delete(operation);
      if (!prepared || sha256(operation) !== actionDigest) {
        throw new Error("Prepared directory inspection does not match its wrapped operation");
      }
      return executeDirectoryInspection(prepared, { service, actionDigest });
    },
    completionMetadata: directoryInspectionEvidenceMetadata,
    resultProjection(result) {
      return { content: result.content, details: result.details };
    },
  }));

  const repositoryPrepared = new WeakMap();
  registry.register(createGatedTool({
    definition: REVIEWER_REPOSITORY_DEFINITION,
    category: "read-only",
    async beforeProposal(params, { toolCallId, invocation }) {
      const toolInvocation = invocationForTool(invocation, toolCallId);
      const replay = await durableReviewerReplay({
        service, evidence, toolName: "inspect_repository", params, invocation: toolInvocation,
      });
      if (replay) return replay;
      const prepared = await prepareRepositoryInspection({ service, params, invocation: toolInvocation });
      repositoryPrepared.set(prepared.operation, prepared);
      return prepared;
    },
    async summarize(_params, { preflight }) { return preflight.operation; },
    gate,
    evidence,
    getInvocation,
    executionBoundary: new ReviewInspectionBoundary({ evidence, lockPath: inspectionLockPath }),
    async executeOperation({ operation, actionDigest }) {
      const prepared = repositoryPrepared.get(operation);
      repositoryPrepared.delete(operation);
      if (!prepared || sha256(operation) !== actionDigest) {
        throw new Error("Prepared repository inspection does not match its wrapped operation");
      }
      return executeRepositoryInspection(prepared, { service, actionDigest });
    },
    completionMetadata: repositoryInspectionEvidenceMetadata,
    resultProjection(result) {
      return { content: result.content, details: result.details };
    },
  }));

  const completionPrepared = new WeakMap();
  registry.register(createGatedTool({
    definition: CHECK_DEFINITION,
    category: "state-transition",
    async beforeProposal(params, { toolCallId, invocation }) {
      const prepared = await service.prepareCompletion(
        params,
        invocationForTool(invocation, toolCallId),
        () => evidenceBoundary(evidence),
      );
      completionPrepared.set(prepared.operation, prepared);
      return prepared;
    },
    async summarize(_params, { preflight }) { return preflight.operation; },
    gate,
    evidence,
    getInvocation,
    async executeOperation({ operation, actionDigest, invocationKey, invocation }) {
      const prepared = completionPrepared.get(operation);
      completionPrepared.delete(operation);
      if (!prepared || sha256(operation) !== actionDigest
          || (prepared.replay?.invocationKey ?? prepared.invocationKey) !== invocationKey) {
        throw new Error("Prepared completion does not match its wrapped operation");
      }
      let result;
      if (prepared.replay) result = await service.commitCompletion(prepared);
      else {
        const claim = await service.persistCompletionClaim(prepared);
        const projection = await projectReviewEvidence({
          evidence,
          boundary: prepared.evidenceBoundary,
          run: prepared.run,
          targetCapture: service.targetCapture,
          artifactStore: service.artifactStore,
        });
        result = await service.commitCompletion(prepared, projection, claim);
      }
      invocation.observability?.checkpoint(
        result.checkpointResult.allSatisfied ? "practice.checkpoint.pass" : "practice.checkpoint.fail",
        {
          "tiangong.practice.id": result.run.practiceId,
          "tiangong.practice.status": result.run.status,
          "tiangong.practice.target_count": result.run.scope.targets.length,
          "tiangong.practice.revision": result.run.revision,
          "tiangong.operation.outcome": result.claim.report.outcome,
        },
      );
      return completionToolResult(result);
    },
  }));

  const ordered = new TiangongToolRegistry();
  const byName = new Map(registry.definitions().map((definition) => [definition.name, definition]));
  for (const name of [
    "start_work", "extend_scope", "read", "inspect_directory", "inspect_repository", "check_completion", "abandon_work",
  ]) {
    ordered.register(byName.get(name));
  }
  return ordered;
}
