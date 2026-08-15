import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { AdmissionDeniedError } from "./admission-boundary.mjs";
import {
  normalizeAdmissionBinding,
  normalizeAdmissionContext,
} from "./admission-context-file.mjs";
import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REPLAY_ENTRIES = 128;
const DIGEST = /^[a-f0-9]{64}$/u;

function deny(code, message) {
  throw new AdmissionDeniedError(code, message);
}

function boundedString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    deny("ADMISSION_CONTEXT_INVALID", `${name} is missing or exceeds the bounded limit`);
  }
  return value;
}

function assertPath(filePath, name) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return filePath;
}

async function writeJson(filePath, value) {
  const line = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(line) > MAX_STATE_BYTES) throw new TypeError("admission state exceeds the bounded file limit");
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(filePath, fallback) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STATE_BYTES) {
    throw new Error("admission state file is invalid");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("admission state permissions are too broad");
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("admission state is not valid JSON");
  }
}

export class AdmissionBindingStore {
  #filePath;

  constructor({ filePath } = {}) {
    this.#filePath = assertPath(filePath, "binding filePath");
  }

  async write(binding, { updatedAt = new Date().toISOString() } = {}) {
    const normalized = normalizeAdmissionBinding(binding);
    if (!Number.isFinite(Date.parse(updatedAt))) throw new TypeError("updatedAt must be an ISO timestamp");
    const record = { version: STATE_VERSION, updatedAt, binding: normalized };
    await withFileLock(this.#filePath, () => writeJson(this.#filePath, record));
    return record;
  }

  async read() {
    const record = await withFileLock(this.#filePath, () => readJson(this.#filePath, null));
    if (!record) deny("ADMISSION_CONTEXT_UNAVAILABLE", "admission binding is unavailable");
    if (record.version !== STATE_VERSION || typeof record.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(record.updatedAt))) {
      deny("ADMISSION_CONTEXT_INVALID", "admission binding header is invalid");
    }
    return {
      version: STATE_VERSION,
      updatedAt: record.updatedAt,
      binding: normalizeAdmissionBinding(record.binding),
    };
  }
}

function emptyReplayState() {
  return { version: STATE_VERSION, entries: [] };
}

function validateReplayKey(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return value;
}

export class AdmissionReplayStore {
  #filePath;
  #maxEntries;

  constructor({ filePath, maxEntries = MAX_REPLAY_ENTRIES } = {}) {
    this.#filePath = assertPath(filePath, "replay filePath");
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_REPLAY_ENTRIES) {
      throw new TypeError("maxEntries is outside the bounded range");
    }
    this.#maxEntries = maxEntries;
  }

  async #readState() {
    const state = await readJson(this.#filePath, emptyReplayState());
    if (!state || state.version !== STATE_VERSION || !Array.isArray(state.entries) || state.entries.length > MAX_REPLAY_ENTRIES) {
      throw new Error("admission replay state is invalid");
    }
    return {
      version: STATE_VERSION,
      entries: state.entries.map((entry) => {
        if (!entry || typeof entry !== "object" ||
            !DIGEST.test(entry.turnKey) || !DIGEST.test(entry.requestDigest) ||
            typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))) {
          throw new Error("admission replay entry is invalid");
        }
        return {
          turnKey: entry.turnKey,
          requestDigest: entry.requestDigest,
          context: normalizeAdmissionContext(entry.context),
          updatedAt: entry.updatedAt,
        };
      }),
    };
  }

  async get(turnKey) {
    validateReplayKey(turnKey, "turnKey");
    const state = await withFileLock(this.#filePath, () => this.#readState());
    const entry = state.entries.find((candidate) => candidate.turnKey === turnKey);
    return entry ? structuredClone(entry) : undefined;
  }

  async put(turnKey, requestDigest, context, { updatedAt = new Date().toISOString() } = {}) {
    validateReplayKey(turnKey, "turnKey");
    validateReplayKey(requestDigest, "requestDigest");
    if (!Number.isFinite(Date.parse(updatedAt))) throw new TypeError("updatedAt must be an ISO timestamp");
    const normalized = normalizeAdmissionContext(context);
    return withFileLock(this.#filePath, async () => {
      const state = await this.#readState();
      const existing = state.entries.find((candidate) => candidate.turnKey === turnKey);
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          deny("ADMISSION_REQUEST_CHANGED", "the replay key is bound to different request content");
        }
        return { replayed: true, context: normalizeAdmissionContext(existing.context) };
      }
      const next = [
        ...state.entries,
        { turnKey, requestDigest, context: normalized, updatedAt },
      ].slice(-this.#maxEntries);
      await writeJson(this.#filePath, { version: STATE_VERSION, entries: next });
      return { replayed: false, context: normalized };
    });
  }
}

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    deny("ADMISSION_CONTEXT_INVALID", "Control API admission input must be an object");
  }
  const phase = value.phase;
  if (phase !== "model" && phase !== "tool") deny("ADMISSION_CONTEXT_INVALID", "Control API admission phase is unsupported");
  const event = value.event;
  const context = value.context;
  if (!event || typeof event !== "object" || Array.isArray(event) ||
      !context || typeof context !== "object" || Array.isArray(context)) {
    deny("ADMISSION_CONTEXT_INVALID", "Control API admission input is incomplete");
  }
  return {
    phase,
    workerName: boundedString(value.workerName, "workerName"),
    runtimeLane: boundedString(value.runtimeLane, "runtimeLane"),
    event,
    context,
  };
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? "";
}

