import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { createGatedTool } from "../tools/wrapper.mjs";

const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;
const ALLOWED_TOOLS = new Set([
  "team_create_project",
  "team_dispatch_task",
  "team_check_result",
  "team_decide_task",
  "team_report",
  "team_resolve_task",
  "run_command",
  "run_test_command",
  "team_submit_result",
]);

export class TeamCoordinationGate {
  async evaluate(context) {
    if (!ALLOWED_TOOLS.has(context.operation?.toolName)) {
      return { kind: "deny", reason: "tool is outside the closed team surface", reasonCode: "TOOL_NOT_AUTHORIZED" };
    }
    if (!MATRIX_USER_ID.test(context.actorId ?? "")) {
      return {
        kind: "deny",
        reason: "an authenticated Matrix source is required for team coordination",
        reasonCode: "AUTHENTICATED_SOURCE_REQUIRED",
      };
    }
    return { kind: "allow" };
  }
}

function projectSafeParams(params) {
  const safe = {};
  for (const key of ["projectId", "taskId", "taskKind", "revisionIndex", "assignee", "completionContractDigest", "decision", "resultDigest", "disposition", "cwd", "timeoutMs", "outputLimitBytes"]) {
    if (params[key] !== undefined) safe[key] = params[key];
  }
  for (const key of ["roleBindings", "inputRefs", "artifactRefs", "evidenceRefs", "changeRevisionRef", "revisionRequest", "command"]) {
    if (params[key] !== undefined) safe[`${key}Digest`] = sha256(canonicalJson(params[key]));
  }
  for (const key of ["objective", "summary", "note", "claim", "blocker"]) {
    if (params[key] !== undefined) {
      safe[`${key}Digest`] = sha256(params[key]);
      safe[`${key}Bytes`] = Buffer.byteLength(params[key]);
    }
  }
  return safe;
}

export function wrapTeamTool(definition, { gate, evidence, getInvocation, category }) {
  if (!gate || !evidence?.append || typeof getInvocation !== "function") {
    throw new TypeError("Team tools require Gate, Evidence, and invocation context");
  }
  return createGatedTool({
    definition,
    summarize(params) {
      return {
        toolName: definition.name,
        contractVersion: "team-task-port-v1",
        params: projectSafeParams(params),
      };
    },
    gate,
    evidence,
    getInvocation,
    category,
    completionMetadata(result) {
      if (category !== "isolated-execution") return {};
      const runner = result?.details?.runnerEvidence;
      return {
        runnerOutcome: result?.details?.outcome ?? null,
        runnerInvocationKey: result?.details?.invocationKey ?? null,
        runnerReplayed: result?.details?.replayed === true,
        runnerExitCode: result?.details?.exitCode ?? null,
        runnerDurationMs: result?.details?.durationMs ?? null,
        runnerImageId: runner?.imageId ?? null,
        runnerPolicyDigest: runner?.policyDigest ?? null,
        runnerContainerConfigDigest: runner?.containerConfigDigest ?? null,
        runnerExecutionPlanDigest: runner?.executionPlanDigest ?? result?.details?.executionPlanDigest ?? null,
        runnerFixtureDigest: runner?.fixtureDigest ?? null,
        runnerChangeRevisionRefDigest: result?.details?.changeRevisionRef?.contentDigest ?? null,
        runnerChangeArtifactDigest: result?.details?.changeRevisionRef?.artifactDigest ?? null,
        runnerChangeProducerTaskId: result?.details?.changeRevisionRef?.producerTaskId ?? null,
      };
    },
    executeOperation({ toolCallId, params, signal, onUpdate, ctx, invocation }) {
      return definition.execute(toolCallId, params, signal, onUpdate, ctx, invocation);
    },
    evidenceOperation(operation) {
      return operation;
    },
  });
}
