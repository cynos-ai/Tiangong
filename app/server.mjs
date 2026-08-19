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

function projectTimelinePayload(entry) {
  const payload = entry?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const result = {};
  for (const field of ["workId", "taskId", "eventId", "roomId", "humanActorId", "sourceWorkId", "targetWorkId", "correctionEventId", "title", "reason"]) {
    if (typeof payload[field] === "string") result[field] = payload[field].slice(0, field === "reason" ? 512 : 256);
  }
  const source = payload.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    result.source = { roomId: boundedId(source.roomId), eventId: boundedId(source.eventId), actorId: boundedId(source.actorId) };
  }
  const planRef = projectContentRef(payload.planRef);
  if (planRef) result.planRef = planRef;
  const task = payload.task;
  if (task && typeof task === "object" && !Array.isArray(task)) {
    result.task = { taskId: boundedId(task.taskId), assigneeMemberId: boundedId(task.assigneeMemberId), objective: typeof task.objective === "string" ? task.objective.slice(0, 512) : null };
  }
  const submitted = payload.result;
  if (submitted && typeof submitted === "object" && !Array.isArray(submitted)) {
    result.result = { taskId: boundedId(submitted.taskId), submittedBy: boundedId(submitted.submittedBy), summary: typeof submitted.summary === "string" ? submitted.summary.slice(0, 512) : null };
  }
  return Object.keys(result).length ? result : null;
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
  if (!value || typeof value !== "object" || !value.work || !Array.isArray(value.timeline) ||
      !boundedId(value.work.workId) || !boundedId(value.work.teamId) || !boundedId(value.work.routeId) ||
      !boundedId(value.work.actorId) || !boundedId(value.work.leaderSessionId) ||
      !["open", "completed", "stopped"].includes(value.status) || !Number.isSafeInteger(value.epoch)) return null;
  const spec = value.currentWorkSpec;
  if (spec !== null && (!spec || typeof spec !== "object" || !Number.isSafeInteger(spec.revision))) return null;
  return {
    workId: value.work.workId,
    teamId: value.work.teamId,
    routeId: value.work.routeId,
    roomId: boundedId(value.work.roomId),
    title: typeof value.work.title === "string" ? value.work.title.slice(0, 160) : null,
    actorId: value.work.actorId,
    sourceEventId: boundedId(value.work.sourceEventId),
    leaderSessionId: value.work.leaderSessionId,
    status: value.status,
    epoch: value.epoch,
    currentWorkSpec: spec === null ? null : {
      revision: spec.revision,
      goal: typeof spec.goal === "string" ? spec.goal.slice(0, 512) : null,
      scope: Array.isArray(spec.scope) ? spec.scope.slice(0, 32).map((item) => String(item).slice(0, 256)) : [],
      constraints: Array.isArray(spec.constraints) ? spec.constraints.slice(0, 32).map((item) => String(item).slice(0, 256)) : [],
      doneWhen: Array.isArray(spec.doneWhen) ? spec.doneWhen.slice(0, 32).map((item) => String(item).slice(0, 256)) : [],
      unresolvedAssumptions: Array.isArray(spec.unresolvedAssumptions) ? spec.unresolvedAssumptions.slice(0, 32).map((item) => String(item).slice(0, 256)) : [],
    },
    currentPlanRef: projectContentRef(value.currentPlanRef),
    requirementState: spec === null ? "requirement-pending" : "formed",
    timeline: value.timeline.slice(-64).map((entry) => ({
      sequence: Number.isSafeInteger(entry?.sequence) ? entry.sequence : null,
      type: boundedId(entry?.type),
      at: typeof entry?.at === "string" ? entry.at.slice(0, 64) : null,
      actorId: boundedId(entry?.actorId),
      epoch: Number.isSafeInteger(entry?.epoch) ? entry.epoch : null,
      requestId: boundedId(entry?.requestId),
      payload: projectTimelinePayload(entry),
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
  if (!value || typeof value !== "object" || Array.isArray(value) || !boundedId(value.workId) || !boundedId(value.taskId) || !boundedId(value.submittedBy)) return null;
  return {
    workId: value.workId,
    taskId: value.taskId,
    submittedBy: value.submittedBy,
    summary: typeof value.summary === "string" ? value.summary.slice(0, 512) : null,
    toolResultCount: Array.isArray(value.toolResultRefs) ? value.toolResultRefs.length : 0,
    deliverableRefs: Array.isArray(value.deliverableRefs) ? value.deliverableRefs.slice(0, 64).map(projectContentRef).filter(Boolean) : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt.slice(0, 64) : null,
  };
}

function projectTask(value) {
  if (!value || typeof value !== "object" || !value.spec || !boundedId(value.spec.taskId) || !boundedId(value.spec.workId) ||
      !boundedId(value.spec.assigneeMemberId) || !["assigned", "reported", "cancelled"].includes(value.status)) return null;
  return {
    taskId: value.spec.taskId,
    workId: value.spec.workId,
    assigneeMemberId: value.spec.assigneeMemberId,
    sessionRef: boundedId(value.sessionRef),
    status: value.status,
    objective: typeof value.spec.objective === "string" ? value.spec.objective.slice(0, 512) : null,
    constraints: Array.isArray(value.spec.constraints) ? value.spec.constraints.slice(0, 32).map((item) => String(item).slice(0, 256)) : [],
    inputs: Array.isArray(value.spec.inputs) ? value.spec.inputs.slice(0, 32).map(projectContentRef).filter(Boolean) : [],
    createdAt: typeof value.spec.createdAt === "string" ? value.spec.createdAt.slice(0, 64) : null,
    result: projectResult(value.result),
    cancellation: value.cancellation && typeof value.cancellation === "object" ? {
      reason: typeof value.cancellation.reason === "string" ? value.cancellation.reason.slice(0, 512) : null,
      at: typeof value.cancellation.at === "string" ? value.cancellation.at.slice(0, 64) : null,
    } : null,
  };
}

async function readCoordination(filePath, coordinationStore) {
  if (coordinationStore && typeof coordinationStore.listWorks === "function" && typeof coordinationStore.listOutbox === "function") {
    try {
      const [works, deliveries, tasks, results, admissions, admissionMetrics] = await Promise.all([
        coordinationStore.listWorks(),
        coordinationStore.listOutbox(),
        typeof coordinationStore.listTasks === "function" ? coordinationStore.listTasks() : [],
        typeof coordinationStore.listResults === "function" ? coordinationStore.listResults() : [],
        typeof coordinationStore.listMessageAdmissions === "function" ? coordinationStore.listMessageAdmissions({ status: "pending" }) : [],
        typeof coordinationStore.admissionMetrics === "function" ? coordinationStore.admissionMetrics() : { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null },
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
        pendingAdmissions: admissions.map((entry) => ({ eventId: boundedId(entry.eventId), roomId: boundedId(entry.roomId), receivedAt: typeof entry.receivedAt === "string" ? entry.receivedAt.slice(0, 64) : null, attempts: Number.isSafeInteger(entry.attempts) ? entry.attempts : 0, lastErrorCode: boundedId(entry.lastErrorCode) })),
        admissionMetrics,
      };
    } catch {
      return { works: [], workSource: "coordination-store-unavailable", deliveries: [], deliverySource: "coordination-store-unavailable", tasks: [], taskSource: "coordination-store-unavailable", results: [], resultSource: "coordination-store-unavailable", pendingAdmissions: [], admissionMetrics: { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null } };
    }
  }
  const empty = (source) => ({ works: [], workSource: source, deliveries: [], deliverySource: source, tasks: [], taskSource: source, results: [], resultSource: source, pendingAdmissions: [], admissionMetrics: { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null } });
  if (!filePath) return empty("coordination-store-not-configured");
  try {
    const resolvedFile = resolve(filePath);
    const metadata = await lstat(resolvedFile);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("invalid coordination state");
    return readCoordination(undefined, new CoordinationStore({ filePath: resolvedFile }));
  } catch (error) {
    if (error?.code === "ENOENT") return empty("coordination-store-empty");
    return empty("coordination-store-unavailable");
  }
}

function projectAgents(memberConfigs, tasks, toolResults) {
  if (!Array.isArray(memberConfigs)) return [];
  return memberConfigs.filter((member) => member?.enabled === true && boundedId(member.memberId)).map((member) => {
    const assigned = tasks.filter((task) => task.assigneeMemberId === member.memberId && task.status === "assigned");
    const usedSkills = toolResults.filter((record) => record.actorId === member.memberId && record.tool === "tiangong_use_skill" && boundedId(record.resultSummary?.skillId)).slice(-16).map((record) => ({ skillId: record.resultSummary.skillId, version: boundedId(record.resultSummary.skillVersion), contentDigest: DIGEST.test(record.resultSummary.skillContentDigest ?? "") ? record.resultSummary.skillContentDigest : null, taskId: record.taskId, completedAt: record.completedAt }));
    return {
      memberId: member.memberId,
      responsibility: typeof member.role === "string" ? member.role.slice(0, 128) : null,
      runtime: boundedId(member.runtime), model: boundedId(member.model), agentPackageId: boundedId(member.agentPackageId), agentPackageVersion: boundedId(member.agentPackageVersion), capabilityProfile: boundedId(member.capabilityProfile),
      allowedSkills: Array.isArray(member.allowedSkills) ? member.allowedSkills.slice(0, 64).map(boundedId).filter(Boolean) : [], status: assigned.length ? "active" : "waiting",
      activeTasks: assigned.slice(0, 16).map((task) => ({ taskId: task.taskId, workId: task.workId, sessionRef: task.sessionRef })), usedSkills,
    };
  });
}

async function runtimeFacts({ factsFile = FACTS_FILE, captureFile = CAPTURE_FILE, coordinationFile = COORDINATION_FILE, coordinationStore, memberConfigs = [] } = {}) {
  const capture = await readCapture(captureFile);
  const coordination = await readCoordination(coordinationFile, coordinationStore);
  const agents = projectAgents(memberConfigs, coordination.tasks, capture.records);
  if (!factsFile) {
    return {
      status: "unknown",
      source: "runtime-facts-not-configured",
      lane: null,
      worker: null,
      toolResults: capture.records,
      toolResultsSource: capture.source,
      ...coordination,
      agents,
    };
  }
  try {
    const value = JSON.parse(await readFile(resolve(factsFile), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid facts");
    return { status: "observed", source: "runtime-facts-file", ...value, toolResults: capture.records, toolResultsSource: capture.source, ...coordination, agents };
  } catch {
    return { status: "unknown", source: "runtime-facts-unavailable", lane: null, worker: null, toolResults: capture.records, toolResultsSource: capture.source, ...coordination, agents };
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function applySecurityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
}

export function createRuntimeConsoleServer(options = {}) {
  const factsFile = options.factsFile ?? FACTS_FILE;
  const captureFile = options.captureFile ?? CAPTURE_FILE;
  const coordinationFile = options.coordinationFile ?? COORDINATION_FILE;
  const coordinationStore = options.coordinationStore;
  const memberConfigs = Array.isArray(options.memberConfigs) ? options.memberConfigs : [];
  const sseIntervalMs = Number.isSafeInteger(options.sseIntervalMs) && options.sseIntervalMs >= 100 && options.sseIntervalMs <= 60_000 ? options.sseIntervalMs : 1_000;
  const sseClients = new Map();
  const coordinationControl = options.coordinationControl ? createCoordinationAdmissionHandler(options.coordinationControl) : null;
  const matrixWebGateway = options.matrixWebGateway ?? null;
  if (matrixWebGateway && (typeof matrixWebGateway.handle !== "function" || typeof matrixWebGateway.authorizeRead !== "function")) throw new TypeError("matrixWebGateway is invalid");
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
    applySecurityHeaders(response);
    if (coordinationControl && request.url?.startsWith("/v1/coordination/")) {
      if (await coordinationControl(request, response)) return;
    }
    if (matrixWebGateway && request.url?.startsWith("/api/chat/")) {
      if (await matrixWebGateway.handle(request, response)) return;
    }
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
      try { await matrixWebGateway?.authorizeRead(request); } catch { return json(response, 401, { error: "WEB_SESSION_REQUIRED" }); }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      });
      let closed = false;
      let sending = false;
      let timer;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        sseClients.delete(response);
      };
      const send = async () => {
        if (closed || sending) return;
        sending = true;
        try {
          await matrixWebGateway?.authorizeRead(request);
          const facts = await runtimeFacts({ factsFile, captureFile, coordinationFile, coordinationStore, memberConfigs });
          response.write(`event: runtime\ndata: ${JSON.stringify(facts)}\n\n`);
        } catch {
          if (matrixWebGateway) {
            response.write("event: revoked\ndata: {\"error\":\"web_session_revoked\"}\n\n");
            cleanup();
            response.end();
          } else {
            response.write("event: runtime\ndata: {\"status\":\"unknown\"}\n\n");
          }
        } finally { sending = false; }
      };
      timer = setInterval(() => void send(), sseIntervalMs);
      sseClients.set(response, cleanup);
      request.on("close", cleanup);
      response.on("close", cleanup);
      await send();
      return;
    }
    if (request.url === "/api/runtime") {
      try { await matrixWebGateway?.authorizeRead(request); } catch { return json(response, 401, { error: "WEB_SESSION_REQUIRED" }); }
      return json(response, 200, await runtimeFacts({ factsFile, captureFile, coordinationFile, coordinationStore, memberConfigs }));
    }
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(resolve(ROOT, "public/index.html")));
    }
    if (request.url === "/styles.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(resolve(ROOT, "public/styles.css")));
    }
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(resolve(ROOT, "public/app.js")));
    }
    if (request.url === "/favicon.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" });
      return response.end(await readFile(resolve(ROOT, "public/favicon.svg")));
    }
    return json(response, 404, { error: "not_found" });
  });
  server.on("close", () => {
    for (const [response, cleanup] of sseClients) {
      cleanup();
      try { response.end(); } catch { /* connection already closed */ }
    }
    sseClients.clear();
    void matrixWebGateway?.close?.();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  createRuntimeConsoleServer().listen(PORT, "0.0.0.0", () => {
    process.stdout.write(`tiangong_runtime_console_listening=${PORT}\n`);
  });
}
