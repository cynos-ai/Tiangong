const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const HEX_ID = /^[0-9a-f]{16,32}$/u;
const MAX_RESPONSE_BYTES = 128 * 1024;
const TOP_LEVEL_FIELDS = new Set(["version", "availability", "complete", "truncated", "workId", "environment", "services", "fromEpoch", "toEpoch", "backendRecordCount", "spanCount", "spans", "rawContentEmitted"]);
const SPAN_FIELDS = new Set(["traceId", "spanId", "parentSpanId", "service", "name", "kind", "startEpochNanos", "endEpochNanos", "durationMs", "statusCode", "model", "workId", "taskId", "usage"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens"]);

function failure(code, status = 503) { return Object.assign(new Error(code), { code, status }); }
function exactFields(value, fields) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => fields.has(key)); }
function optionalText(value, limit) { return value === null || (typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000\r\n]/u.test(value)); }
function optionalNanos(value) { return value === null || (typeof value === "string" && /^[0-9]{1,20}$/u.test(value)); }
function optionalToken(value) { return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000); }

export function parseAgentLoopAdapterUrl(value, { allowTestEndpoint = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) throw new TypeError("AgentLoop query adapter URL is invalid");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("AgentLoop query adapter URL is invalid"); }
  const testEndpoint = allowTestEndpoint && url.hostname === "127.0.0.1" && /^[0-9]{1,5}$/u.test(url.port);
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) ||
      (!testEndpoint && (url.hostname !== "agentloop-query-adapter" || url.port !== "8791"))) {
    throw new TypeError("AgentLoop query adapter URL must be the fixed private deployment endpoint");
  }
  return `${url.origin}/`;
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw failure("DIAGNOSTICS_RESPONSE_TOO_LARGE", 502);
  }
  if (!response.body) throw failure("DIAGNOSTICS_RESPONSE_INVALID", 502);
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure("DIAGNOSTICS_RESPONSE_TOO_LARGE", 502); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw failure("DIAGNOSTICS_RESPONSE_INVALID", 502); }
}

function projectUsage(value) {
  if (value === null) return null;
  if (!exactFields(value, USAGE_FIELDS) || Object.keys(value).length !== 3 || !optionalToken(value.inputTokens) || !optionalToken(value.outputTokens) || !optionalToken(value.totalTokens)) throw failure("DIAGNOSTICS_RESPONSE_INVALID", 502);
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens };
}

function projectSpan(value, workId, services) {
  if (!exactFields(value, SPAN_FIELDS) || Object.keys(value).length !== SPAN_FIELDS.size || !HEX_ID.test(value.traceId ?? "") || !HEX_ID.test(value.spanId ?? "") ||
      !(value.parentSpanId === null || HEX_ID.test(value.parentSpanId ?? "")) || !services.includes(value.service) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 256 ||
      !optionalText(value.kind, 32) || !optionalNanos(value.startEpochNanos) || !optionalNanos(value.endEpochNanos) ||
      !(value.durationMs === null || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 86_400_000)) ||
      !["OK", "ERROR", "UNSET", "UNKNOWN"].includes(value.statusCode) || !optionalText(value.model, 128) || value.workId !== workId ||
      !(value.taskId === null || WORK_ID.test(value.taskId))) throw failure("DIAGNOSTICS_RESPONSE_INVALID", 502);
  return {
    traceId: value.traceId, spanId: value.spanId, parentSpanId: value.parentSpanId, service: value.service,
    name: value.name, kind: value.kind, startEpochNanos: value.startEpochNanos, endEpochNanos: value.endEpochNanos,
    durationMs: value.durationMs, statusCode: value.statusCode, model: value.model, workId, taskId: value.taskId,
    usage: projectUsage(value.usage),
  };
}

function summary(spans) {
  // AgentLoop also repeats child LLM usage on parent agent spans. A model-bearing
  // span is the stable LLM boundary; usage-only parents must not be double-counted.
  const llm = spans.filter((span) => span.model !== null);
  const completeSum = (field) => llm.length > 0 && llm.every((span) => span.usage?.[field] !== null && span.usage?.[field] !== undefined)
    ? llm.reduce((sum, span) => sum + span.usage[field], 0) : null;
  const llmDurationMs = llm.length > 0 && llm.every((span) => span.durationMs !== null)
    ? Math.round(llm.reduce((sum, span) => sum + span.durationMs, 0) * 1000) / 1000 : null;
  return {
    traceCount: new Set(spans.map((span) => span.traceId)).size,
    observedSpanCount: spans.length,
    observedErrorSpanCount: spans.filter((span) => span.statusCode === "ERROR").length,
    observedLlmSpanCount: llm.length,
    inputTokens: completeSum("inputTokens"),
    outputTokens: completeSum("outputTokens"),
    totalTokens: completeSum("totalTokens"),
    llmDurationMs,
    cost: null,
  };
}

