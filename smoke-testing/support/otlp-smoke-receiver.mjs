import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

const port = Number(process.env.TIANGONG_OTLP_RECEIVER_PORT ?? 4318);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError("OTLP receiver port is invalid");
}
const MAX_BODY_BYTES = 1_048_576;
const outputPath = resolve(process.argv[2] ?? "/data/spans.jsonl");
const ALLOWED_SPAN_NAMES = new Set([
  "tiangong.harness.attempt",
  "tiangong.lifecycle.checkpoint",
  "tiangong.runtime.setup",
  "tiangong.gateway.resolve",
  "tiangong.session.open_or_reuse",
  "tiangong.pi.agent_turn",
  "gen_ai.chat",
  "execute_tool",
]);
const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "error.type",
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "tiangong.approval.pending",
  "tiangong.attempt.id",
  "tiangong.gate.outcome",
  "tiangong.harness.id",
  "tiangong.operation.outcome",
  "tiangong.phase",
  "tiangong.retry.attempt",
  "tiangong.retry.max_attempts",
  "tiangong.session.id",
  "tiangong.timeout_ms",
  "tiangong.tool.name",
  "tiangong.turn.id",
]);
const HEX_ID = /^[a-f0-9]{16,32}$/u;
const SAFE_STATUS_MESSAGE = /^(?:[A-Z][A-Z0-9_]{0,63}|timeout|upstream_abort)$/u;

function primitiveValue(value) {
  const entries = Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined);
  if (entries.length !== 1) throw new TypeError("OTLP attribute value is not primitive");
  const [kind, entry] = entries[0];
  if (!new Set(["stringValue", "intValue", "doubleValue", "boolValue"]).has(kind)) {
    throw new TypeError("OTLP attribute value type is unsupported");
  }
  if (!["string", "number", "boolean"].includes(typeof entry)) {
    throw new TypeError("OTLP attribute value is malformed");
  }
  return entry;
}

function attributesFrom(entries) {
  if (!Array.isArray(entries) || entries.length > 24) throw new TypeError("OTLP attributes are unbounded");
  const attributes = {};
  for (const attribute of entries) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(attribute?.key) || Object.hasOwn(attributes, attribute.key)) {
      throw new TypeError("OTLP attribute is not allowlisted");
    }
    const value = primitiveValue(attribute.value);
    if (typeof value === "string" && (value.length === 0 || value.length > 128 || /[\r\n]/u.test(value))) {
      throw new TypeError("OTLP string attribute is unbounded");
    }
    attributes[attribute.key] = value;
  }
  return attributes;
}

function sanitizedSpans(payload) {
  const resourceSpans = payload?.resourceSpans;
  if (!Array.isArray(resourceSpans) || resourceSpans.length === 0 || resourceSpans.length > 8) {
    throw new TypeError("OTLP resource span count is invalid");
  }
  const result = [];
  for (const resourceSpan of resourceSpans) {
    const resourceEntries = resourceSpan?.resource?.attributes;
    if (!Array.isArray(resourceEntries) || resourceEntries.length !== 2) {
      throw new TypeError("OTLP resource attributes are invalid");
    }
    const resource = Object.fromEntries(resourceEntries.map(
      (attribute) => [attribute.key, primitiveValue(attribute.value)],
    ));
    if (Object.keys(resource).length !== 2 || resource["service.name"] !== "tiangong-worker" ||
        resource["service.namespace"] !== "tiangong") {
      throw new TypeError("OTLP resource identity is invalid");
    }
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      if (scopeSpan?.scope?.name !== "io.cynos-ai.tiangong.worker") {
        throw new TypeError("OTLP instrumentation scope is invalid");
      }
      if (!Array.isArray(scopeSpan.spans) || scopeSpan.spans.length > 128) {
        throw new TypeError("OTLP span batch is unbounded");
      }
      for (const span of scopeSpan.spans) {
        if (!ALLOWED_SPAN_NAMES.has(span?.name) || !HEX_ID.test(span.traceId) || !HEX_ID.test(span.spanId) ||
            (span.parentSpanId != null && !HEX_ID.test(span.parentSpanId)) ||
            !Array.isArray(span.events) || span.events.length !== 0 ||
            !Array.isArray(span.links) || span.links.length !== 0) {
          throw new TypeError("OTLP span shape is invalid");
        }
        const statusMessage = span.status?.message;
        if (statusMessage !== undefined && !SAFE_STATUS_MESSAGE.test(statusMessage)) {
          throw new TypeError("OTLP status message is not a stable error type");
        }
        result.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ?? null,
          name: span.name,
          statusCode: span.status?.code ?? 0,
          attributes: attributesFrom(span.attributes),
        });
      }
    }
  }
  if (result.length === 0 || result.length > 256) throw new TypeError("OTLP request has no bounded spans");
  return result;
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new TypeError("OTLP request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
let writeQueue = Promise.resolve();
const appendSpans = (spans) => {
  const write = writeQueue.then(() => appendFile(
    outputPath,
    spans.map((span) => `${JSON.stringify(span)}\n`).join(""),
    { mode: 0o600 },
  ));
  writeQueue = write.catch(() => {});
  return write;
};
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ready"}\n');
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/traces" ||
      !String(request.headers["content-type"] ?? "").startsWith("application/json")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"unsupported"}\n');
    return;
  }
  try {
    const spans = sanitizedSpans(JSON.parse(await requestBody(request)));
    await appendSpans(spans);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}\n");
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end('{"error":"invalid_otlp"}\n');
  }
});

server.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
