import { createHash } from "node:crypto";

import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const INSTRUMENTATION_NAME = "io.cynos-ai.tiangong.worker";
const INSTRUMENTATION_VERSION = "0.0.0";
const SERVICE_NAME = "tiangong-worker";
const MAX_ATTRIBUTE_LENGTH = 128;
const MAX_TIMEOUT_MS = 2_147_483_647;
const OTLP_TRACE_PATH = "/v1/traces";
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_ERROR_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const OUTCOMES = new Set(["complete", "error", "timeout", "upstream_abort", "pending"]);
const OPERATIONS = new Set([
  "tiangong.runtime.setup",
  "tiangong.gateway.resolve",
  "tiangong.session.open_or_reuse",
  "tiangong.pi.agent_turn",
  "gen_ai.chat",
  "execute_tool",
]);
const PHASES = new Set([
  "harness.start",
  "runtime.start",
  "gateway.resolved",
  "session.ready",
  "pi.agent_turn.start",
  "pi.turn.start",
  "model.request.ready",
  "model.response.received",
  "model.response.start",
  "model.response.progress",
  "model.retry",
  "tool.proposed",
  "gate.decided",
  "tool.replayed",
]);
const ATTRIBUTE_KEYS = new Set([
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

function ownKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function assertExactKeys(value, allowed, label) {
  for (const key of ownKeys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function parseEndpoint(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError("Enabled Worker observability requires a bounded OTLP HTTP endpoint");
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Worker observability endpoint must be an absolute URL");
  }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== OTLP_TRACE_PATH) {
    throw new TypeError("Worker observability endpoint must be an HTTP(S) /v1/traces URL without credentials, query, or fragment");
  }
  return endpoint.toString();
}

export function parseObservabilityConfig(value) {
  if (value === undefined || value === null) return Object.freeze({ enabled: false });
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Worker observability configuration must be an object");
  }
  assertExactKeys(value, new Set(["enabled", "endpoint"]), "Worker observability configuration");
  if (typeof value.enabled !== "boolean") {
    throw new TypeError("Worker observability enabled must be a boolean");
  }
  if (!value.enabled) {
    if (value.endpoint !== undefined) {
      throw new TypeError("Disabled Worker observability must not configure an endpoint");
    }
    return Object.freeze({ enabled: false });
  }
  return Object.freeze({ enabled: true, endpoint: parseEndpoint(value.endpoint) });
}

export function resolveObservabilityConfig(pluginConfig, environment = process.env) {
  if (pluginConfig?.observability !== undefined) {
    return parseObservabilityConfig(pluginConfig.observability);
  }
  const endpoint = environment?.TIANGONG_OTEL_EXPORTER_ENDPOINT;
  return endpoint === undefined || endpoint === ""
    ? Object.freeze({ enabled: false })
    : parseObservabilityConfig({ enabled: true, endpoint });
}

function assertNoAmbientOtlpConfiguration(environment) {
  const key = Object.keys(environment ?? {}).find(
    (name) => name.startsWith("OTEL_EXPORTER_OTLP_") && environment[name] !== "",
  );
  if (key) {
    throw new TypeError("Ambient OTLP exporter configuration is unsupported; use the Tiangong endpoint contract");
  }
}

function correlationDigest(domain, value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return createHash("sha256").update(`tiangong-observability:${domain}\0${value}`).digest("hex").slice(0, 24);
}

function safeToken(value, label) {
  if (typeof value === "string" && SAFE_TOKEN.test(value)) return value;
  const digest = correlationDigest(label, String(value ?? "unknown"));
  return `sha256:${digest}`;
}

function safeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative integer`);
  }
  return value;
}

function safeAttributes(attributes = {}) {
  const result = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (!ATTRIBUTE_KEYS.has(key)) throw new TypeError(`Unsupported observability attribute: ${key}`);
    if (typeof value === "string") {
      if (value.length === 0 || value.length > MAX_ATTRIBUTE_LENGTH || /[\r\n]/u.test(value)) {
        throw new TypeError(`Observability attribute ${key} must be a bounded single-line string`);
      }
    } else if (typeof value === "number") {
      safeInteger(value, `Observability attribute ${key}`, MAX_TIMEOUT_MS);
    } else if (typeof value !== "boolean") {
      throw new TypeError(`Observability attribute ${key} has an unsupported type`);
    }
    result[key] = value;
  }
  return result;
}

function safeErrorType(error, fallback = "internal_error") {
  const candidate = error?.code;
  return typeof candidate === "string" && SAFE_ERROR_TYPE.test(candidate)
    ? candidate
    : fallback;
}

function statusFor(outcome, errorType) {
  if (outcome === "complete" || outcome === "pending") {
    return { code: SpanStatusCode.OK };
  }
  return { code: SpanStatusCode.ERROR, message: errorType };
}

const NOOP_OPERATION = Object.freeze({
  end() {},
});

const NOOP_ATTEMPT = Object.freeze({
  checkpoint() {},
  startOperation() { return NOOP_OPERATION; },
  finish() {},
});

export const DISABLED_OBSERVABILITY = Object.freeze({
  enabled: false,
  startAttempt() { return NOOP_ATTEMPT; },
  async forceFlush() {},
  async shutdown() {},
});

function operationHandle(span) {
  let ended = false;
  return {
    end(outcome = "complete", error) {
      if (ended) return;
      ended = true;
      const normalizedOutcome = OUTCOMES.has(outcome) ? outcome : "error";
      const errorType = normalizedOutcome === "timeout"
        ? "timeout"
        : normalizedOutcome === "upstream_abort"
          ? "upstream_abort"
          : normalizedOutcome === "error"
            ? safeErrorType(error)
            : undefined;
      span.setAttribute("tiangong.operation.outcome", normalizedOutcome);
      if (errorType) span.setAttribute("error.type", errorType);
      span.setStatus(statusFor(normalizedOutcome, errorType));
      span.end();
    },
  };
}

function attemptHandle(tracer, rootSpan, correlationAttributes) {
  const parentContext = trace.setSpan(context.active(), rootSpan);
  const root = operationHandle(rootSpan);
  return {
    checkpoint(phase, attributes = {}) {
      if (!PHASES.has(phase)) throw new TypeError(`Unsupported observability phase: ${phase}`);
      const span = tracer.startSpan(
        "tiangong.lifecycle.checkpoint",
        {
          kind: SpanKind.INTERNAL,
          attributes: safeAttributes({
            ...correlationAttributes,
            ...attributes,
            "tiangong.phase": phase,
          }),
        },
        parentContext,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },
    startOperation(name, attributes = {}) {
      if (!OPERATIONS.has(name)) throw new TypeError(`Unsupported observability operation: ${name}`);
      const kind = name === "gen_ai.chat" ? SpanKind.CLIENT : SpanKind.INTERNAL;
      const span = tracer.startSpan(
        name,
        { kind, attributes: safeAttributes({ ...correlationAttributes, ...attributes }) },
        parentContext,
      );
      return operationHandle(span);
    },
    finish(outcome = "complete", error) {
      root.end(outcome, error);
    },
  };
}

export function createWorkerObservability(options = {}) {
  const config = parseObservabilityConfig(options.config);
  if (!config.enabled) return DISABLED_OBSERVABILITY;

  if (!options.exporter) assertNoAmbientOtlpConfiguration(options.environment ?? process.env);
  const exporter = options.exporter ?? new OTLPTraceExporter({
    url: config.endpoint,
    timeoutMillis: 3_000,
  });
  const processor = options.exporter
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter, {
      maxQueueSize: 256,
      maxExportBatchSize: 64,
      scheduledDelayMillis: 1_000,
      exportTimeoutMillis: 3_000,
    });
  const provider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource: resourceFromAttributes({
      "service.name": SERVICE_NAME,
      "service.namespace": "tiangong",
    }),
    spanProcessors: [processor],
    forceFlushTimeoutMillis: 3_000,
    generalLimits: {
      attributeCountLimit: 24,
      attributeValueLengthLimit: MAX_ATTRIBUTE_LENGTH,
    },
  });
  const tracer = provider.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);

  return {
    enabled: true,
    startAttempt(metadata) {
      if (!metadata || typeof metadata !== "object") {
        throw new TypeError("Harness attempt observability metadata is required");
      }
      const timeoutMs = safeInteger(Math.floor(metadata.timeoutMs), "Harness timeout", MAX_TIMEOUT_MS);
      if (timeoutMs === 0) throw new TypeError("Harness timeout must be positive");
      const correlationAttributes = {
        "tiangong.attempt.id": correlationDigest("attempt", metadata.attemptId),
        "tiangong.turn.id": correlationDigest("turn", metadata.turnId),
        "tiangong.session.id": correlationDigest("session", metadata.sessionId),
      };
      const rootSpan = tracer.startSpan("tiangong.harness.attempt", {
        kind: SpanKind.INTERNAL,
        attributes: safeAttributes({
          "tiangong.harness.id": safeToken(metadata.harnessId, "Harness id"),
          ...correlationAttributes,
          "gen_ai.provider.name": safeToken(metadata.provider, "Provider"),
          "gen_ai.request.model": safeToken(metadata.modelId, "Model id"),
          "tiangong.timeout_ms": timeoutMs,
        }),
      });
      const attempt = attemptHandle(tracer, rootSpan, correlationAttributes);
      attempt.checkpoint("harness.start");
      return attempt;
    },
    async forceFlush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}

export function observabilityOutcome(signal) {
  if (!signal?.aborted) return "error";
  return /timeout/iu.test(String(signal.reason ?? "")) ? "timeout" : "upstream_abort";
}

export function observabilityErrorType(error, fallback) {
  return safeErrorType(error, fallback);
}
