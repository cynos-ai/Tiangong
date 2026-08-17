import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../canonical-json.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_STATE_DIR = process.env.TIANGONG_OPENCODEX_STATE_DIR || "/var/lib/tiangong-opencodex";
const DEFAULT_PORT = Number(process.env.TIANGONG_OPENCODEX_RECEIPT_PORT || 8790);
const MAX_BYTES = 16 * 1024;

function send(response, status, body) {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  response.end(text);
}

function sidecarId(workerId) { return `opencodex-${workerId}`; }

async function readState(stateDir, workerId) {
  if (!ID.test(workerId)) return null;
  try {
    const text = await readFile(join(stateDir, `${sidecarId(workerId)}.json`), "utf8");
    if (text.length > MAX_BYTES) return null;
    return JSON.parse(text);
  } catch { return null; }
}

export function createOpenCodexSidecarReceiptHandler({ stateDir = DEFAULT_STATE_DIR } = {}) {
  return async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") { send(response, 200, { status: "ok" }); return; }
    const match = /^\/v1\/receipts\/([^/]+)$/u.exec(request.url ?? "");
    if (request.method !== "GET" || !match) { send(response, 404, { error: "OPENCODEX_RECEIPT_ROUTE_NOT_FOUND" }); return; }
    const workerId = decodeURIComponent(match[1]);
    const state = await readState(stateDir, workerId);
    if (!state || state.phase !== "ready") { send(response, 503, { error: "OPENCODEX_SIDECAR_NOT_READY" }); return; }
    const provider = typeof state.provider === "string" ? state.provider : "";
    const model = typeof state.model === "string" ? state.model : "";
    const receipt = {
      schemaVersion: 1,
      sidecarId: state.sidecarId,
      phase: "ready",
      generation: state.generation,
      endpoint: state.endpoint,
      provider,
      model,
      transport: "responses-via-chat-bridge",
      bridge: "opencodex",
      credentialSource: "agentteams-secret-projection",
      routeDigest: sha256(canonicalJson({ provider, model, transport: "responses-via-chat-bridge", bridge: "opencodex" })),
    };
    send(response, 200, receipt);
  };
}

export async function startOpenCodexSidecarReceiptService({ stateDir = DEFAULT_STATE_DIR, port = DEFAULT_PORT } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OpenCodex receipt service port is invalid");
  const server = createServer(createOpenCodexSidecarReceiptHandler({ stateDir }));
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => { server.off("error", reject); resolveReady(); });
  });
  return { server, stateDir, port };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { server, port } = await startOpenCodexSidecarReceiptService({});
  process.stdout.write(`opencodex_receipt_service_ready=pass port=${port}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
