import { createServer } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CoordinationStore } from "../worker/agent/team/coordination-store.mjs";
import { createCoordinationAdmissionHandler } from "./coordination/control-api.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8780);
const FACTS_FILE = process.env.TIANGONG_RUNTIME_FACTS_FILE || "";
const CAPTURE_FILE = process.env.TIANGONG_TOOL_RESULT_CAPTURE_FILE || "";
const COORDINATION_FILE = process.env.TIANGONG_COORDINATION_FILE || "";
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_CAPTURE_RECORDS = 32;
const MAX_SSE_CLIENTS = 32;
const DIGEST = /^[a-f0-9]{64}$/u;

function boundedId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function scalarSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).slice(0, 32);
  const result = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) continue;
    if (typeof entry === "string" && entry.length <= 256) result[key] = entry;
    else if (typeof entry === "number" && Number.isSafeInteger(entry)) result[key] = entry;
    else if (typeof entry === "boolean" || entry === null) result[key] = entry;
  }
  return result;
}

function projectContentRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.repositoryId === "string" && typeof value.commitSha === "string") {
    return { repositoryId: value.repositoryId.slice(0, 256), commitSha: value.commitSha.slice(0, 128) };
  }
  if (typeof value.adapter === "string" && typeof value.ref === "string") {
    return { adapter: value.adapter.slice(0, 128), ref: value.ref.slice(0, 256) };
  }
  return null;
}

async function readCapture(filePath) {
  if (!filePath) return { records: [], source: "tool-result-capture-not-configured" };
  try {
    const metadata = await lstat(resolve(filePath));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CAPTURE_BYTES ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new Error("invalid capture file");
    const state = JSON.parse(await readFile(resolve(filePath), "utf8"));
    if (!state || state.version !== 1 || !Array.isArray(state.results) || state.results.length > 256 ||
        !Array.isArray(state.retentionMarks) || state.retentionMarks.length > 256) throw new Error("invalid capture state");
    const records = state.results.slice(-MAX_CAPTURE_RECORDS).filter((record) =>
      record && typeof record === "object" && DIGEST.test(record.toolResultId ?? "") &&
      DIGEST.test(record.callKey ?? "") && boundedId(record.actorId) && boundedId(record.runtimeProfile) &&
      boundedId(record.tool) && scalarSummary(record.requestSummary) && scalarSummary(record.resultSummary) &&
      typeof record.startedAt === "string" && typeof record.completedAt === "string",
    ).map((record) => ({
      version: 1,
      toolResultId: record.toolResultId,
      callKey: record.callKey,
      workId: boundedId(record.workId),
      taskId: boundedId(record.taskId),
      actorId: record.actorId,
      runtimeProfile: record.runtimeProfile,
      tool: record.tool,
      requestSummary: scalarSummary(record.requestSummary),
      resultSummary: scalarSummary(record.resultSummary),
      outputRef: projectContentRef(record.outputRef),
      startedAt: record.startedAt.slice(0, 64),
      completedAt: record.completedAt.slice(0, 64),
    }));
    return { records, source: "tool-result-capture-file" };
  } catch {
    return { records: [], source: "tool-result-capture-unavailable" };
  }
}

