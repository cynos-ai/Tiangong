import { EvidenceRecorder } from "../evidence/recorder.mjs";
import { createRunnerBrokerPreparationClient } from "../runner/preparation-client.mjs";
import { RunnerJournal } from "../runner/journal.mjs";
import { runnerBrokerEndpointForWorker } from "../runner/broker-client.mjs";
import { deploymentBrokerEndpointForWorker } from "../deployment/client.mjs";
import { DeploymentReceiptStore } from "../deployment/receipt-store.mjs";
import { registryEntry } from "../roles/registry.mjs";
import { defaultStateDirectory } from "../session-store.mjs";
import { workerStatePaths } from "../persistence/state-paths.mjs";
import { IdempotencyStore } from "../idempotency/store.mjs";
import { PendingOperationStore } from "../pending-operation/store.mjs";
import { createAgentTeamsPendingStorage } from "../pending-operation/agentteams-storage.mjs";
import { WorkRunStore } from "../work/work-run-store.mjs";
import { defaultTiangongRoot } from "./shared-fs.mjs";
import { createTeamChannel } from "./channel-adapter.mjs";
import { createTeamSync } from "./sync-adapter.mjs";
import { TeamCoordinationGate } from "./tool-wrapper.mjs";
import { createMemberToolRegistry } from "../work/member-tools.mjs";
import { TurnGateState } from "../gates/turn-state.mjs";

const MEMBER_ROLES = new Set(["designer", "implementor", "assessor", "operator"]);
const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;

function required(value, name) {
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  return value;
}

function invocationFor(context, env) {
  const sessionId = context.sessionId ?? context.sessionKey;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("OpenClaw member session context is unavailable");
  const actorId = context.requesterSenderId;
  if (typeof actorId !== "string" || !MATRIX_USER_ID.test(actorId)) throw new Error("OpenClaw member requester identity is unavailable");
  return Object.freeze({
    sessionId,
    turnId: `${sessionId}:openclaw-member`,
    actor: Object.freeze({ id: actorId, channel: context.messageChannel ?? "matrix" }),
    ingress: Object.freeze({ channel: context.messageChannel ?? "matrix", sessionKey: context.sessionKey ?? sessionId }),
    resumed: false,
    turnState: new TurnGateState(),
    observability: null,
    workerName: required(env.AGENTTEAMS_WORKER_NAME, "AGENTTEAMS_WORKER_NAME"),
  });
}

/**
 * Project the existing deterministic member tool registry into OpenClaw's
 * embedded runtime. OpenClaw owns the model loop; Tiangong still owns the
 * bound Task/Result, Runner, WorkRun, and evidence contracts.
 */
export function registerMemberOpenClawTools(api, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const role = env.TIANGONG_ROLE_ID;
  if (!MEMBER_ROLES.has(role)) return { enabled: false };
  if (typeof api?.registerTool !== "function") throw new Error("OpenClaw registerTool API is unavailable");
  const roleEntry = registryEntry("roles", role);
  const skillEntry = roleEntry ? registryEntry("skills", roleEntry.skillIds[0]) : undefined;
  if (roleEntry?.runtimeKind !== "member" || !skillEntry) throw new Error("OpenClaw member role does not match the fixed Tiangong profile");
  const names = ["team_resolve_task", "team_submit_result"];
  if (role === "implementor") names.push("run_command");
  if (role === "assessor") names.push("run_test_command");
  if (role === "operator") names.push("deploy_release");
  api.registerTool((context = {}) => {
    const workerName = required(env.AGENTTEAMS_WORKER_NAME, "AGENTTEAMS_WORKER_NAME");
    const workspaceDir = context.workspaceDir ?? `/root/agentteams-fs/agents/${workerName}`;
    const stateDirectory = defaultStateDirectory(workspaceDir);
    const paths = workerStatePaths(stateDirectory);
    const evidence = new EvidenceRecorder({ filePath: paths.evidenceFilePath });
    const channel = createTeamChannel({ evidence, env, fetchImpl });
    const teamDeps = {
      rootDir: defaultTiangongRoot(env),
      env,
      channel,
      sync: createTeamSync(),
      evidence,
      gate: new TeamCoordinationGate(),
      getInvocation: () => invocationFor(context, env),
      professionalRole: role,
      sourceProfileDigest: roleEntry.profileDigest,
      sourceSkillId: skillEntry.id,
      sourceSkillDigest: skillEntry.digest,
      idempotencyStore: new IdempotencyStore({ filePath: paths.idempotencyFilePath }),
      pendingOperationStore: new PendingOperationStore({
        directory: paths.pendingOperationDirectory,
        remoteStorage: createAgentTeamsPendingStorage({ workspaceDir }),
      }),
      workRunStore: new WorkRunStore({
        directory: paths.workRunDirectory,
        ...(env.TIANGONG_WORK_RUN_OWNER_ID ? { ownerId: env.TIANGONG_WORK_RUN_OWNER_ID } : {}),
      }),
      deploymentBrokerEndpoint: deploymentBrokerEndpointForWorker({ role, env }),
      deploymentReceiptStore: role === "operator"
        ? new DeploymentReceiptStore({ filePath: paths.deploymentReceiptFilePath })
        : undefined,
      runnerBrokerEndpoint: runnerBrokerEndpointForWorker({ role, env }),
      runnerJournal: ["implementor", "assessor"].includes(role)
        ? new RunnerJournal({ filePath: paths.runnerJournalFilePath })
        : undefined,
      runnerBrokerPreparation: createRunnerBrokerPreparationClient({ endpoint: env.TIANGONG_RUNNER_BROKER_PREPARATION_ENDPOINT }),
      runnerFetch: fetchImpl,
      deploymentFetch: fetchImpl,
    };
    return createMemberToolRegistry({ deps: teamDeps }).definitions();
  }, { names });
  return { enabled: true, tools: names, runtime: "openclaw-built-in" };
}
