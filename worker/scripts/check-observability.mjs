import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { createWorkerObservability } from "../observability/tracing.mjs";

const exporter = new InMemorySpanExporter();
const observability = createWorkerObservability({
  config: { enabled: true, endpoint: "http://127.0.0.1:4318/v1/traces" },
  exporter,
});
const attempt = observability.startAttempt({
  harnessId: "tiangong-pi",
  attemptId: "image-contract-attempt",
  turnId: "image-contract-turn",
  sessionId: "image-contract-session",
  provider: "agentteams-gateway",
  modelId: "contract-model",
  timeoutMs: 1_000,
});
attempt.checkpoint("runtime.start");
attempt.finish("complete");
await observability.forceFlush();

const spans = exporter.getFinishedSpans();
const root = spans.find((span) => span.name === "tiangong.harness.attempt");
const checkpoints = spans.filter((span) => span.name === "tiangong.lifecycle.checkpoint");
if (!root || checkpoints.length !== 2 ||
    checkpoints.some((span) => span.parentSpanContext?.spanId !== root.spanContext().spanId)) {
  throw new Error("Worker image observability hierarchy contract failed");
}
const serialized = JSON.stringify(spans.map((span) => ({
  name: span.name,
  attributes: span.attributes,
})));
for (const forbidden of ["image-contract-attempt", "image-contract-turn", "image-contract-session"]) {
  if (serialized.includes(forbidden)) throw new Error("Worker image observability sanitization contract failed");
}
await observability.shutdown();
console.log("Worker image observability contract passed.");
