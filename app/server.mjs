import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8780);
const FACTS_FILE = process.env.TIANGONG_RUNTIME_FACTS_FILE || "";

async function runtimeFacts() {
  if (!FACTS_FILE) {
    return { status: "unknown", source: "runtime-facts-not-configured", lane: null, worker: null };
  }
  try {
    const value = JSON.parse(await readFile(resolve(FACTS_FILE), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid facts");
    return { status: "observed", source: "runtime-facts-file", ...value };
  } catch {
    return { status: "unknown", source: "runtime-facts-unavailable", lane: null, worker: null };
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createRuntimeConsoleServer() {
  return createServer(async (request, response) => {
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    if (request.url === "/healthz") return json(response, 200, { ok: true });
    if (request.url === "/readyz") return json(response, FACTS_FILE ? 200 : 503, { ready: Boolean(FACTS_FILE), source: FACTS_FILE ? "runtime-facts-file" : "runtime-facts-not-configured" });
    if (request.url === "/api/runtime") return json(response, 200, await runtimeFacts());
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
