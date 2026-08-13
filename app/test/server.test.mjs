import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeConsoleServer } from "../server.mjs";

test("runtime console exposes health and honest unknown state by default", async (t) => {
  const server = createRuntimeConsoleServer().listen(0);
  t.after(() => server.close());
  const address = server.address();
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const runtime = await fetch(`http://127.0.0.1:${address.port}/api/runtime`);
  assert.equal(runtime.status, 200);
  assert.deepEqual(await runtime.json(), { status: "unknown", source: "runtime-facts-not-configured", lane: null, worker: null });
  const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(ready.status, 503);
});
