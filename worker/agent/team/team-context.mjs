// TeamContextPort: load and validate the current Worker's authenticated
// team identity from AgentTeams runtime facts.
//
// Per the architecture baseline, team context must come from authenticated
// channel/runtime facts, never from Task prose or model parameters. A tool
// authorizes an operation by comparing this identity against the immutable
// binding's roleBindings / assignee.

const WORKER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const MATRIX_USER_PATTERN = /^@[A-Za-z0-9._=/+-]+:[A-Za-z0-9._:-]+$/u;
const MATRIX_DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/u;

export function loadWorkerIdentity({ env = process.env, openclaw } = {}) {
  const workerName = env.AGENTTEAMS_WORKER_NAME;
  if (typeof workerName !== "string" || !WORKER_NAME_PATTERN.test(workerName)) {
    throw new Error("AgentTeams Worker identity is missing or invalid");
  }
  const matrixUserId = openclaw?.channels?.matrix?.userId ?? null;
  if (matrixUserId !== null && (typeof matrixUserId !== "string" || !MATRIX_USER_PATTERN.test(matrixUserId))) {
    throw new Error(`Authenticated Matrix user id has an invalid format: ${matrixUserId}`);
  }
  const roomId = typeof env.AGENTTEAMS_WORKER_ROOM_ID === "string" && env.AGENTTEAMS_WORKER_ROOM_ID.length > 0
    ? env.AGENTTEAMS_WORKER_ROOM_ID
    : null;
  return Object.freeze({ workerName, matrixUserId, roomId });
}

export function isLeaderForProject(identity, projectBinding) {
  return (
    identity?.workerName !== undefined &&
    projectBinding?.roleBindings?.team_leader === identity.workerName
  );
}

export function assertLeaderForProject(identity, projectBinding) {
  if (!isLeaderForProject(identity, projectBinding)) {
    throw new Error(
      `Worker ${identity?.workerName ?? "<unknown>"} is not the team_leader for project ${projectBinding?.projectId ?? "<unknown>"}`,
    );
  }
}

export function assertProjectLeaderActor(actorId, projectBinding, { env = process.env } = {}) {
  const leader = projectBinding?.roleBindings?.team_leader;
  const domain = env.AGENTTEAMS_MATRIX_DOMAIN;
  if (typeof leader !== "string" || typeof domain !== "string" || !MATRIX_DOMAIN_PATTERN.test(domain)) {
    throw new Error("Project Leader Matrix identity cannot be derived from authenticated runtime facts");
  }
  const expected = `@${leader}:${domain}`;
  if (actorId !== expected) {
    throw new Error("Authenticated Matrix actor is not the Project Leader");
  }
  return expected;
}

export function assertAssignee(identity, taskBinding) {
  if (identity?.workerName !== taskBinding?.assignee) {
    throw new Error(
      `Worker ${identity?.workerName ?? "<unknown>"} is not the assignee of task ${taskBinding?.taskId ?? "<unknown>"}`,
    );
  }
}
