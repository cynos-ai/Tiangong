# Worker observability

Tiangong can export a sanitized Worker turn trace through the OpenTelemetry Protocol (OTLP). Tracing is optional, backend-neutral, and disabled by default.

## Boundary

OpenTelemetry traces are diagnostic telemetry. They may be delayed, dropped, sampled, or unavailable and therefore are **not** Tiangong Evidence. A trace cannot authorize an operation, prove an external side effect, or certify a result. Tiangong's hash-chained Evidence remains the audit record.

Official OpenClaw remains responsible for Matrix ingress and delivery. The first Tiangong-owned span begins when OpenClaw invokes the registered Harness.

## Configuration

Configure the `tiangong-pi` OpenClaw plugin with an OTLP HTTP trace endpoint:

```json
{
  "plugins": {
    "entries": {
      "tiangong-pi": {
        "enabled": true,
        "config": {
          "observability": {
            "enabled": true,
            "endpoint": "http://collector.example.test:4318/v1/traces"
          }
        }
      }
    }
  }
}
```

The endpoint must be an absolute HTTP or HTTPS `/v1/traces` URL without embedded credentials, query parameters, or fragments. Headers and arbitrary exporter options are intentionally unsupported. Missing configuration, or `{ "enabled": false }`, selects a no-op implementation.

A focused diagnostic image can embed the same non-secret endpoint without changing the default image behavior:

```bash
TIANGONG_OTEL_EXPORTER_ENDPOINT=http://tiangong-otel-collector:4318/v1/traces \
  make build-worker-image
```

The build validates the embedded endpoint inside the finished image. Explicit plugin configuration takes precedence, including an explicit disable. Do not put credentials or tokens in this build argument; authenticated exporter headers are intentionally outside the current contract. Ambient `OTEL_EXPORTER_OTLP_*` variables are rejected when the exporter is enabled so they cannot inject headers, certificates, private-key paths, or alternate exporter behavior behind this allowlist.

## Trace model

A completed attempt can contain:

```text
tiangong.harness.attempt
├── tiangong.lifecycle.checkpoint
├── tiangong.runtime.setup
├── tiangong.gateway.resolve
├── tiangong.session.open_or_reuse
├── tiangong.pi.agent_turn
├── gen_ai.chat
└── execute_tool
```

Short checkpoint spans make phase entry observable even while a later operation remains in flight. Model activity uses these sanitized phases:

```text
pi.turn.start
model.request.ready
model.response.received
model.response.start
model.response.progress
model.retry
```

`pi.turn.start` is deliberately separate from provider activity: pi emits it before context conversion, credential resolution, and the provider stream call. A trusted built-in inline hook emits `model.request.ready` immediately before pi sends a provider request and `model.response.received` after response headers arrive; discovered external extensions remain disabled. Assistant stream start and update events emit the response phases without reading their content. Progress is coalesced to at most one checkpoint per minute and 32 checkpoints per model operation rather than producing a span per token. `model.retry` represents pi session auto-retry; the pinned public API does not expose lower-level provider-internal retry attempts, so Tiangong does not invent that evidence.

A progress checkpoint proves real response-stream activity. A local timer heartbeat would prove only that the Worker event loop can schedule a timer, not that the provider is progressing, so it is not labeled as model activity. `request.ready` without a later response identifies the waiting-provider boundary, but telemetry alone cannot prove a deadlock: missing export remains `unknown`, and a prolonged silent interval can only be classified as suspected stall until an explicit timeout or abort occurs.

Tool spans wrap the Tiangong-authorized backend execution, not model claims. Terminal outcomes are `complete`, `pending`, `error`, `timeout`, or `upstream_abort`.

## Data policy

The exporter allowlists span names and attributes. It exports only bounded identifiers, digested attempt/turn/session correlation values, provider/model identifiers, timeout, retry counters, tool name, Gate outcome, phase, terminal outcome, and stable error type.

It does not export:

- prompts, model responses, or transcripts;
- credentials, headers, or Matrix message bodies;
- actor display names or raw correlation identifiers;
- tool arguments, results, or write content;
- raw exception messages or stack traces.

Exporter failure does not change the authoritative turn result. Queue, batch, and export time are bounded. Automated verification must query machine-readable OTLP data; a visualization UI such as AgentScope Studio, Jaeger, or Grafana is optional and replaceable.
