// Matrix-backed Team coordination channel.
//
// AgentTeams v1.2.0 creates one personal Worker room plus one shared Team
// room. The adapter discovers the Team room from the authenticated Worker's
// joined-room set, verifies the intended recipient is a joined member, and
// uses deterministic Matrix transaction IDs so operation replay cannot emit
// duplicate events. Tokens and message content never enter Evidence.

import { canonicalJson, sha256 } from "../canonical-json.mjs";

const MATRIX_USER_ID = /^@[A-Za-z0-9._=\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const WORKER_NAME = /^[A-Za-z0-9._:-]{1,128}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_JOINED_ROOMS = 16;
const MAX_JOINED_MEMBERS = 64;

function requireString(value, name, pattern) {
  if (typeof value !== "string" || value === "" || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function serviceBaseUrl(rawValue, name) {
  const raw = requireString(rawValue, name);
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be a credential-free HTTP(S) origin`);
  }
  return parsed.href.replace(/\/$/u, "");
}

function workerMatrixId(workerName, env) {
  const domain = requireString(env.AGENTTEAMS_MATRIX_DOMAIN, "AGENTTEAMS_MATRIX_DOMAIN");
  if (/[/@\s]/u.test(domain)) throw new Error("AGENTTEAMS_MATRIX_DOMAIN is invalid");
  return `@${requireString(workerName, "Worker name", WORKER_NAME)}:${domain}`;
}

async function authenticatedRequest(config, baseUrl, token, method, path, body) {
  const response = await config.fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Matrix response exceeds the bounded channel contract");
  if (!response.ok) throw new Error(`Matrix request failed with HTTP ${response.status}`);
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Matrix response is not valid JSON");
  }
}

function matrixRequest(config, method, path, body) {
  return authenticatedRequest(config, config.baseUrl, config.token, method, path, body);
}

function controllerRequest(config, path) {
  return authenticatedRequest(config, config.controllerUrl, config.controllerToken, "GET", path);
}

function joinedMemberIds(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.joined === null || typeof value.joined !== "object" || Array.isArray(value.joined)) {
    throw new Error("Matrix joined-members response is invalid");
  }
  const ids = Object.keys(value.joined);
  if (ids.length > MAX_JOINED_MEMBERS || ids.some((id) => !MATRIX_USER_ID.test(id))) {
    throw new Error("Matrix joined-members response exceeds the closed Team contract");
  }
  return new Set(ids);
}

async function joinedRooms(config) {
  const value = await matrixRequest(config, "GET", "/_matrix/client/v3/joined_rooms");
  if (!Array.isArray(value.joined_rooms) || value.joined_rooms.length > MAX_JOINED_ROOMS ||
      value.joined_rooms.some((room) => typeof room !== "string" || !room.startsWith("!"))) {
    throw new Error("Matrix joined-room response is invalid");
  }
  if (!value.joined_rooms.includes(config.personalRoomId)) {
    throw new Error("Authenticated Worker personal room is not joined");
  }
  return value.joined_rooms;
}

async function teamRoomForAll(config, recipients) {
  const candidates = [];
  for (const roomId of await joinedRooms(config)) {
    if (roomId === config.personalRoomId) continue;
    const members = joinedMemberIds(await matrixRequest(
      config,
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    ));
    if (members.has(config.selfMatrixId) && recipients.every((recipient) => members.has(recipient))) candidates.push(roomId);
  }
  if (candidates.length !== 1) {
    throw new Error("Exactly one authenticated AgentTeams Team room must contain sender and recipient");
  }
  return candidates[0];
}

async function teamRoomFor(config, recipient) {
  return teamRoomForAll(config, [recipient]);
}

async function assertPersonalRoomRecipient(config, recipient) {
  const members = joinedMemberIds(await matrixRequest(
    config,
    "GET",
    `/_matrix/client/v3/rooms/${encodeURIComponent(config.personalRoomId)}/joined_members`,
  ));
  if (!members.has(config.selfMatrixId) || !members.has(recipient)) {
    throw new Error("Requester is not authenticated in the Leader personal room");
  }
  return config.personalRoomId;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function eventBody({ recipient, kind, projectId, taskId, disposition, summary }) {
  const target = `<a href="https://matrix.to/#/${recipient}">${escapeHtml(recipient)}</a>`;
  const suffix = kind === "task-assigned"
    ? `Tiangong Task assigned: project=${projectId} task=${taskId}. Resolve the bound Task, perform the role work, then submit one bound ResultEnvelope.`
    : kind === "result-submitted"
      ? `Tiangong Result submitted: project=${projectId} task=${taskId}. Check the current bound result and decide it.`
      : `Tiangong Project terminal: project=${projectId} disposition=${disposition}. ${summary}`;
  return {
    msgtype: "m.text",
    body: `${recipient} ${suffix}`,
    format: "org.matrix.custom.html",
    formatted_body: `${target} ${escapeHtml(suffix)}`,
    "m.mentions": { user_ids: [recipient] },
  };
}

async function send(config, operation) {
  const roomId = operation.personal
    ? await assertPersonalRoomRecipient(config, operation.recipient)
    : await teamRoomFor(config, operation.recipient);
  const transactionId = `tiangong_${sha256(canonicalJson({
    kind: operation.kind,
    projectId: operation.projectId,
    taskId: operation.taskId ?? null,
    disposition: operation.disposition ?? null,
    bindingDigest: operation.bindingDigest,
    recipient: operation.recipient,
  }))}`;
  await matrixRequest(
    config,
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
    eventBody(operation),
  );
  return { roomIdDigest: sha256(roomId), transactionId };
}

export function createTeamChannel({ evidence, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!evidence?.append) throw new TypeError("Team channel requires durable Evidence");
  if (typeof fetchImpl !== "function") throw new TypeError("Team channel requires a Matrix fetch implementation");
  const workerName = requireString(env.AGENTTEAMS_WORKER_NAME, "AGENTTEAMS_WORKER_NAME", WORKER_NAME);
  const config = Object.freeze({
    fetchImpl,
    baseUrl: serviceBaseUrl(env.AGENTTEAMS_MATRIX_URL, "AGENTTEAMS_MATRIX_URL"),
    token: requireString(env.AGENTTEAMS_WORKER_MATRIX_TOKEN, "AGENTTEAMS_WORKER_MATRIX_TOKEN"),
    controllerUrl: serviceBaseUrl(env.AGENTTEAMS_CONTROLLER_URL, "AGENTTEAMS_CONTROLLER_URL"),
    controllerToken: requireString(env.AGENTTEAMS_AUTH_TOKEN, "AGENTTEAMS_AUTH_TOKEN"),
    personalRoomId: requireString(env.AGENTTEAMS_WORKER_ROOM_ID, "AGENTTEAMS_WORKER_ROOM_ID"),
    selfMatrixId: workerMatrixId(workerName, env),
  });

  async function deliver(type, operation) {
    requireString(operation.recipient, "Matrix recipient", MATRIX_USER_ID);
    requireString(operation.projectId, "projectId", WORKER_NAME);
    if (operation.taskId !== undefined) requireString(operation.taskId, "taskId", WORKER_NAME);
    requireString(operation.bindingDigest, "bindingDigest", DIGEST);
    const sent = await send(config, operation);
    await evidence.append({
      type,
      projectId: operation.projectId,
      taskId: operation.taskId,
      disposition: operation.disposition,
      recipientDigest: sha256(operation.recipient),
      bindingDigest: operation.bindingDigest,
      roomIdDigest: sent.roomIdDigest,
      transactionId: sent.transactionId,
      delivered: true,
    });
    return { queued: false, delivered: true, transactionId: sent.transactionId };
  }

  return Object.freeze({
    async assertTeamIdentity(expectedRole) {
      if (!["team_leader", "worker"].includes(expectedRole)) throw new Error("Expected Team role is invalid");
      const resource = await controllerRequest(
        config,
        `/api/v1/workers/${encodeURIComponent(workerName)}`,
      );
      if (resource?.name !== workerName || resource?.role !== expectedRole ||
          typeof resource.team !== "string" || resource.team === "" ||
          resource.matrixUserID !== config.selfMatrixId || resource.phase !== "Running") {
        throw new Error("Authenticated AgentTeams Team identity does not match the required role");
      }
      return { team: resource.team, role: resource.role, matrixUserIdDigest: sha256(resource.matrixUserID) };
    },
    async assertTeamRoster(workerNames) {
      if (!Array.isArray(workerNames) || workerNames.length !== 5 || new Set(workerNames).size !== 5) {
        throw new Error("Project roster must contain exactly five distinct Workers");
      }
      const recipients = workerNames.map((name) => workerMatrixId(name, env));
      const roomId = await teamRoomForAll(config, recipients);
      return { roomId, roomIdDigest: sha256(roomId), memberDigests: recipients.map((id) => sha256(id)).sort() };
    },
    async notifyAssignee(assignee, projectId, taskId, bindingDigest) {
      return deliver("team.mention.delivered", {
        kind: "task-assigned",
        recipient: workerMatrixId(assignee, env),
        projectId,
        taskId,
        bindingDigest,
      });
    },
    async notifyLeader(leader, projectId, taskId, resultDigest) {
      return deliver("team.result.notice.delivered", {
        kind: "result-submitted",
        recipient: workerMatrixId(leader, env),
        projectId,
        taskId,
        bindingDigest: resultDigest,
      });
    },
    async reportRequester(requester, projectId, disposition, dispositionDigest, summary) {
      if (typeof summary !== "string" || summary === "" || Buffer.byteLength(summary) > 8192) {
        throw new Error("Requester report summary is missing or exceeds its bound");
      }
      return deliver("team.requester.report.delivered", {
        kind: "project-terminal",
        recipient: requester,
        projectId,
        disposition,
        bindingDigest: dispositionDigest,
        summary,
        personal: true,
      });
    },
  });
}
