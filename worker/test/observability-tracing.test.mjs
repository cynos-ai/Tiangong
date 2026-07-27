import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  createWorkerObservability,
  DISABLED_OBSERVABILITY,
  parseObservabilityConfig,
  resolveObservabilityConfig,
} from "../observability/tracing.mjs";

const ENABLED_CONFIG = {
  enabled: true,
  endpoint: "http://127.0.0.1:4318/v1/traces",
};

function metadata(overrides = {}) {
  return {
    harnessId: "tiangong-pi",
    attemptId: "attempt-secret-value",
    turnId: "matrix:event-secret-value",
    sessionId: "session-secret-value",
    provider: "agentteams-gateway",
    modelId: "qwen3.5-plus",
    timeoutMs: 30_000,
    ...overrides,
  };
}

function spanByName(spans, name) {
  const matches = spans.filter((span) => span.name === name);
  assert.equal(matches.length, 1, `expected exactly one ${name} span`);
  return matches[0];
}

test("observability is disabled unless an exact configuration enables it", () => {
  assert.deepEqual(parseObservabilityConfig(undefined), { enabled: false });
  assert.deepEqual(parseObservabilityConfig({ enabled: false }), { enabled: false });
  assert.equal(createWorkerObservability().enabled, false);
  assert.equal(createWorkerObservability({ config: { enabled: false } }), DISABLED_OBSERVABILITY);
});

test("resolves explicit plugin configuration before the diagnostic image endpoint", () => {
  assert.deepEqual(resolveObservabilityConfig(undefined, {}), { enabled: false });
  assert.deepEqual(resolveObservabilityConfig(undefined, {
    TIANGONG_OTEL_EXPORTER_ENDPOINT: ENABLED_CONFIG.endpoint,
  }), ENABLED_CONFIG);
  assert.deepEqual(resolveObservabilityConfig({ observability: { enabled: false } }, {
    TIANGONG_OTEL_EXPORTER_ENDPOINT: ENABLED_CONFIG.endpoint,
  }), { enabled: false });
  assert.throws(
    () => resolveObservabilityConfig(undefined, {
      TIANGONG_OTEL_EXPORTER_ENDPOINT: "http://user:secret@localhost/v1/traces",
    }),
    /without credentials/u,
  );
});

test("observability configuration rejects ambiguous or credential-bearing endpoints", () => {
  const invalid = [
    true,
    {},
    { enabled: "true" },
    { enabled: false, endpoint: ENABLED_CONFIG.endpoint },
    { enabled: true },
    { enabled: true, endpoint: "file:///tmp/traces" },
    { enabled: true, endpoint: "http://user:secret@localhost/v1/traces" },
    { enabled: true, endpoint: "http://localhost/v1/traces?token=secret" },
    { enabled: true, endpoint: "http://localhost/" },
    { enabled: true, endpoint: ENABLED_CONFIG.endpoint, headers: { authorization: "secret" } },
  ];
  for (const value of invalid) {
    assert.throws(() => parseObservabilityConfig(value), /observability|endpoint|enabled/iu);
  }
  assert.deepEqual(parseObservabilityConfig(ENABLED_CONFIG), ENABLED_CONFIG);
  assert.throws(
    () => createWorkerObservability({
      config: ENABLED_CONFIG,
      environment: { OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret" },
    }),
    /Ambient OTLP exporter configuration is unsupported/u,
  );
  assert.throws(
    () => createWorkerObservability({
      config: ENABLED_CONFIG,
      environment: { OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: "/private/key" },
    }),
    /Ambient OTLP exporter configuration is unsupported/u,
  );
});

test("exports a sanitized Harness hierarchy without content-bearing attributes", async (t) => {
  const exporter = new InMemorySpanExporter();
  const observability = createWorkerObservability({ config: ENABLED_CONFIG, exporter });
  t.after(() => observability.shutdown());

  const attempt = observability.startAttempt(metadata());
  attempt.checkpoint("runtime.start");
  const setup = attempt.startOperation("tiangong.runtime.setup");
  setup.end("complete");
  const model = attempt.startOperation("gen_ai.chat", {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "agentteams-gateway",
    "gen_ai.request.model": "qwen3.5-plus",
  });
  attempt.checkpoint("model.start");
  model.end("complete");
  attempt.finish("complete");
  await observability.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 6);
  const root = spanByName(spans, "tiangong.harness.attempt");
  const setupSpan = spanByName(spans, "tiangong.runtime.setup");
  const modelSpan = spanByName(spans, "gen_ai.chat");
  assert.equal(root.status.code, SpanStatusCode.OK);
  assert.equal(setupSpan.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(modelSpan.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.ok(spans.filter((span) => span !== root).every(
    (span) => span.attributes["tiangong.attempt.id"] === root.attributes["tiangong.attempt.id"],
  ));
  assert.ok(spans.filter((span) => span !== root).every(
    (span) => span.attributes["tiangong.turn.id"] === root.attributes["tiangong.turn.id"],
  ));
  assert.match(root.attributes["tiangong.attempt.id"], /^[a-f0-9]{24}$/u);
  assert.match(root.attributes["tiangong.turn.id"], /^[a-f0-9]{24}$/u);
  assert.match(root.attributes["tiangong.session.id"], /^[a-f0-9]{24}$/u);
  assert.equal(root.attributes["tiangong.timeout_ms"], 30_000);

  const serialized = JSON.stringify(spans.map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
  })));
  for (const forbidden of [
    "attempt-secret-value",
    "event-secret-value",
    "session-secret-value",
    "prompt",
    "response",
    "credential",
    "authorization",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `trace leaked ${forbidden}`);
  }
});

