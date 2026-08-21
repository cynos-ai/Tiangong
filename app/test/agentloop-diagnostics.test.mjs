import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createAgentLoopDiagnosticsClient, parseAgentLoopAdapterUrl } from "../coordination/agentloop-diagnostics.mjs";

function adapterResponse({ workId = "work-test", fromEpoch = 100, toEpoch = 200, spans } = {}) {
  const values = spans ?? [
    { traceId: "a".repeat(32), spanId: "c".repeat(16), parentSpanId: null, service: "service-a", name: "invoke_agent main", kind: "CLIENT", startEpochNanos: "99900000000", endEpochNanos: "100250000000", durationMs: 350, statusCode: "UNSET", model: null, workId, taskId: "task-test", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
    { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "c".repeat(16), service: "service-a", name: "chat glm-5", kind: "CLIENT", startEpochNanos: "100000000000", endEpochNanos: "100250000000", durationMs: 250, statusCode: "OK", model: "glm-5", workId, taskId: "task-test", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
  ];
  return { version: 1, availability: values.length ? "observed" : "unknown", complete: true, truncated: false, workId, environment: "isolated-test", services: ["service-a"], fromEpoch, toEpoch, backendRecordCount: values.length, spanCount: values.length, spans: values, rawContentEmitted: false };
}

async function upstream(t, handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((accept) => server.once("listening", accept));
  return `http://127.0.0.1:${server.address().port}`;
}

function json(response, status, value) { const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); response.end(body); }

test("AgentLoop diagnostics client accepts only the fixed private adapter endpoint", () => {
  assert.equal(parseAgentLoopAdapterUrl(""), null);
  assert.equal(parseAgentLoopAdapterUrl("http://agentloop-query-adapter:8791"), "http://agentloop-query-adapter:8791/");
  for (const value of ["https://agentloop-query-adapter:8791", "http://evil.example:8791", "http://agentloop-query-adapter:8791/path", "http://user:secret@agentloop-query-adapter:8791"]) assert.throws(() => parseAgentLoopAdapterUrl(value), /fixed private deployment endpoint/u);
});

test("AgentLoop diagnostics client projects summaries and uses a bounded memory cache", async (t) => {
  let calls = 0;
  const url = await upstream(t, async (request, response) => {
    calls += 1; const chunks = []; for await (const chunk of request) chunks.push(chunk); const input = JSON.parse(Buffer.concat(chunks));
    json(response, 200, adapterResponse(input));
  });
  let time = Date.parse("2026-08-21T08:00:00Z");
  const client = createAgentLoopDiagnosticsClient({ adapterUrl: url, allowTestEndpoint: true, cacheTtlMs: 1000, now: () => time });
  const first = await client.query({ workId: "work-test", fromEpoch: 100, toEpoch: 200 });
  assert.equal(first.cacheState, "miss"); assert.equal(first.authoritative, false); assert.equal(first.summary.totalTokens, 15); assert.equal(first.summary.llmDurationMs, 250); assert.equal(first.summary.cost, null);
  const second = await client.query({ workId: "work-test", fromEpoch: 100, toEpoch: 210 });
  assert.equal(second.cacheState, "hit"); assert.equal(calls, 1); assert.equal(client.cacheSize(), 1);
  time += 1001;
  assert.equal((await client.query({ workId: "work-test", fromEpoch: 100, toEpoch: 210 })).cacheState, "miss"); assert.equal(calls, 2);
});

test("AgentLoop diagnostics client fails closed on raw or malformed adapter responses", async (t) => {
  const url = await upstream(t, (_request, response) => json(response, 200, { ...adapterResponse(), prompt: "raw-content" }));
  const client = createAgentLoopDiagnosticsClient({ adapterUrl: url, allowTestEndpoint: true });
  await assert.rejects(client.query({ workId: "work-test", fromEpoch: 100, toEpoch: 200 }), (error) => error.code === "DIAGNOSTICS_RESPONSE_INVALID" && error.status === 502);
});

test("AgentLoop diagnostics client bounds timeout and concurrency without affecting unrelated work", async (t) => {
  let release;
  const blocked = new Promise((accept) => { release = accept; });
  const url = await upstream(t, async (request, response) => { await blocked; const chunks = []; for await (const chunk of request) chunks.push(chunk); json(response, 200, adapterResponse(JSON.parse(Buffer.concat(chunks)))); });
  const client = createAgentLoopDiagnosticsClient({ adapterUrl: url, allowTestEndpoint: true, timeoutMs: 100, maxConcurrency: 1 });
  const first = client.query({ workId: "work-a", fromEpoch: 100, toEpoch: 200 });
  await new Promise((accept) => setImmediate(accept));
  await assert.rejects(client.query({ workId: "work-b", fromEpoch: 100, toEpoch: 200 }), (error) => error.code === "DIAGNOSTICS_CAPACITY_EXCEEDED");
  await assert.rejects(first, (error) => error.code === "DIAGNOSTICS_UNAVAILABLE");
  release();
});