function turnIdentityFromInput(input) {
  const messageId = firstString(input.event.messageId, input.context.messageId, input.event.eventId, input.context.eventId);
  const sessionKey = firstString(input.event.sessionKey, input.context.sessionKey, input.context.conversationId);
  if (!messageId || !sessionKey) deny("ADMISSION_SOURCE_INVALID", "Control API admission turn identity is incomplete");
  return { messageId, sessionKey };
}

function sourceFromInput(input, binding) {
  const channel = firstString(input.event.channel, input.context.channel);
  const actorId = firstString(input.event.senderId, input.context.senderId);
  const { messageId, sessionKey } = turnIdentityFromInput(input);
  const route = firstString(input.event.route, input.context.route);
  const contentLength = input.event.contentLength;
  if (!channel || !actorId || !messageId || !route || !sessionKey ||
      (input.phase === "model" && (!Number.isSafeInteger(contentLength) || contentLength < 0))) {
    deny("ADMISSION_SOURCE_INVALID", "Control API admission source is incomplete");
  }
  if (!binding.allowedChannels.includes(channel)) deny("ADMISSION_CHANNEL_NOT_ALLOWED", "channel is not allowed by the current binding");
  if (Array.isArray(binding.allowedActors) && !binding.allowedActors.includes(actorId)) {
    deny("ADMISSION_ACTOR_INVALID", "actor is not allowlisted by the current binding");
  }
  if (Array.isArray(binding.allowedRoutes) && !binding.allowedRoutes.includes(route)) {
    deny("ADMISSION_ROUTE_INVALID", "route is not allowlisted by the current binding");
  }
  if (Array.isArray(binding.allowedSessions) && !binding.allowedSessions.includes(sessionKey)) {
    deny("ADMISSION_SESSION_INVALID", "session is not allowlisted by the current binding");
  }
  return { channel, actorId, messageId, route, sessionKey, contentLength: contentLength ?? null };
}

function currentBinding(record, input) {
  const binding = record.binding;
  if (input.workerName !== binding.workerName || input.runtimeLane !== binding.runtimeLane) {
    deny("ADMISSION_BINDING_MISMATCH", "request is bound to a different Worker or runtime lane");
  }
  if (binding.active !== true) deny("ADMISSION_BINDING_INACTIVE", "runtime binding is inactive");
  if (binding.revoked === true) deny("ADMISSION_REVOKED", "runtime binding was revoked");
  return binding;
}

export function createAdmissionControlPlane({ bindingStore, replayStore, now = () => new Date().toISOString() } = {}) {
  if (!bindingStore || typeof bindingStore.read !== "function" ||
      !replayStore || typeof replayStore.get !== "function" || typeof replayStore.put !== "function") {
    throw new TypeError("admission Control API requires binding and replay stores");
  }
  return {
    async resolve(value) {
      const input = exactInput(value);
      const record = await bindingStore.read();
      const binding = currentBinding(record, input);
      const identity = turnIdentityFromInput(input);
      const turnKey = sha256({
        workerName: input.workerName,
        runtimeLane: input.runtimeLane,
        sessionKey: identity.sessionKey,
        messageId: identity.messageId,
      });
      if (input.phase === "tool") {
        const replay = await replayStore.get(turnKey);
        if (!replay) deny("ADMISSION_MODEL_REQUIRED", "tool call has no durable model admission");
        const actorId = firstString(input.event.senderId, input.context.senderId);
        const route = firstString(input.event.route, input.context.route);
        if ((actorId && replay.context.source.actorId !== actorId) ||
            (route && replay.context.source.route !== route)) {
          deny("ADMISSION_SOURCE_MISMATCH", "tool call does not match the admitted source");
        }
        const toolName = boundedString(input.event.toolName, "toolName");
        return {
          admission: {
            phase: "model",
            workerName: replay.context.request.workerName,
            runtimeLane: replay.context.request.runtimeLane,
            turnId: replay.context.request.turnId,
            requestDigest: replay.context.request.requestDigest,
            configRevision: replay.context.request.configRevision,
            capabilityRevision: replay.context.request.capabilityRevision,
          },
          binding,
          toolName,
          requestDigest: replay.context.request.requestDigest,
        };
      }
      const source = sourceFromInput(input, binding);
      const requestDigest = sha256({
        channel: source.channel,
        actorId: source.actorId,
        messageId: source.messageId,
        route: source.route,
        sessionKey: source.sessionKey,
        contentLength: source.contentLength,
      });
      const context = normalizeAdmissionContext({
        source: {
          channel: source.channel,
          actorId: source.actorId,
          messageId: source.messageId,
          route: source.route,
          authenticated: true,
        },
        binding,
        request: {
          workerName: binding.workerName,
          runtimeLane: binding.runtimeLane,
          turnId: `${source.sessionKey}:${source.messageId}`,
          requestDigest,
          configRevision: binding.configRevision,
          capabilityRevision: binding.capabilityRevision,
        },
      });
      const result = await replayStore.put(turnKey, requestDigest, context, { updatedAt: now() });
      if (result.replayed &&
          (result.context.binding.configRevision !== binding.configRevision ||
           result.context.binding.capabilityRevision !== binding.capabilityRevision)) {
        deny("ADMISSION_REVISION_STALE", "replayed admission uses a stale runtime or capability revision");
      }
      return normalizeAdmissionContext({ ...result.context, binding });
    },
  };
}

