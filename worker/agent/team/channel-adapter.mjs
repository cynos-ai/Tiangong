// Matrix-backed Team coordination channel.
//
// AgentTeams v1.2.0 creates one personal Worker room plus one shared Team
// room. The adapter discovers the Team room from the authenticated Worker's
// joined-room set, verifies the intended recipient is a joined member, and
// uses deterministic Matrix transaction IDs so replay cannot emit duplicate
// events. Matrix event IDs remain the direct delivery observation.

import { setTimeout as delay } from "node:timers/promises";

import { canonicalJson, sha256 } from "../canonical-json.mjs";

const MATRIX_USER_ID = /^@[A-Za-z0-9._=\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const WORKER_NAME = /^[A-Za-z0-9._:-]{1,128}$/u;
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_JOINED_ROOMS = 16;
const MAX_JOINED_MEMBERS = 64;
const TEAM_IDENTITY_READY_TIMEOUT_MS = 30_000;
const TEAM_IDENTITY_READY_POLL_MS = 250;

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

async function requesterRoom(config, recipient) {
  try {
    return await assertPersonalRoomRecipient(config, recipient);
  } catch (personalError) {
    // AgentTeams v1.2.2 gives Worker-to-Worker reports only the authenticated
    // shared Team room; a Worker personal/DM room is not guaranteed to contain
    // another Worker. Keep the requester identity and fail closed to the one
    // canonical Team room instead of silently dropping the terminal report.
    try {
      return await teamRoomFor(config, recipient);
    } catch {
      throw personalError;
    }
  }
}

async function assertJoinedRoom(config, roomId) {
  requireString(roomId, "Matrix room id", MATRIX_ROOM_ID);
  const rooms = await joinedRooms(config);
  if (!rooms.includes(roomId)) throw new Error("Authenticated Worker is not joined to the requested Matrix room");
  return roomId;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function handoffBody({ recipient, workId, intentId, sourceRoomId, sourceEventId, sourceSender, sender }) {
  const reference = {
    version: 1,
    work_id: workId,
    intent_id: intentId,
    source: {
      room_id: sourceRoomId,
      event_id: sourceEventId,
      sender: sourceSender,
    },
    sender,
    recipient,
  };
  const serializedReference = canonicalJson(reference);
  const target = `<a href="https://matrix.to/#/${recipient}">${escapeHtml(recipient)}</a>`;
  const suffix = `Tiangong specialist handoff ref=${serializedReference}`;
  return {
    msgtype: "m.text",
    body: `${recipient} ${suffix}`,
    format: "org.matrix.custom.html",
    formatted_body: `${target} ${escapeHtml(suffix)}`,
    "m.mentions": { user_ids: [recipient] },
    "com.tiangong.handoff": reference,
  };
}

function eventBody(operation) {
  if (operation.kind === "specialist-handoff") return handoffBody(operation);
  if (operation.kind === "work-admitted") {
    const target = `<a href="https://matrix.to/#/${operation.recipient}">${escapeHtml(operation.recipient)}</a>`;
    const suffix = `Tiangong Work admitted: work=${operation.workId}. The native Leader session is now responsible for the bounded Work.`;
    return {
      msgtype: "m.text",
      body: `${operation.recipient} ${suffix}`,
      format: "org.matrix.custom.html",
      formatted_body: `${target} ${escapeHtml(suffix)}`,
      "m.mentions": { user_ids: [operation.recipient] },
      "com.tiangong.work": {
        version: 1,
        work_id: operation.workId,
        source_event_id: operation.sourceEventId,
      },
    };
  }
  const { recipient, kind, projectId, taskId, disposition, summary } = operation;
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
  const roomId = operation.roomId
    ? await assertJoinedRoom(config, operation.roomId)
    : operation.personal
    ? await requesterRoom(config, operation.recipient)
    : await teamRoomFor(config, operation.recipient);
  const wireOperation = operation.kind === "specialist-handoff"
    ? { ...operation, sourceRoomId: roomId, sender: config.selfMatrixId }
    : operation;
  const transactionInput = operation.kind === "specialist-handoff"
    ? {
        kind: wireOperation.kind,
        workId: wireOperation.workId,
        intentId: wireOperation.intentId,
        sourceRoomId: wireOperation.sourceRoomId,
        sourceEventId: wireOperation.sourceEventId,
        sourceSender: wireOperation.sourceSender,
        sender: wireOperation.sender,
        recipient: wireOperation.recipient,
      }
    : operation.kind === "work-admitted"
      ? {
        kind: wireOperation.kind,
        workId: wireOperation.workId,
        sourceEventId: wireOperation.sourceEventId,
        bindingDigest: wireOperation.bindingDigest,
        recipient: wireOperation.recipient,
        roomId,
      }
      : {
        kind: operation.kind,
        projectId: operation.projectId,
        taskId: operation.taskId ?? null,
        disposition: operation.disposition ?? null,
        bindingDigest: operation.bindingDigest,
        recipient: operation.recipient,
      };
  const transactionId = `tiangong_${sha256(canonicalJson(transactionInput))}`;
  const response = await matrixRequest(
    config,
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
    eventBody(wireOperation),
  );
  if (typeof response.event_id !== "string" || !MATRIX_EVENT_ID.test(response.event_id)) {
    throw new Error("Matrix send response did not contain a valid event ID");
  }
  return { roomId, roomIdDigest: sha256(roomId), transactionId, eventId: response.event_id, eventIdDigest: sha256(response.event_id) };
}

export function createTeamChannel({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
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

  async function deliver(operation) {
    requireString(operation.recipient, "Matrix recipient", MATRIX_USER_ID);
    if (operation.kind === "specialist-handoff") {
      requireString(operation.workId, "handoff workId", HANDOFF_ID);
      requireString(operation.intentId, "handoff intentId", HANDOFF_ID);
      requireString(operation.sourceEventId, "handoff source event ID", MATRIX_EVENT_ID);
      requireString(operation.sourceSender, "handoff source sender", MATRIX_USER_ID);
    } else if (operation.kind === "work-admitted") {
      requireString(operation.workId, "workId", HANDOFF_ID);
      requireString(operation.sourceEventId, "source event ID", MATRIX_EVENT_ID);
      requireString(operation.roomId, "roomId");
      requireString(operation.bindingDigest, "bindingDigest", DIGEST);
    } else {
      requireString(operation.projectId, "projectId", WORKER_NAME);
      if (operation.taskId !== undefined) requireString(operation.taskId, "taskId", WORKER_NAME);
      requireString(operation.bindingDigest, "bindingDigest", DIGEST);
    }
    const sent = await send(config, operation);
    return {
      queued: false,
      delivered: true,
      transactionId: sent.transactionId,
      eventId: sent.eventId,
      eventIdDigest: sent.eventIdDigest,
    };
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
    async waitForTeamIdentity(expectedRole, {
      timeoutMs = TEAM_IDENTITY_READY_TIMEOUT_MS,
      pollMs = TEAM_IDENTITY_READY_POLL_MS,
    } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TEAM_IDENTITY_READY_TIMEOUT_MS) {
        throw new TypeError("Team identity readiness timeout is outside the bounded contract");
      }
      if (!Number.isSafeInteger(pollMs) || pollMs < 0 || pollMs > TEAM_IDENTITY_READY_POLL_MS) {
        throw new TypeError("Team identity readiness poll is outside the bounded contract");
      }
      const deadline = Date.now() + timeoutMs;
      while (true) {
        try {
          return await this.assertTeamIdentity(expectedRole);
        } catch {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            const error = new Error("AgentTeams Team identity did not become ready before the bounded pre-task gate");
            error.code = "AGENTTEAMS_TEAM_IDENTITY_NOT_READY";
            throw error;
          }
          await delay(Math.min(pollMs, remaining));
        }
      }
    },
    async assertTeamRoster(workerNames) {
      if (!Array.isArray(workerNames) || workerNames.length !== 5 || new Set(workerNames).size !== 5) {
        throw new Error("Project roster must contain exactly five distinct Workers");
      }
      const recipients = workerNames.map((name) => workerMatrixId(name, env));
      const roomId = await teamRoomForAll(config, recipients);
      return { roomId, roomIdDigest: sha256(roomId), memberDigests: recipients.map((id) => sha256(id)).sort() };
    },
    async readHumanEvent(roomId, eventId) {
      const boundRoomId = await assertJoinedRoom(config, roomId);
      requireString(eventId, "Matrix event ID", MATRIX_EVENT_ID);
      const value = await matrixRequest(
        config,
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(boundRoomId)}/event/${encodeURIComponent(eventId)}`,
      );
      if (value?.room_id !== boundRoomId || value?.event_id !== eventId || typeof value.sender !== "string" ||
          typeof value.type !== "string" || !value.content || typeof value.content !== "object") {
        throw new Error("Matrix event response is not a bound event");
      }
      return Object.freeze({
        eventId: value.event_id,
        roomId: value.room_id,
        sender: value.sender,
        type: value.type,
        content: structuredClone(value.content),
      });
    },
    async notifyWorkAdmitted(recipient, { roomId, workId, sourceEventId, bindingDigest } = {}) {
      return deliver({
        kind: "work-admitted",
        recipient,
        roomId,
        workId,
        sourceEventId,
        bindingDigest,
      });
    },
    async notifyAssignee(assignee, projectId, taskId, bindingDigest) {
      return deliver({
        kind: "task-assigned",
        recipient: workerMatrixId(assignee, env),
        projectId,
        taskId,
        bindingDigest,
      });
    },
    async notifyLeader(leader, projectId, taskId, resultDigest) {
      return deliver({
        kind: "result-submitted",
        recipient: workerMatrixId(leader, env),
        projectId,
        taskId,
        bindingDigest: resultDigest,
      });
    },
    async sendSpecialistHandoff(recipient, { workId, intentId, sourceEventId, sourceSender } = {}) {
      requireString(recipient, "handoff recipient", MATRIX_USER_ID);
      return deliver({
        kind: "specialist-handoff",
        recipient,
        workId,
        intentId,
        sourceEventId,
        sourceSender,
      });
    },
    async reportRequester(requester, projectId, disposition, dispositionDigest, summary) {
      if (typeof summary !== "string" || summary === "" || Buffer.byteLength(summary) > 8192) {
        throw new Error("Requester report summary is missing or exceeds its bound");
      }
      return deliver({
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
