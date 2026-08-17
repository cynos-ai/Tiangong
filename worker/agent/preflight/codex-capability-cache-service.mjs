import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createCodexCapabilityCache } from "./codex-capability-cache.mjs";
import { sha256 } from "../canonical-json.mjs";

const PORT = Number.parseInt(process.env.TIANGONG_CODEX_CAPABILITY_CACHE_PORT || "8788", 10);
const PATH = process.env.TIANGONG_CODEX_CAPABILITY_CACHE_PATH || "/var/lib/tiangong-capabilities/codex.json";
const MAX_REQUEST_BYTES = 16 * 1024;
const LEASE_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const leases = new Map();
const cache = createCodexCapabilityCache({ path: PATH });

function send(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new Error(`${label}_INVALID`);
  }
}

async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("CACHE_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("CACHE_REQUEST_INVALID"); }
}

function validateFingerprint(value) {
  exactKeys(value, ["baseUrl", "detectorVersion", "model", "provider"], "CAPABILITY_FINGERPRINT");
  return { provider: value.provider, model: value.model, baseUrl: value.baseUrl, detectorVersion: value.detectorVersion };
}

function leaseFor(key) {
  const existing = leases.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing;
  if (existing) leases.delete(key);
  const lease = { leaseToken: randomBytes(32).toString("base64url"), expiresAt: Date.now() + LEASE_MS };
  leases.set(key, lease);
  return lease;
}

async function wait(milliseconds) { await new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function handleLookup(body) {
  const fingerprint = validateFingerprint(body);
  const key = sha256(fingerprint);
  const deadline = Date.now() + LEASE_MS + 5_000;
  while (true) {
    const hit = await cache.lookup(fingerprint);
    if (hit.cacheHit) return { status: "hit", leaseToken: null, record: hit.record };
    const current = leases.get(key);
    if (!current || current.expiresAt <= Date.now()) {
      const lease = leaseFor(key);
      return { status: "probe", leaseToken: lease.leaseToken, record: null };
    }
    if (Date.now() >= deadline) throw new Error("CACHE_LEASE_WAIT_TIMEOUT");
    await wait(100);
  }
}

async function handleCommit(body) {
  exactKeys(body, ["fingerprint", "leaseToken", "probe"], "CACHE_COMMIT");
  const fingerprint = validateFingerprint(body.fingerprint);
  if (!TOKEN.test(body.leaseToken)) throw new Error("CACHE_COMMIT_INVALID");
  const key = sha256(fingerprint);
  const lease = leases.get(key);
  if (!lease || lease.expiresAt <= Date.now() || lease.leaseToken !== body.leaseToken) throw new Error("CACHE_LEASE_REJECTED");
  try {
    const stored = await cache.store({ ...fingerprint, probe: body.probe });
    return { status: "stored", cacheHit: stored.cacheHit, record: stored.record };
  } finally {
    leases.delete(key);
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") { send(response, 200, { status: "ok" }); return; }
    if (request.method !== "POST" || !["/v1/lookup", "/v1/commit"].includes(request.url) || request.headers["content-type"] !== "application/json") {
      send(response, 404, { error: "CACHE_ROUTE_NOT_FOUND" }); return;
    }
    const body = await readBody(request);
    const value = request.url === "/v1/lookup" ? await handleLookup(body) : await handleCommit(body);
    send(response, 200, value);
  } catch (error) {
    const status = error?.message === "CACHE_LEASE_REJECTED" ? 409 : 400;
    send(response, status, { error: /^[A-Z0-9_]+$/u.test(error?.message || "") ? error.message : "CACHE_REQUEST_REJECTED" });
  }
});

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("Capability cache port is invalid");
server.listen(PORT, "0.0.0.0", () => process.stdout.write(`codex_capability_cache_ready=pass port=${PORT}\n`));
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