async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) deny("ADMISSION_CONTEXT_INVALID", "Control API admission request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    deny("ADMISSION_CONTEXT_INVALID", "Control API admission request is not JSON");
  }
}

function send(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function statusFor(error) {
  if (error?.code === "ADMISSION_CONTEXT_UNAVAILABLE") return 503;
  if (error?.code === "ADMISSION_REQUEST_CHANGED") return 409;
  if (error?.code === "ADMISSION_CONTEXT_INVALID") return 400;
  return 403;
}

export function createAdmissionControlHandler({ plane, readiness } = {}) {
  if (!plane || typeof plane.resolve !== "function") throw new TypeError("admission Control API plane is required");
  return async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      try {
        if (typeof readiness === "function") await readiness();
        send(response, 200, { status: "ready" });
      } catch {
        send(response, 503, { error: "ADMISSION_CONTEXT_UNAVAILABLE" });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/admission" ||
        !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      send(response, 404, { error: "ADMISSION_ROUTE_NOT_FOUND" });
      return;
    }
    try {
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || !body.admission) {
        deny("ADMISSION_CONTEXT_INVALID", "Control API admission envelope is invalid");
      }
      send(response, 200, await plane.resolve(body.admission));
    } catch (error) {
      if (error instanceof AdmissionDeniedError) {
        send(response, statusFor(error), { error: error.code });
        return;
      }
      send(response, 503, { error: "ADMISSION_CONTEXT_UNAVAILABLE" });
    }
  };
}

export function createAdmissionControlServer(options = {}) {
  return createServer(createAdmissionControlHandler(options));
}

const DEFAULT_BINDING_PATH = "/run/tiangong-admission/binding.json";
const DEFAULT_REPLAY_PATH = "/var/lib/tiangong-admission/replay.json";

function envPath(value, fallback, name) {
  const path = value || fallback;
  if (!isAbsolute(path)) throw new TypeError(`${name} must be an absolute path`);
  return path;
}

function envPort(value) {
  const port = Number(value || 8789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("admission Control API port is invalid");
  return port;
}

export async function startAdmissionControlServer({
  bindingPath = process.env.TIANGONG_ADMISSION_BINDING_FILE,
  replayPath = process.env.TIANGONG_ADMISSION_REPLAY_FILE,
  port = process.env.TIANGONG_ADMISSION_CONTROL_PORT,
  host = process.env.TIANGONG_ADMISSION_CONTROL_HOST || "0.0.0.0",
} = {}) {
  const bindingStore = new AdmissionBindingStore({
    filePath: envPath(bindingPath, DEFAULT_BINDING_PATH, "binding filePath"),
  });
  const replayStore = new AdmissionReplayStore({
    filePath: envPath(replayPath, DEFAULT_REPLAY_PATH, "replay filePath"),
  });
  await bindingStore.read();
  const server = createAdmissionControlServer({
    plane: createAdmissionControlPlane({ bindingStore, replayStore }),
    readiness: () => bindingStore.read(),
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(envPort(port), host, () => {
      server.off("error", reject);
      ready();
    });
  });
  return { server, bindingStore, replayStore, port: envPort(port), host };
}

if (process.argv[1] && process.argv[1].endsWith("admission-control-server.mjs")) {
  const { server, host, port } = await startAdmissionControlServer();
  process.stdout.write(`admission_control_ready=pass host=${host} port=${port}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
