import { EvidenceRecorder } from "../evidence/recorder.mjs";
import { TeamCoordinationGate } from "./tool-wrapper.mjs";
import { createTeamChannel } from "./channel-adapter.mjs";
import { createRemoteCoordinationStore } from "./coordination-control-client.mjs";
import { createTeamSync } from "./sync-adapter.mjs";
import { defaultStateDirectory } from "../session-store.mjs";
import { workerStatePaths } from "../persistence/state-paths.mjs";
import { defaultTiangongRoot } from "./shared-fs.mjs";
import { readPlaybookManifest } from "../playbook/resolver.mjs";
import { projectDisposition } from "../team/project-chain.mjs";
import { createRunnerBrokerPreparationClient } from "../runner/preparation-client.mjs";
import { createLeaderToolRegistry } from "../work/leader-tools.mjs";
import { TurnGateState } from "../gates/turn-state.mjs";

const LEADER_ROLE = "leader";
const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;
const TOOL_NAMES = Object.freeze([
  "team_create_project",
  "team_dispatch_task",
  "team_check_result",
  "team_decide_task",
  "team_report",
  "team_read_coordination_work",
]);

function required(value, name) {
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  return value;
}

/**
 * AgentTeams v1.2.2 already projects the authoritative Leader role as
 * AGENTTEAMS_WORKER_ROLE=team_leader, but it has no field for Tiangong's
 * plugin role id. Accept that one upstream identity assertion as equivalent
 * to the explicit deployment projection; all professional roles still need
 * their explicit Tiangong role binding.
 */
export function isLeaderEnvironment(env = process.env) {
  return env?.TIANGONG_ROLE_ID === LEADER_ROLE || env?.AGENTTEAMS_WORKER_ROLE === "team_leader";
}

function effectiveLeaderEnvironment(env) {
  if (env?.TIANGONG_ROLE_ID === LEADER_ROLE) return env;
  return Object.freeze({ ...env, TIANGONG_ROLE_ID: LEADER_ROLE });
}

function leaderMatrixId(env) {
  const name = required(env.AGENTTEAMS_WORKER_NAME, "AGENTTEAMS_WORKER_NAME");
  const domain = required(env.AGENTTEAMS_MATRIX_DOMAIN, "AGENTTEAMS_MATRIX_DOMAIN");
  const value = `@${name}:${domain}`;
  if (!MATRIX_USER_ID.test(value)) throw new Error("Leader Matrix identity is invalid");
  return value;
}

function invocationFor(context, env) {
  const sessionId = context.sessionId ?? context.sessionKey;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("OpenClaw Leader session context is unavailable");
  }
  const actorId = context.requesterSenderId;
  if (typeof actorId !== "string" || !MATRIX_USER_ID.test(actorId)) {
    throw new Error("OpenClaw Leader requester identity is unavailable");
  }
  return Object.freeze({
    sessionId,
    turnId: `${sessionId}:openclaw-leader`,
    actor: Object.freeze({ id: actorId, channel: context.messageChannel ?? "matrix" }),
    ingress: Object.freeze({ channel: context.messageChannel ?? "matrix", sessionKey: context.sessionKey ?? sessionId }),
    resumed: false,
    turnState: new TurnGateState(),
    observability: null,
    workerName: env.AGENTTEAMS_WORKER_NAME,
  });
}

/**
 * Register Tiangong's closed Leader coordination surface as ordinary
 * OpenClaw tools. The model remains in OpenClaw's embedded runtime; this
 * adapter only projects the existing deterministic tool definitions into the
 * upstream tool registry and supplies the authenticated Matrix invocation
 * context that the Gate requires.
 */
export function registerLeaderOpenClawTools(api, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!isLeaderEnvironment(env)) return { enabled: false };
  if (typeof api?.registerTool !== "function") throw new Error("OpenClaw registerTool API is unavailable");
  const leaderEnv = effectiveLeaderEnvironment(env);
  const endpoint = required(env.TIANGONG_COORDINATION_CONTROL_ENDPOINT, "TIANGONG_COORDINATION_CONTROL_ENDPOINT");
  const token = required(env.TIANGONG_COORDINATION_CONTROL_TOKEN, "TIANGONG_COORDINATION_CONTROL_TOKEN");
  const playbook = readPlaybookManifest("software-change-delivery");
  const workerName = required(env.AGENTTEAMS_WORKER_NAME, "AGENTTEAMS_WORKER_NAME");
  leaderMatrixId(env);

  api.registerTool((context = {}) => {
    const workspaceDir = context.workspaceDir ?? `/root/agentteams-fs/agents/${workerName}`;
    const stateDirectory = defaultStateDirectory(workspaceDir);
    const paths = workerStatePaths(stateDirectory);
    const evidence = new EvidenceRecorder({ filePath: paths.evidenceFilePath });
    const channel = createTeamChannel({ evidence, env: leaderEnv, fetchImpl });
    const coordinationStore = createRemoteCoordinationStore({ endpoint, token, fetchImpl });
    const invocation = invocationFor(context, env);
    const deps = {
      rootDir: defaultTiangongRoot(env),
      env: leaderEnv,
      channel,
      sync: createTeamSync(),
      evidence,
      gate: new TeamCoordinationGate(),
      getInvocation: () => invocation,
      maxRevisionWaves: playbook.maxRevisionWaves,
      getProjectDisposition: (projectId) => projectDisposition(projectId, deps),
      runnerBrokerPreparation: createRunnerBrokerPreparationClient(),
      coordinationStore,
    };
    return createLeaderToolRegistry({ playbook, deps }).definitions();
  }, { names: [...TOOL_NAMES] });

  return { enabled: true, tools: [...TOOL_NAMES], runtime: "openclaw-built-in" };
}