function projectResponse(value, expected) {
  if (!exactFields(value, TOP_LEVEL_FIELDS) || Object.keys(value).length !== TOP_LEVEL_FIELDS.size || value.version !== 1 || !["observed", "unknown"].includes(value.availability) ||
      typeof value.complete !== "boolean" || typeof value.truncated !== "boolean" || value.complete === value.truncated || value.workId !== expected.workId || !NAME.test(value.environment ?? "") ||
      !Array.isArray(value.services) || value.services.length < 1 || value.services.length > 8 || value.services.some((service) => !NAME.test(service)) || new Set(value.services).size !== value.services.length ||
      value.fromEpoch !== expected.fromEpoch || value.toEpoch !== expected.toEpoch || !Number.isSafeInteger(value.backendRecordCount) || value.backendRecordCount < 0 || value.backendRecordCount > 800 ||
      !Number.isSafeInteger(value.spanCount) || value.spanCount < 0 || value.spanCount > 100 || !Array.isArray(value.spans) || value.spans.length !== value.spanCount || value.rawContentEmitted !== false) {
    throw failure("DIAGNOSTICS_RESPONSE_INVALID", 502);
  }
  const spans = value.spans.map((span) => projectSpan(span, expected.workId, value.services));
  const keys = new Set();
  for (const span of spans) { const key = `${span.traceId}:${span.spanId}`; if (keys.has(key)) throw failure("DIAGNOSTICS_RESPONSE_INVALID", 502); keys.add(key); }
  if ((spans.length > 0) !== (value.availability === "observed")) throw failure("DIAGNOSTICS_RESPONSE_INVALID", 502);
  return {
    version: 1, availability: value.availability, complete: value.complete, truncated: value.truncated,
    workId: value.workId, environment: value.environment, services: [...value.services], fromEpoch: value.fromEpoch, toEpoch: value.toEpoch,
    spanCount: spans.length, spans, summary: summary(spans), rawContentEmitted: false,
  };
}

export function createAgentLoopDiagnosticsClient({
  adapterUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  maxConcurrency = 2,
  cacheTtlMs = 15_000,
  maxCacheEntries = 128,
  now = () => Date.now(),
  allowTestEndpoint = false,
} = {}) {
  const baseUrl = parseAgentLoopAdapterUrl(adapterUrl, { allowTestEndpoint });
  if (!baseUrl) return null;
  if (typeof fetchImpl !== "function") throw new TypeError("AgentLoop diagnostics client requires fetch");
  for (const [value, minimum, maximum, name] of [[timeoutMs, 100, 30_000, "timeout"], [maxConcurrency, 1, 8, "concurrency"], [cacheTtlMs, 1_000, 60_000, "cache TTL"], [maxCacheEntries, 1, 512, "cache entries"]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`AgentLoop diagnostics ${name} is invalid`);
  }
  const cache = new Map(); let active = 0;

  function cleanCache() {
    const time = now();
    for (const [key, entry] of cache) if (entry.expiresAt <= time) cache.delete(key);
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  async function query({ workId, fromEpoch, toEpoch }) {
    if (!WORK_ID.test(workId ?? "") || !Number.isSafeInteger(fromEpoch) || !Number.isSafeInteger(toEpoch) || fromEpoch < 0 || toEpoch <= fromEpoch || toEpoch - fromEpoch > 86_400) throw failure("DIAGNOSTICS_REQUEST_INVALID", 422);
    cleanCache();
    const cached = cache.get(workId);
    if (cached && cached.fromEpoch === fromEpoch) return structuredClone({ ...cached.value, cacheState: "hit" });
    if (active >= maxConcurrency) throw failure("DIAGNOSTICS_CAPACITY_EXCEEDED", 503);
    active += 1;
    try {
      let response;
      try {
        response = await fetchImpl(new URL("v1/traces/query", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workId, fromEpoch, toEpoch }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { throw failure("DIAGNOSTICS_UNAVAILABLE", 503); }
      const body = await readBoundedJson(response);
      if (!response.ok) {
        const code = typeof body?.error === "string" && /^[A-Z0-9_]{1,96}$/u.test(body.error) ? body.error : "QUERY_FAILED";
        throw failure(["QUERY_CAPACITY_EXCEEDED"].includes(code) ? "DIAGNOSTICS_CAPACITY_EXCEEDED" : "DIAGNOSTICS_UNAVAILABLE", response.status === 503 ? 503 : 502);
      }
      const value = projectResponse(body, { workId, fromEpoch, toEpoch });
      const queriedAt = new Date(now()).toISOString();
      const result = Object.freeze({ ...value, queriedAt, cacheState: "miss", authoritative: false, diagnosticNotice: "AgentLoop spans may be sampled, delayed, duplicated, or missing and never determine completion, authorization, or recovery." });
      cache.delete(workId);
      cache.set(workId, { fromEpoch, expiresAt: now() + cacheTtlMs, value: result });
      cleanCache();
      return structuredClone(result);
    } finally { active -= 1; }
  }

  return Object.freeze({ query, cacheSize() { cleanCache(); return cache.size; }, activeCount() { return active; }, clear() { cache.clear(); } });
}
