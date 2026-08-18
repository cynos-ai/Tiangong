import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { AdmissionDeniedError } from "./admission-boundary.mjs";
import { AdmissionContextFileStore, normalizeAdmissionContext } from "./admission-context-file.mjs";

const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;
const MAX_KEYS = 128;
const ADMISSION_FILE_MAX_AGE_MS = 10 * 60 * 1000;

function deny(code, message) {
  throw new AdmissionDeniedError(code, message);
}

function bounded(value, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 512) : fallback;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function debugAdmission(phase, key, event, ctx, matched) {
  if (process.env.TIANGONG_ADMISSION_DEBUG !== "1") return;
  const sessionKey = eventValue(event, ctx, ["sessionKey", "conversationId"]);
  const messageId = eventValue(event, ctx, ["messageId", "currentMessageId", "eventId", "sourceEventId"]);
  console.error(`[tiangong-admission-debug] phase=${phase} key=${digest(key).slice(0, 12)} ` +
    `matched=${matched ? 1 : 0} session=${sessionKey ? digest(sessionKey).slice(0, 12) : "none"} ` +
    `message=${messageId ? digest(messageId).slice(0, 12) : "none"} ` +
    `eventKeys=${Object.keys(event ?? {}).sort().join(",")} ctxKeys=${Object.keys(ctx ?? {}).sort().join(",")}`);
}

function eventValue(event, ctx, keys, fallback = "") {
  for (const key of keys) {
    const value = event?.[key] ?? ctx?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

function allowlistedActors(config) {
  const matrix = config?.channels?.matrix ?? {};
  const values = [
    ...(Array.isArray(matrix.groupAllowFrom) ? matrix.groupAllowFrom : []),
    ...(Array.isArray(matrix.dm?.allowFrom) ? matrix.dm.allowFrom : []),
  ];
  return new Set(values.filter((value) => MATRIX_USER_ID.test(value)).slice(0, MAX_KEYS));
}

async function readConfig(configPath) {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    deny("ADMISSION_CONTEXT_UNAVAILABLE", "canary admission configuration is unavailable");
  }
}

function requestShape({ workerName, runtimeLane, event, ctx, actorId, messageId }) {
  const contentLength = typeof event?.content === "string" ? event.content.length : null;
  return {
    channel: "matrix",
    actorId,
    messageId,
    route: "team-room",
    authenticated: true,
    contentLength,
    sessionKey: eventValue(event, ctx, ["sessionKey", "conversationId"], "matrix-canary"),
    workerName,
    runtimeLane,
  };
}

export function createCanaryAdmissionResolver({
  configPath,
  workerName = process.env.AGENTTEAMS_WORKER_NAME,
  runtimeLane = process.env.TIANGONG_RUNTIME_LANE,
  admissionFile = process.env.TIANGONG_CANARY_ADMISSION_FILE,
} = {}) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new TypeError("canary admission configPath is required");
  }
  if (typeof workerName !== "string" || workerName.length === 0 ||
      typeof runtimeLane !== "string" || runtimeLane.length === 0) {
    throw new TypeError("canary admission Worker identity is required");
  }
  const admitted = new Map();
  const persisted = admissionFile ? new AdmissionContextFileStore({ filePath: admissionFile }) : null;
  let configPromise;

  async function readPersisted(key) {
    if (!persisted) return undefined;
    try {
      const metadata = await stat(admissionFile);
      if (Date.now() - metadata.mtimeMs > ADMISSION_FILE_MAX_AGE_MS) return undefined;
      const context = await persisted.read();
      const marker = `:${digest(key).slice(0, 32)}`;
      if (!context.request.turnId.endsWith(marker)) return undefined;
      admitted.set(key, context);
      return context;
    } catch {
      return undefined;
    }
  }

  return async ({ phase, event = {}, ctx = {} } = {}) => {
    const config = await (configPromise ??= readConfig(configPath));
    const actors = allowlistedActors(config);
    const configuredActor = [...actors][0] ?? "";
    const actorId = eventValue(event, ctx, ["senderId", "actorId", "sender"], configuredActor);
    if (!MATRIX_USER_ID.test(actorId) || !actors.has(actorId)) {
      deny("ADMISSION_ACTOR_INVALID", "canary Matrix actor is not allowlisted");
    }
    const messageId = eventValue(event, ctx,
      ["messageId", "currentMessageId", "eventId", "sourceEventId"],
      `matrix:${eventValue(event, ctx, ["sessionKey", "conversationId"], "canary")}`);
    const shape = requestShape({ workerName, runtimeLane, event, ctx, actorId, messageId });
    const binding = {
      workerName,
      runtimeLane,
      configRevision: `canary-config-${digest({ actors: [...actors].sort(), workerName }).slice(0, 16)}`,
      capabilityRevision: "canary-capability-v1",
      allowedChannels: ["matrix"],
      active: true,
    };
    const request = {
      workerName,
      runtimeLane,
      turnId: `matrix:${messageId}`,
      requestDigest: digest(shape),
      configRevision: binding.configRevision,
      capabilityRevision: binding.capabilityRevision,
    };
    const key = eventValue(event, ctx, ["sessionKey", "conversationId"], messageId);
    let persistedContext;
    if (phase === "tool" && !admitted.has(key)) persistedContext = await readPersisted(key);
    debugAdmission(phase, key, event, ctx, phase === "tool" && (admitted.has(key) || persistedContext));
    if (phase === "model") {
      const context = normalizeAdmissionContext({
        source: shape,
        binding,
        request: { ...request, turnId: `${request.turnId}:${digest(key).slice(0, 32)}` },
      });
      admitted.set(key, context);
      await persisted?.write(context);
      return context;
    }
    if (phase === "tool") {
      const context = admitted.get(key) ?? persistedContext;
      if (!context) deny("ADMISSION_MODEL_REQUIRED", "canary tool call has no admitted model turn");
      return {
        admission: {
          phase: "model",
          source: context.source,
          workerName: context.request.workerName,
          runtimeLane: context.request.runtimeLane,
          turnId: context.request.turnId,
          requestDigest: context.request.requestDigest,
          configRevision: context.request.configRevision,
          capabilityRevision: context.request.capabilityRevision,
        },
        binding: context.binding,
        toolName: bounded(event.toolName, "unknown-tool"),
        requestDigest: context.request.requestDigest,
      };
    }
    deny("ADMISSION_CONTEXT_INVALID", "canary admission phase is unsupported");
  };
}
