import { createServer } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8780);
const FACTS_FILE = process.env.TIANGONG_RUNTIME_FACTS_FILE || "";
const CAPTURE_FILE = process.env.TIANGONG_TOOL_RESULT_CAPTURE_FILE || "";
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_CAPTURE_RECORDS = 32;

async function readCapture(filePath) {
  if (!filePath) return { records: [], source: "tool-result-capture-not-configured" };
  try {
    const metadata = await lstat(resolve(filePath));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CAPTURE_BYTES) throw new Error("invalid capture file");
    const lines = (await readFile(resolve(filePath), "utf8")).trim().split("\n").filter(Boolean).slice(-MAX_CAPTURE_RECORDS);
    const records = lines.map((line) => JSON.parse(line)).filter((record) =>
      record && typeof record === "object" && record.source === "openclaw.tool_result_persist" &&
      typeof record.captureId === "string" && typeof record.toolName === "string" &&
      Array.isArray(record.content) && typeof record.timestamp === "string",
    ).map((record) => ({
      version: 1,
      captureId: record.captureId,
      toolName: record.toolName,
      toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : null,
      agentId: typeof record.agentId === "string" ? record.agentId : null,
      sessionKey: typeof record.sessionKey === "string" ? record.sessionKey : null,
      isSynthetic: record.isSynthetic === true,
      content: record.content.slice(0, 32).map((part) => ({
        type: typeof part?.type === "string" ? part.type : null,
        textLength: Number.isSafeInteger(part?.textLength) ? part.textLength : null,
        hasData: part?.hasData === true,
      })),
      timestamp: record.timestamp,
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