test("records timeout and abort as stable terminal outcomes without raw errors", async (t) => {
  const exporter = new InMemorySpanExporter();
  const observability = createWorkerObservability({ config: ENABLED_CONFIG, exporter });
  t.after(() => observability.shutdown());

  const timedOut = observability.startAttempt(metadata({ attemptId: "timeout-attempt" }));
  const model = timedOut.startOperation("gen_ai.chat", { "gen_ai.operation.name": "chat" });
  model.end("timeout", new Error("secret timeout body"));
  timedOut.finish("timeout", new Error("another secret body"));

  const aborted = observability.startAttempt(metadata({ attemptId: "abort-attempt" }));
  aborted.finish("upstream_abort", new Error("secret abort reason"));
  await observability.forceFlush();

  const roots = exporter.getFinishedSpans().filter((span) => span.name === "tiangong.harness.attempt");
  assert.equal(roots.length, 2);
  assert.deepEqual(
    roots.map((span) => span.attributes["tiangong.operation.outcome"]),
    ["timeout", "upstream_abort"],
  );
  assert.deepEqual(roots.map((span) => span.attributes["error.type"]), ["timeout", "upstream_abort"]);
  assert.ok(roots.every((span) => span.status.code === SpanStatusCode.ERROR));
  const serialized = JSON.stringify(roots.map((span) => ({ attributes: span.attributes, status: span.status })));
  assert.equal(serialized.includes("secret timeout body"), false);
  assert.equal(serialized.includes("secret abort reason"), false);
});

test("exports sanitized spans through the standard OTLP HTTP boundary", async (t) => {
  let acceptRequest;
  const received = new Promise((resolve) => { acceptRequest = resolve; });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      acceptRequest({
        method: request.method,
        path: request.url,
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const observability = createWorkerObservability({
    config: { enabled: true, endpoint: `http://127.0.0.1:${address.port}/v1/traces` },
    environment: {},
  });
  t.after(() => observability.shutdown());

  const attempt = observability.startAttempt(metadata());
  attempt.checkpoint("runtime.start");
  attempt.finish("complete");
  await observability.forceFlush();
  const request = await received;

  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/traces");
  assert.match(request.contentType, /^application\/json/u);
  const payload = JSON.parse(request.body.toString("utf8"));
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  const root = spans.find((span) => span.name === "tiangong.harness.attempt");
  const checkpoints = spans.filter((span) => span.name === "tiangong.lifecycle.checkpoint");
  assert.ok(root);
  assert.equal(checkpoints.length, 2);
  assert.ok(checkpoints.every((span) => span.traceId === root.traceId));
  assert.ok(checkpoints.every((span) => span.parentSpanId === root.spanId));
  const rootAttempt = root.attributes.find((attribute) => attribute.key === "tiangong.attempt.id");
  assert.ok(checkpoints.every((span) => span.attributes.some(
    (attribute) => attribute.key === "tiangong.attempt.id" &&
      attribute.value.stringValue === rootAttempt.value.stringValue,
  )));
  for (const forbidden of ["attempt-secret-value", "event-secret-value", "session-secret-value"]) {
    assert.equal(request.body.includes(Buffer.from(forbidden)), false, `OTLP body leaked ${forbidden}`);
  }
});

test("an exporter failure cannot change the authoritative attempt path", async () => {
  const exporter = {
    export(_spans, callback) {
      callback({ code: 1, error: new Error("private exporter failure") });
    },
    async forceFlush() {},
    async shutdown() {},
  };
  const observability = createWorkerObservability({ config: ENABLED_CONFIG, exporter });
  const attempt = observability.startAttempt(metadata());
  assert.doesNotThrow(() => {
    attempt.checkpoint("runtime.start");
    attempt.finish("complete");
  });
  await observability.shutdown();
});

test("rejects unapproved span operations and attributes before export", async (t) => {
  const exporter = new InMemorySpanExporter();
  const observability = createWorkerObservability({ config: ENABLED_CONFIG, exporter });
  t.after(() => observability.shutdown());
  const attempt = observability.startAttempt(metadata());

  assert.throws(() => attempt.startOperation("arbitrary.operation"), /Unsupported observability operation/u);
  assert.throws(
    () => attempt.startOperation("gen_ai.chat", { "untrusted.prompt": "secret" }),
    /Unsupported observability attribute/u,
  );
  assert.throws(() => attempt.checkpoint("arbitrary.phase"), /Unsupported observability phase/u);
  attempt.finish("error", Object.assign(new Error("secret"), { code: "INVALID CODE WITH SPACES" }));
  await observability.forceFlush();

  const root = spanByName(exporter.getFinishedSpans(), "tiangong.harness.attempt");
  assert.equal(root.attributes["error.type"], "internal_error");
});
