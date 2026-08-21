import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const port = Number(process.env.TIANGONG_OTLP_RECEIVER_PORT ?? 4318);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError("OTLP receiver port is invalid");
}
const MAX_BODY_BYTES = 1_048_576;
const outputPath = resolve(process.argv[2] ?? "/data/spans.jsonl");
const ALLOWED_SPAN_NAMES = new Set([
  "tiangong.control.attempt",
  "tiangong.lifecycle.checkpoint",
  "tiangong.runtime.setup",
  "tiangong.gateway.resolve",
  "tiangong.session.open_or_reuse",
  "tiangong.openclaw.agent_turn",
  "gen_ai.chat",
  "execute_tool",
]);
const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "error.type",
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "tiangong.attempt.id",
  "tiangong.gate.outcome",
  "tiangong.control.id",
  "tiangong.operation.outcome",
  "tiangong.phase",
  "tiangong.retry.attempt",
  "tiangong.retry.max_attempts",
  "tiangong.session.id",
  "tiangong.timeout_ms",
  "tiangong.tool.name",
  "tiangong.turn.id",
  "tiangong.work.id",
  "tiangong.task.id",
  "tiangong.member.id",
  "tiangong.session.ref",
  "tiangong.skill.id",
  "tiangong.tool_result.id",
]);

const TRACE_PROTO = `
syntax = "proto3";
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4;
  string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10;
  repeated SpanEvent events = 11; uint32 dropped_events_count = 12;
  repeated SpanLink links = 13; uint32 dropped_links_count = 14; Status status = 15; fixed32 flags = 16;
}
message SpanEvent { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message SpanLink { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5; fixed32 flags = 6; }
message Status { string message = 2; int32 code = 3; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
`;
let traceRequestType;

function decodeProtobufTrace(buffer) {
  if (!traceRequestType) {
    const require = createRequire("/opt/openclaw/package.json");
    const protobuf = require("protobufjs");
    traceRequestType = protobuf.parse(TRACE_PROTO).root.lookupType("ExportTraceServiceRequest");
  }
  const decoded = traceRequestType.toObject(traceRequestType.decode(buffer), {
    arrays: true,
    objects: true,
    longs: Number,
    bytes: Buffer,
  });
  for (const resourceSpan of decoded.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        span.traceId = Buffer.from(span.traceId ?? []).toString("hex");
        span.spanId = Buffer.from(span.spanId ?? []).toString("hex");
        const parent = Buffer.from(span.parentSpanId ?? []).toString("hex");
        span.parentSpanId = parent || null;
        span.events ??= [];
        span.links ??= [];
      }
    }
  }
  return decoded;
}
const HEX_ID = /^[a-f0-9]{16,32}$/u;
const SAFE_STATUS_MESSAGE = /^(?:[A-Z][A-Z0-9_]{0,63}|internal_error|timeout|upstream_abort)$/u;
const REJECTION_CODES = new Map([
  ["OTLP attribute value is not primitive", "attribute_value_not_primitive"],
  ["OTLP attribute value type is unsupported", "attribute_value_type_unsupported"],
  ["OTLP attribute value is malformed", "attribute_value_malformed"],
  ["OTLP attributes are unbounded", "attributes_unbounded"],
  ["OTLP attribute is not allowlisted", "attribute_not_allowlisted"],
  ["OTLP string attribute is unbounded", "string_attribute_unbounded"],
  ["OTLP resource span count is invalid", "resource_span_count_invalid"],
  ["OTLP resource attributes are invalid", "resource_attributes_invalid"],
  ["OTLP resource identity is invalid", "resource_identity_invalid"],
  ["OTLP instrumentation scope is invalid", "instrumentation_scope_invalid"],
  ["OTLP span batch is unbounded", "span_batch_unbounded"],
  ["OTLP span shape is invalid", "span_shape_invalid"],
  ["OTLP status message is not a stable error type", "status_message_unstable"],
  ["OTLP request has no bounded spans", "request_span_count_invalid"],
  ["OTLP request body is too large", "request_body_too_large"],
]);

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
      if (scopeSpan?.scope?.name !== "io.tiangong.worker") {
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
  return Buffer.concat(chunks);
}

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
let writeQueue = Promise.resolve();
const counters = { acceptedRequests: 0, rejectedRequests: 0, acceptedSpans: 0 };
const rejectionReasons = Object.create(null);
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
    response.end(`${JSON.stringify({ status: "ready", ...counters, rejectionReasons })}\n`);
    return;
  }
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim();
  if (request.method !== "POST" || request.url !== "/v1/traces" ||
      !new Set(["application/json", "application/x-protobuf"]).has(contentType)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"unsupported"}\n');
    return;
  }
  let stage = "body";
  try {
    const body = await requestBody(request);
    stage = contentType === "application/x-protobuf" ? "protobuf" : "json";
    const payload = contentType === "application/x-protobuf" ? decodeProtobufTrace(body) : JSON.parse(body.toString("utf8"));
    stage = "validation";
    const spans = sanitizedSpans(payload);
    stage = "persistence";
    await appendSpans(spans);
    stage = "complete";
    counters.acceptedRequests += 1;
    counters.acceptedSpans += spans.length;
    response.writeHead(200, { "content-type": contentType === "application/x-protobuf" ? "application/x-protobuf" : "application/json" });
    response.end(contentType === "application/x-protobuf" ? undefined : "{}\n");
  } catch (error) {
    counters.rejectedRequests += 1;
    const rejectionCode = REJECTION_CODES.get(error?.message) ?? `${stage}_failure`;
    rejectionReasons[rejectionCode] = (rejectionReasons[rejectionCode] ?? 0) + 1;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ error: rejectionCode })}\n`);
  }
});

server.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
