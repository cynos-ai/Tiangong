import { mkdir, lstat, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { sha256 } from "../canonical-json.mjs";

export const CODEX_CAPABILITY_CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_CODEX_CAPABILITY_CACHE_PATH = "/var/lib/tiangong-capabilities/codex.json";
export const DEFAULT_CODEX_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CODEX_CAPABILITY_LOCK_TIMEOUT_MS = 30_000;
export const CODEX_CAPABILITY_CACHE_MAX_BYTES = 128 * 1024;

const MAX_ENTRIES = 64;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// Keep this aligned with the sidecar receipt contract: model ids may use a
// slash for namespaced models such as `codex/deepseek-v4-pro`.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TRANSPORTS = new Set(["native-responses", "responses-via-chat-bridge"]);
const OUTCOMES = new Set(["supported", "unsupported"]);

function demand(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function endpoint(value) {
  const raw = demand(value, /^.{1,2048}$/u, "baseUrl");
  let url;
  try { url = new URL(raw); } catch { throw new TypeError("baseUrl is invalid"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must be an HTTP(S) URL without credentials or query data");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function codexCapabilityFingerprint({ provider, model, baseUrl, detectorVersion }) {
  const fingerprint = Object.freeze({
    provider: demand(provider, PROVIDER_ID, "provider"),
    model: demand(model, MODEL_ID, "model"),
    baseUrl: endpoint(baseUrl),
    detectorVersion: demand(detectorVersion, ID, "detectorVersion"),
  });
  return Object.freeze({ fingerprint, key: sha256(fingerprint) });
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new TypeError(`${label} has missing or unknown fields`);
  }
}

export function validateCodexCapabilityRecord(value, { now = Date.now() } = {}) {
  exactKeys(value, ["baseUrl", "checkedAt", "detectorVersion", "expiresAt", "fingerprint", "key", "model", "outcome", "provider", "reasonCode", "schemaVersion", "status", "transport"], "Codex capability record");
  if (value.schemaVersion !== CODEX_CAPABILITY_CACHE_SCHEMA_VERSION ||
      !DIGEST.test(value.key) || !OUTCOMES.has(value.outcome) || !TRANSPORTS.has(value.transport) ||
      typeof value.reasonCode !== "string" || value.reasonCode.length === 0 ||
      typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= now || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) {
    throw new TypeError("Codex capability record is invalid or expired");
  }
  const expected = codexCapabilityFingerprint(value.fingerprint);
  if (expected.key !== value.key || expected.fingerprint.provider !== value.provider ||
      expected.fingerprint.model !== value.model || expected.fingerprint.baseUrl !== value.baseUrl ||
      expected.fingerprint.detectorVersion !== value.detectorVersion) {
    throw new TypeError("Codex capability record fingerprint does not match its fields");
  }
  return Object.freeze(structuredClone(value));
}

function recordFromProbe({ key, fingerprint }, probe, now, ttlMs) {
  if (!probe || typeof probe !== "object" || Array.isArray(probe) ||
      !OUTCOMES.has(probe.outcome) || !TRANSPORTS.has(probe.transport) || !Number.isInteger(probe.status)) {
    throw new TypeError("Codex capability probe returned an invalid result");
  }
  if (probe.outcome !== "supported" && probe.outcome !== "unsupported") {
    throw new TypeError("Only a definitive capability result may be cached");
  }
  const checkedAt = new Date(now).toISOString();
  const record = {
    schemaVersion: CODEX_CAPABILITY_CACHE_SCHEMA_VERSION,
    key,
    fingerprint,
    detectorVersion: fingerprint.detectorVersion,
    checkedAt,
    expiresAt: new Date(now + ttlMs).toISOString(),
    provider: fingerprint.provider,
    model: fingerprint.model,
    baseUrl: fingerprint.baseUrl,
    outcome: probe.outcome,
    reasonCode: demand(probe.reasonCode, ID, "reasonCode"),
    status: probe.status,
    transport: probe.transport,
  };
  return validateCodexCapabilityRecord(record, { now });
}

async function readCache(path, now) {
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("Codex capability cache could not be inspected");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > CODEX_CAPABILITY_CACHE_MAX_BYTES) {
    throw new Error("Codex capability cache must be a bounded regular file");
  }
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Codex capability cache is not valid JSON"); }
  exactKeys(value, ["entries", "schemaVersion"], "Codex capability cache");
  if (value.schemaVersion !== CODEX_CAPABILITY_CACHE_SCHEMA_VERSION || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw new Error("Codex capability cache has an invalid schema");
  }
  return value.entries.flatMap((entry) => {
    try { return [validateCodexCapabilityRecord(entry, { now })]; } catch { return []; }
  });
}

async function writeCache(path, entries) {
  const body = `${JSON.stringify({ schemaVersion: CODEX_CAPABILITY_CACHE_SCHEMA_VERSION, entries })}\n`;
  if (Buffer.byteLength(body) > CODEX_CAPABILITY_CACHE_MAX_BYTES) throw new Error("Codex capability cache exceeds its bounded size");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    try { await unlink(temporaryPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath, timeoutMs, pollMs, now = Date.now) {
  const start = now();
  while (now() - start <= timeoutMs) {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw new Error("Codex capability cache lock could not be acquired");
      await delay(pollMs);
    }
  }
  throw new Error("Codex capability cache lock timed out; no probe was replayed");
}

/**
 * Shared-file implementation for the deployment-owned global capability
 * cache. Workers may read the resulting metadata, but the cache path must be
 * a shared volume owned by the deployment layer, never a Worker workspace.
 */
export function createCodexCapabilityCache({
  path = DEFAULT_CODEX_CAPABILITY_CACHE_PATH,
  now = Date.now,
  ttlMs = DEFAULT_CODEX_CAPABILITY_TTL_MS,
  lockTimeoutMs = DEFAULT_CODEX_CAPABILITY_LOCK_TIMEOUT_MS,
  pollMs = 25,
} = {}) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) throw new TypeError("Codex capability cache path must be absolute");
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 24 * 60 * 60 * 1000) throw new TypeError("Codex capability cache TTL is outside the bounded range");
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1_000 || lockTimeoutMs > 120_000) throw new TypeError("Codex capability cache lock timeout is outside the bounded range");
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1_000) throw new TypeError("Codex capability cache poll interval is outside the bounded range");

  const identityFor = ({ provider, model, baseUrl, detectorVersion }) =>
    codexCapabilityFingerprint({ provider, model, baseUrl, detectorVersion });
  const readFresh = async (identity) => {
    const entries = await readCache(path, now());
    return entries.find((entry) => entry.key === identity.key) ?? null;
  };
  const storeIdentity = async (identity, probe) => {
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await acquireLock(lockPath, lockTimeoutMs, pollMs, now);
    try {
      const afterLock = await readFresh(identity);
      if (afterLock) return { cacheHit: true, record: afterLock };
      const record = recordFromProbe(identity, probe, now(), ttlMs);
      const entries = (await readCache(path, now())).filter((entry) => entry.key !== identity.key);
      entries.unshift(record);
      await writeCache(path, entries.slice(0, MAX_ENTRIES));
      return { cacheHit: false, record };
    } finally {
      try { await rmdir(lockPath); } catch { /* a failed cleanup keeps the next caller fail-closed */ }
    }
  };
  return {
    async lookup({ provider, model, baseUrl, detectorVersion }) {
      const identity = identityFor({ provider, model, baseUrl, detectorVersion });
      const record = await readFresh(identity);
      return { cacheHit: Boolean(record), record };
    },
    async store({ provider, model, baseUrl, detectorVersion, probe }) {
      const identity = identityFor({ provider, model, baseUrl, detectorVersion });
      return storeIdentity(identity, probe);
    },
    async resolve({ provider, model, baseUrl, detectorVersion, probe }) {
      if (typeof probe !== "function") throw new TypeError("Codex capability cache requires a probe function");
      const identity = identityFor({ provider, model, baseUrl, detectorVersion });
      const cached = await readFresh(identity);
      if (cached) return { cacheHit: true, record: cached };
      const lockPath = `${path}.lock`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await acquireLock(lockPath, lockTimeoutMs, pollMs, now);
      try {
        const afterLock = await readFresh(identity);
        if (afterLock) return { cacheHit: true, record: afterLock };
        const result = await probe(identity.fingerprint);
        const record = recordFromProbe(identity, result, now(), ttlMs);
        const entries = (await readCache(path, now())).filter((entry) => entry.key !== identity.key);
        entries.unshift(record);
        await writeCache(path, entries.slice(0, MAX_ENTRIES));
        return { cacheHit: false, record };
      } finally {
        try { await rmdir(lockPath); } catch { /* a failed cleanup keeps the next caller fail-closed */ }
      }
    },
  };
}
