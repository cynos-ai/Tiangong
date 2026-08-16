import { codexCapabilityFingerprint } from "./codex-capability-cache.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}

function cacheEndpoint(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Capability cache endpoint is required");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Capability cache endpoint is invalid"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9._~/-]{0,128}$/u.test(url.pathname)) {
    throw new TypeError("Capability cache endpoint must be credential-free HTTP(S)");
  }
  return url.toString().replace(/\/$/u, "");
}

async function readJson(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error("CODEX_CAPABILITY_CACHE_RESPONSE_INVALID");
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("CODEX_CAPABILITY_CACHE_RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("CODEX_CAPABILITY_CACHE_RESPONSE_INVALID"); }
}

export function createRemoteCodexCapabilityCache({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const base = cacheEndpoint(endpoint);
  if (typeof fetchImpl !== "function") throw new TypeError("Capability cache client requires fetch");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new TypeError("Capability cache timeout is invalid");
  async function request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const value = await readJson(response);
      if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "CODEX_CAPABILITY_CACHE_REQUEST_REJECTED");
      return value;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("CODEX_CAPABILITY_CACHE_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    async resolve({ provider, model, baseUrl, detectorVersion, probe }) {
      if (typeof probe !== "function") throw new TypeError("Codex capability cache requires a probe function");
      const identity = codexCapabilityFingerprint({ provider, model, baseUrl, detectorVersion });
      const lookup = await request("/v1/lookup", identity.fingerprint);
      exactKeys(lookup, ["leaseToken", "record", "status"], "Capability cache lookup");
      if (lookup.status === "hit") return { cacheHit: true, record: lookup.record };
      if (lookup.status !== "probe" || !TOKEN.test(lookup.leaseToken)) throw new Error("CODEX_CAPABILITY_CACHE_LOOKUP_INVALID");
      const result = await probe(identity.fingerprint);
      const committed = await request("/v1/commit", {
        fingerprint: identity.fingerprint,
        leaseToken: lookup.leaseToken,
        probe: result,
      });
      exactKeys(committed, ["cacheHit", "record", "status"], "Capability cache commit");
      if (committed.status !== "stored" || typeof committed.cacheHit !== "boolean") throw new Error("CODEX_CAPABILITY_CACHE_COMMIT_INVALID");
      return { cacheHit: committed.cacheHit, record: committed.record };
    },
  });
}
