import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { AdmissionDeniedError } from "./admission-boundary.mjs";
import { canonicalJson } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 32;
const MAX_STRING_BYTES = 512;

function deny(code, message) {
  throw new AdmissionDeniedError(code, message);
}

function boundedString(value, name) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_STRING_BYTES) {
    deny("ADMISSION_CONTEXT_INVALID", `${name} is missing or exceeds the bounded limit`);
  }
  return value;
}

function boundedList(value, name) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS ||
      value.some((entry) => typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry) > MAX_STRING_BYTES)) {
    deny("ADMISSION_CONTEXT_INVALID", `${name} is invalid or exceeds the bounded limit`);
  }
  return [...value];
}

export function normalizeAdmissionBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    deny("ADMISSION_CONTEXT_INVALID", "admission binding must be an object");
  }
  return {
    workerName: boundedString(binding.workerName, "binding.workerName"),
    runtimeLane: boundedString(binding.runtimeLane, "binding.runtimeLane"),
    configRevision: boundedString(binding.configRevision, "binding.configRevision"),
    capabilityRevision: boundedString(binding.capabilityRevision, "binding.capabilityRevision"),
    allowedChannels: boundedList(binding.allowedChannels, "binding.allowedChannels"),
    active: binding.active === true,
    ...(binding.revoked === true ? { revoked: true } : {}),
    ...(binding.deniedTools === undefined ? {} : { deniedTools: boundedList(binding.deniedTools, "binding.deniedTools") }),
    ...(binding.allowedActors === undefined ? {} : { allowedActors: boundedList(binding.allowedActors, "binding.allowedActors") }),
    ...(binding.allowedRoutes === undefined ? {} : { allowedRoutes: boundedList(binding.allowedRoutes, "binding.allowedRoutes") }),
    ...(binding.allowedSessions === undefined ? {} : { allowedSessions: boundedList(binding.allowedSessions, "binding.allowedSessions") }),
  };
}

export function normalizeAdmissionContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    deny("ADMISSION_CONTEXT_INVALID", "admission context must be an object");
  }
  const { source, binding, request } = value;
  if (!source || !binding || !request ||
      typeof source !== "object" || typeof binding !== "object" || typeof request !== "object") {
    deny("ADMISSION_CONTEXT_INVALID", "admission context is incomplete");
  }
  const normalizedSource = {
    channel: boundedString(source.channel, "source.channel"),
    actorId: boundedString(source.actorId, "source.actorId"),
    messageId: boundedString(source.messageId, "source.messageId"),
    route: boundedString(source.route, "source.route"),
    authenticated: source.authenticated === true,
  };
  const normalizedBinding = normalizeAdmissionBinding(binding);
  const normalizedRequest = {
    workerName: boundedString(request.workerName, "request.workerName"),
    runtimeLane: boundedString(request.runtimeLane, "request.runtimeLane"),
    turnId: boundedString(request.turnId, "request.turnId"),
    requestDigest: boundedString(request.requestDigest, "request.requestDigest"),
    configRevision: boundedString(request.configRevision, "request.configRevision"),
    capabilityRevision: boundedString(request.capabilityRevision, "request.capabilityRevision"),
  };
  return { source: normalizedSource, binding: normalizedBinding, request: normalizedRequest };
}

export function normalizeAdmissionToolContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !value.admission || typeof value.admission !== "object" || Array.isArray(value.admission)) {
    deny("ADMISSION_CONTEXT_INVALID", "tool admission context is incomplete");
  }
  const admission = value.admission;
  if (admission.phase !== "model") deny("ADMISSION_CONTEXT_INVALID", "tool admission must reference a model admission");
  const normalized = {
    phase: "model",
    workerName: boundedString(admission.workerName, "admission.workerName"),
    runtimeLane: boundedString(admission.runtimeLane, "admission.runtimeLane"),
    turnId: boundedString(admission.turnId, "admission.turnId"),
    requestDigest: boundedString(admission.requestDigest, "admission.requestDigest"),
    configRevision: boundedString(admission.configRevision, "admission.configRevision"),
    capabilityRevision: boundedString(admission.capabilityRevision, "admission.capabilityRevision"),
  };
  return Object.freeze({
    admission: Object.freeze(normalized),
    binding: Object.freeze(normalizeAdmissionBinding(value.binding)),
    toolName: boundedString(value.toolName, "toolName"),
    requestDigest: boundedString(value.requestDigest, "requestDigest"),
  });
}

function assertFilePath(filePath) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new TypeError("admission context filePath must be absolute");
  }
  return filePath;
}

async function readRecord(filePath) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") deny("ADMISSION_CONTEXT_UNAVAILABLE", "admission context file is unavailable");
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) deny("ADMISSION_CONTEXT_INVALID", "admission context is not a regular file");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    deny("ADMISSION_CONTEXT_INVALID", "admission context permissions are too broad");
  }
  if (metadata.size > MAX_FILE_BYTES) deny("ADMISSION_CONTEXT_INVALID", "admission context file is too large");
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    deny("ADMISSION_CONTEXT_INVALID", "admission context file is not valid JSON");
  }
  if (value?.version !== VERSION || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    deny("ADMISSION_CONTEXT_INVALID", "admission context file header is invalid");
  }
  return { version: VERSION, updatedAt: value.updatedAt, context: normalizeAdmissionContext(value.context) };
}

export class AdmissionContextFileStore {
  #filePath;

  constructor({ filePath } = {}) {
    this.#filePath = assertFilePath(filePath);
  }

  async write(context, { updatedAt = new Date().toISOString() } = {}) {
    if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
      throw new TypeError("updatedAt must be an ISO timestamp");
    }
    const record = { version: VERSION, updatedAt, context: normalizeAdmissionContext(context) };
    const line = `${canonicalJson(record)}\n`;
    if (Buffer.byteLength(line) > MAX_FILE_BYTES) {
      throw new TypeError("admission context exceeds the bounded file limit");
    }
    await withFileLock(this.#filePath, async () => {
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.#filePath}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#filePath);
    });
    return record;
  }

  async read() {
    return (await withFileLock(this.#filePath, () => readRecord(this.#filePath))).context;
  }
}

export function createFileAdmissionResolver({ filePath } = {}) {
  const store = new AdmissionContextFileStore({ filePath });
  return async () => store.read();
}