function projectWork(value) {
  if (!value || typeof value !== "object" || !value.work || !value.currentWorkSpec || !Array.isArray(value.timeline) ||
      !boundedId(value.work.workId) || !boundedId(value.work.teamId) || !boundedId(value.work.routeId) ||
      !boundedId(value.work.actorId) || !boundedId(value.work.leaderSessionId) ||
      !["open", "closed"].includes(value.status) || !Number.isSafeInteger(value.epoch)) return null;
  return {
    workId: value.work.workId,
    teamId: value.work.teamId,
    routeId: value.work.routeId,
    actorId: value.work.actorId,
    sourceEventId: boundedId(value.work.sourceEventId),
    leaderSessionId: value.work.leaderSessionId,
    status: value.status,
    epoch: value.epoch,
    currentWorkSpec: {
      revision: Number.isSafeInteger(value.currentWorkSpec.revision) ? value.currentWorkSpec.revision : null,
      objective: typeof value.currentWorkSpec.objective === "string" ? value.currentWorkSpec.objective.slice(0, 512) : null,
      scope: typeof value.currentWorkSpec.scope === "string" ? value.currentWorkSpec.scope.slice(0, 512) : null,
      completionContract: typeof value.currentWorkSpec.completionContract === "string" ? value.currentWorkSpec.completionContract.slice(0, 512) : null,
    },
    timeline: value.timeline.slice(-64).map((entry) => ({
      sequence: Number.isSafeInteger(entry?.sequence) ? entry.sequence : null,
      type: boundedId(entry?.type),
      at: typeof entry?.at === "string" ? entry.at.slice(0, 64) : null,
      epoch: Number.isSafeInteger(entry?.epoch) ? entry.epoch : null,
      requestId: boundedId(entry?.requestId),
    })),
  };
}

function projectWake(value) {
  if (!value || typeof value !== "object" || !DIGEST.test(value.wakeId ?? "") ||
      !["leader-resume", "human-reply", "task-assignment", "result-notification"].includes(value.kind) ||
      !boundedId(value.targetMemberId) || !["pending", "claimed", "acked"].includes(value.status)) return null;
  return {
    wakeId: value.wakeId,
    kind: value.kind,
    workId: boundedId(value.workId),
    taskId: boundedId(value.taskId),
    targetMemberId: value.targetMemberId,
    status: value.status,
    createdAt: typeof value.createdAt === "string" ? value.createdAt.slice(0, 64) : null,
    claimedAt: typeof value.claimedAt === "string" ? value.claimedAt.slice(0, 64) : null,
    ackedAt: typeof value.ackedAt === "string" ? value.ackedAt.slice(0, 64) : null,
  };
}

function projectResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !boundedId(value.resultId) || !boundedId(value.workId) || !boundedId(value.taskId) || !boundedId(value.producerMemberId)) return null;
  const projected = {
    resultId: value.resultId,
    workId: value.workId,
    taskId: value.taskId,
    producerMemberId: value.producerMemberId,
    toolResultCount: Array.isArray(value.toolResultIds) ? value.toolResultIds.length : 0,
    artifactRefCount: Array.isArray(value.artifactRefs) ? value.artifactRefs.length : 0,
    createdAt: typeof value.createdAt === "string" ? value.createdAt.slice(0, 64) : null,
  };
  if (typeof value.claim === "string") projected.claim = value.claim.slice(0, 512);
  if (typeof value.blocker === "string") projected.blocker = value.blocker.slice(0, 512);
  return projected;
}

function projectDecision(value) {
  if (!value || typeof value !== "object" || !boundedId(value.decisionId) || !boundedId(value.workId) ||
      !["accept", "blocked", "complete", "stop"].includes(value.decision)) return null;
  const projected = {
    decisionId: value.decisionId,
    workId: value.workId,
    decision: value.decision,
    reason: typeof value.reason === "string" ? value.reason.slice(0, 512) : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt.slice(0, 64) : null,
  };
  if (boundedId(value.taskId)) projected.taskId = value.taskId;
  if (DIGEST.test(value.resultDigest ?? "")) projected.resultDigest = value.resultDigest;
  return projected;
}

function projectTask(value) {
  if (!value || typeof value !== "object" || !value.spec || !boundedId(value.spec.taskId) || !boundedId(value.spec.workId) ||
      !boundedId(value.spec.assigneeMemberId) || !["assigned", "reported", "accepted", "blocked", "cancelled"].includes(value.status)) return null;
  return {
    taskId: value.spec.taskId,
    workId: value.spec.workId,
    assigneeMemberId: value.spec.assigneeMemberId,
    status: value.status,
    objective: typeof value.spec.objective === "string" ? value.spec.objective.slice(0, 512) : null,
    completionContract: typeof value.spec.completionContract === "string" ? value.spec.completionContract.slice(0, 512) : null,
    inputRefCount: Array.isArray(value.spec.inputRefs) ? value.spec.inputRefs.length : 0,
    createdAt: typeof value.spec.createdAt === "string" ? value.spec.createdAt.slice(0, 64) : null,
    result: projectResult(value.result),
    decision: projectDecision(value.decision),
    cancellation: value.cancellation && typeof value.cancellation === "object" ? {
      reason: typeof value.cancellation.reason === "string" ? value.cancellation.reason.slice(0, 512) : null,
      at: typeof value.cancellation.at === "string" ? value.cancellation.at.slice(0, 64) : null,
    } : null,
  };
}

