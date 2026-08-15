import { createServer } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8780);
const FACTS_FILE = process.env.TIANGONG_RUNTIME_FACTS_FILE || "";
const CAPTURE_FILE = process.env.TIANGONG_TOOL_RESULT_CAPTURE_FILE || "";
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_CAPTURE_RECORDS = 32;
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

async function runtimeFacts({ factsFile = FACTS_FILE, captureFile = CAPTURE_FILE } = {}) {
  const capture = await readCapture(captureFile);
  if (!factsFile) {
    return {
      status: "unknown",
      source: "runtime-facts-not-configured",
      lane: null,
      worker: null,
      toolResults: capture.records,
      toolResultsSource: capture.source,
    };
  }
  try {
    const value = JSON.parse(await readFile(resolve(factsFile), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid facts");
    return { status: "observed", source: "runtime-facts-file", ...value, toolResults: capture.records, toolResultsSource: capture.source };
  } catch {
    return { status: "unknown", source: "runtime-facts-unavailable", lane: null, worker: null, toolResults: capture.records, toolResultsSource: capture.source };
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createRuntimeConsoleServer(options = {}) {
  const factsFile = options.factsFile ?? FACTS_FILE;
  const captureFile = options.captureFile ?? CAPTURE_FILE;
  return createServer(async (request, response) => {
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    if (request.url === "/healthz") return json(response, 200, { ok: true });
    if (request.url === "/readyz") return json(response, factsFile ? 200 : 503, { ready: Boolean(factsFile), source: factsFile ? "runtime-facts-file" : "runtime-facts-not-configured" });
    if (request.url === "/api/runtime") return json(response, 200, await runtimeFacts({ factsFile, captureFile }));
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(await readFile(resolve(ROOT, "public/index.html")));
    }
    return json(response, 404, { error: "not_found" });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  createRuntimeConsoleServer().listen(PORT, "0.0.0.0", () => {
    process.stdout.write(`tiangong_runtime_console_listening=${PORT}\n`);
  });
}