async function readCoordination(filePath, coordinationStore) {
  if (coordinationStore && typeof coordinationStore.listWorks === "function" && typeof coordinationStore.listOutbox === "function") {
    try {
      const [works, deliveries, tasks, results, decisions] = await Promise.all([
        coordinationStore.listWorks(),
        coordinationStore.listOutbox(),
        typeof coordinationStore.listTasks === "function" ? coordinationStore.listTasks() : [],
        typeof coordinationStore.listResults === "function" ? coordinationStore.listResults() : [],
        typeof coordinationStore.listDecisions === "function" ? coordinationStore.listDecisions() : [],
      ]);
      return {
        works: works.map(projectWork).filter(Boolean),
        workSource: "coordination-store",
        deliveries: deliveries.map(projectWake).filter(Boolean),
        deliverySource: "coordination-store",
        tasks: tasks.map(projectTask).filter(Boolean),
        taskSource: "coordination-store",
        results: results.map(projectResult).filter(Boolean),
        resultSource: "coordination-store",
        decisions: decisions.map(projectDecision).filter(Boolean),
        decisionSource: typeof coordinationStore.listDecisions === "function" ? "coordination-store" : "coordination-store-unavailable",
      };
    } catch {
      return { works: [], workSource: "coordination-store-unavailable", deliveries: [], deliverySource: "coordination-store-unavailable", tasks: [], taskSource: "coordination-store-unavailable", results: [], resultSource: "coordination-store-unavailable", decisions: [], decisionSource: "coordination-store-unavailable" };
    }
  }
  if (!filePath) return { works: [], workSource: "coordination-store-not-configured", deliveries: [], deliverySource: "coordination-store-not-configured", tasks: [], taskSource: "coordination-store-not-configured", results: [], resultSource: "coordination-store-not-configured", decisions: [], decisionSource: "coordination-store-not-configured" };
  try {
    const resolvedFile = resolve(filePath);
    const metadata = await lstat(resolvedFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("invalid coordination journal");
    const store = new CoordinationStore({ filePath: resolvedFile });
    const [works, deliveries, tasks, results, decisions] = await Promise.all([
      store.listWorks(),
      store.listOutbox(),
      typeof store.listTasks === "function" ? store.listTasks() : [],
      typeof store.listResults === "function" ? store.listResults() : [],
      typeof store.listDecisions === "function" ? store.listDecisions() : [],
    ]);
    return {
      works: works.map(projectWork).filter(Boolean),
      workSource: "coordination-store",
      deliveries: deliveries.map(projectWake).filter(Boolean),
      deliverySource: "coordination-store",
      tasks: tasks.map(projectTask).filter(Boolean),
      taskSource: "coordination-store",
      results: results.map(projectResult).filter(Boolean),
      resultSource: "coordination-store",
      decisions: decisions.map(projectDecision).filter(Boolean),
      decisionSource: typeof store.listDecisions === "function" ? "coordination-store" : "coordination-store-unavailable",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { works: [], workSource: "coordination-store-empty", deliveries: [], deliverySource: "coordination-store-empty", tasks: [], taskSource: "coordination-store-empty", results: [], resultSource: "coordination-store-empty", decisions: [], decisionSource: "coordination-store-empty" };
    return { works: [], workSource: "coordination-store-unavailable", deliveries: [], deliverySource: "coordination-store-unavailable", tasks: [], taskSource: "coordination-store-unavailable", results: [], resultSource: "coordination-store-unavailable", decisions: [], decisionSource: "coordination-store-unavailable" };
  }
}

async function runtimeFacts({ factsFile = FACTS_FILE, captureFile = CAPTURE_FILE, coordinationFile = COORDINATION_FILE, coordinationStore } = {}) {
  const capture = await readCapture(captureFile);
  const coordination = await readCoordination(coordinationFile, coordinationStore);
  if (!factsFile) {
    return {
      status: "unknown",
      source: "runtime-facts-not-configured",
      lane: null,
      worker: null,
      toolResults: capture.records,
      toolResultsSource: capture.source,
      ...coordination,
    };
  }
  try {
    const value = JSON.parse(await readFile(resolve(factsFile), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid facts");
    return { status: "observed", source: "runtime-facts-file", ...value, toolResults: capture.records, toolResultsSource: capture.source, ...coordination };
  } catch {
    return { status: "unknown", source: "runtime-facts-unavailable", lane: null, worker: null, toolResults: capture.records, toolResultsSource: capture.source, ...coordination };
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createRuntimeConsoleServer(options = {}) {
  const factsFile = options.factsFile ?? FACTS_FILE;
  const captureFile = options.captureFile ?? CAPTURE_FILE;
  const coordinationFile = options.coordinationFile ?? COORDINATION_FILE;
  const coordinationStore = options.coordinationStore;
  const sseIntervalMs = Number.isSafeInteger(options.sseIntervalMs) && options.sseIntervalMs >= 100 && options.sseIntervalMs <= 60_000 ? options.sseIntervalMs : 1_000;
  const sseClients = new Map();
  const coordinationControl = options.coordinationControl ? createCoordinationAdmissionHandler(options.coordinationControl) : null;
  const readiness = typeof options.readiness === "function"
    ? options.readiness
    : async () => {
      if (coordinationStore && typeof coordinationStore.health === "function") await coordinationStore.health();
      return {
        ready: Boolean(factsFile || coordinationStore),
        source: factsFile ? "runtime-facts-file" : coordinationStore ? "coordination-store" : "runtime-facts-not-configured",
      };
    };
  const server = createServer(async (request, response) => {
    if (coordinationControl && request.url?.startsWith("/v1/coordination/")) return coordinationControl(request, response);
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    if (request.url === "/healthz") return json(response, 200, { ok: true });
    if (request.url === "/readyz") {
      try {
        const result = await readiness();
        const ready = result === true || result?.ready === true;
        return json(response, ready ? 200 : 503, { ready, source: result?.source ?? "readiness" });
      } catch {
        return json(response, 503, { ready: false, source: "readiness-unavailable" });
      }
    }
    if (request.url === "/api/runtime/events") {
      if (sseClients.size >= MAX_SSE_CLIENTS) return json(response, 503, { error: "sse_capacity_exceeded" });
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      });
      let closed = false;
      const send = async () => {
        if (closed) return;
        try {
          const facts = await runtimeFacts({ factsFile, captureFile, coordinationFile, coordinationStore });
          response.write(`event: runtime\ndata: ${JSON.stringify(facts)}\n\n`);
        } catch {
          response.write("event: runtime\ndata: {\"status\":\"unknown\"}\n\n");
        }
      };
      const timer = setInterval(send, sseIntervalMs);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        sseClients.delete(response);
      };
      sseClients.set(response, cleanup);
      request.on("close", cleanup);
      response.on("close", cleanup);
      await send();
      return;
    }
    if (request.url === "/api/runtime") return json(response, 200, await runtimeFacts({ factsFile, captureFile, coordinationFile, coordinationStore }));
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(resolve(ROOT, "public/index.html")));
    }
    return json(response, 404, { error: "not_found" });
  });
  server.on("close", () => {
    for (const [response, cleanup] of sseClients) {
      cleanup();
      try { response.end(); } catch { /* connection already closed */ }
    }
    sseClients.clear();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  createRuntimeConsoleServer().listen(PORT, "0.0.0.0", () => {
    process.stdout.write(`tiangong_runtime_console_listening=${PORT}\n`);
  });
}
