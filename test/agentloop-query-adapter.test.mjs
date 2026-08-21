import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SENTINEL_ID = "synthetic-adapter-key-id-never-print";
const SENTINEL_SECRET = "synthetic-adapter-key-secret-never-print";

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw new Error("condition did not become ready");
}

async function startAdapter(t, { concurrency = 1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tg-query-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = join(root, "aliyun-readonly.env");
  const marker = join(root, "query-entered");
  await writeFile(secret, `ALIBABA_CLOUD_ACCESS_KEY_ID=${SENTINEL_ID}\nALIBABA_CLOUD_ACCESS_KEY_SECRET=${SENTINEL_SECRET}\n`, { mode: 0o600 });
  await chmod(secret, 0o600);
  const packageRoot = join(root, "aliyun");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "__init__.py"), "", { mode: 0o600 });
  await writeFile(join(packageRoot, "log.py"), `
import os, time
class _Log:
    def __init__(self, contents): self._contents = contents
    def get_contents(self): return self._contents
class _Response:
    def __init__(self, logs): self._logs = logs
    def get_logs(self): return self._logs
class LogClient:
    def __init__(self, endpoint, access_key_id, access_key_secret): self.timeout = None
    def get_log(self, project, logstore, from_epoch, to_epoch, topic, query, reverse, offset, size):
        if from_epoch == 99: raise RuntimeError("backend-raw-secret-must-not-print")
        if from_epoch == 77:
            open(os.environ["FAKE_QUERY_MARKER"], "w").write("entered")
            time.sleep(0.4)
        common = {"resources":{"deployment.environment":"isolated-test"},"input.value":"raw-prompt-must-not-print","statusMessage":"raw-error-must-not-print"}
        if from_epoch == 55 and query.startswith('"service-a" and "'):
            return _Response([_Log({**common,"serviceName":"service-a","spanName":f"span-{i}","traceID":"0123456789abcdef0123456789abcdef","spanID":f"{i:016x}","attributes":{"tiangong.work.id":"work-test"}}) for i in range(10)])
        if from_epoch == 66 and query.startswith('"service-a" and "'):
            return _Response([_Log({**common,"serviceName":"service-a","spanName":name,"traceID":"0123456789abcdef0123456789abcdef","spanID":"3333333333333333","attributes":{"tiangong.work.id":"work-test"}}) for name in ["first","conflict"]])
        if from_epoch == 67 and query.startswith('"service-a" and "'):
            return _Response([_Log({**common,"serviceName":"service-a","spanName":"wrong-env","traceID":"0123456789abcdef0123456789abcdef","spanID":"4444444444444444","attributes":{"tiangong.work.id":"work-test"},"resources":{"deployment.environment":"production"}})])
        if query.startswith('"service-a" and "'):
            return _Response([
                _Log({**common,"serviceName":"service-a","spanName":"chat glm-5","spanKind":"CLIENT","traceID":"0123456789abcdef0123456789abcdef","spanID":"0123456789abcdef","parentSpanID":"1111111111111111","start":"1787288400000000000","end":"1787288400250000000","duration":"250000000","statusCode":"OK","attributes":{"tiangong.work.id":"work-test","tiangong.task.id":"task-test","gen_ai.response.model":"glm-5","gen_ai.usage.input_tokens":"12","gen_ai.usage.output_tokens":3,"gen_ai.usage.total_tokens":15},"resources":{"deployment.environment":"isolated-test"}}),
                _Log({**common,"serviceName":"service-a","spanName":"gateway_start","traceID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","spanID":"aaaaaaaaaaaaaaaa","attributes":{},"resources":{"deployment.environment":"isolated-test"}}),
            ])
        return _Response([_Log({**common,"serviceName":"service-b","spanName":"react step","spanKind":"INTERNAL","traceID":"0123456789abcdef0123456789abcdef","spanID":"2222222222222222","parentSpanID":"0123456789abcdef","start":"1787288400250000000","duration":"50000000","statusCode":"ERROR","attributes":{"tiangong.work.id":"work-test"},"resources":{"deployment.environment":"isolated-test"}})])
`, { mode: 0o600 });
  const port = await freePort();
  const child = spawn("python3", ["-m", "agentloop_query_adapter.server"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: `${root}${delimiter}${ROOT}`,
      FAKE_QUERY_MARKER: marker,
      TIANGONG_AGENTLOOP_QUERY_SECRET_FILE: secret,
      TIANGONG_AGENTLOOP_QUERY_ENDPOINT: "https://proj-test.cn-hangzhou.log.aliyuncs.com",
      TIANGONG_AGENTLOOP_QUERY_PROJECT: "proj-test",
      TIANGONG_AGENTLOOP_QUERY_SERVICES: "service-a,service-b",
      TIANGONG_AGENTLOOP_QUERY_ENVIRONMENT: "isolated-test",
      TIANGONG_AGENTLOOP_QUERY_MAX_RESULTS: "10",
      TIANGONG_AGENTLOOP_QUERY_MAX_CONCURRENCY: String(concurrency),
      TIANGONG_AGENTLOOP_QUERY_PORT: String(port),
      TIANGONG_AGENTLOOP_QUERY_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((accept) => child.once("exit", accept));
    const output = `${stdout}\n${stderr}`;
    assert.doesNotMatch(output, new RegExp(SENTINEL_ID, "u"));
    assert.doesNotMatch(output, new RegExp(SENTINEL_SECRET, "u"));
    assert.doesNotMatch(output, /backend-raw-secret|raw-prompt|raw-error/u);
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${base}/readyz`)).ok; } catch { return false; } });
  return { base, marker, output: () => ({ stdout, stderr }) };
}

async function query(base, body) {
  const response = await fetch(`${base}/v1/traces/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}

test("AgentLoop query adapter returns only the allowlisted bounded span projection", async (t) => {
  const adapter = await startAdapter(t);
  const { response, body } = await query(adapter.base, { workId: "work-test", fromEpoch: 1787288400, toEpoch: 1787292000 });
  assert.equal(response.status, 200);
  assert.equal(body.availability, "observed");
  assert.equal(body.complete, true);
  assert.equal(body.truncated, false);
  assert.equal(body.spanCount, 2);
  assert.deepEqual(body.services, ["service-a", "service-b"]);
  assert.deepEqual(body.spans[0].usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  assert.equal(body.spans[0].durationMs, 250);
  assert.equal(body.spans[1].statusCode, "ERROR");
  assert.equal(body.rawContentEmitted, false);
  const encoded = JSON.stringify(body);
  for (const forbidden of ["raw-prompt", "raw-error", SENTINEL_ID, SENTINEL_SECRET, "statusMessage", "input.value", "attributes", "resources"]) assert.equal(encoded.includes(forbidden), false);
});

test("AgentLoop query adapter rejects injection, unknown fields, and raw backend failures with bounded codes", async (t) => {
  const adapter = await startAdapter(t);
  const invalid = await query(adapter.base, { workId: "work-test OR *", fromEpoch: 1, toEpoch: 2 });
  assert.equal(invalid.response.status, 422);
  assert.deepEqual(invalid.body, { error: "WORK_ID_INVALID" });
  const hiddenTarget = await query(adapter.base, { workId: "work-test", fromEpoch: 1, toEpoch: 2, project: "other" });
  assert.equal(hiddenTarget.response.status, 422);
  assert.deepEqual(hiddenTarget.body, { error: "REQUEST_BODY_INVALID" });
  const backend = await query(adapter.base, { workId: "work-test", fromEpoch: 99, toEpoch: 100 });
  assert.equal(backend.response.status, 502);
  assert.deepEqual(backend.body, { error: "QUERY_FAILED" });
});

test("AgentLoop query adapter marks truncation and rejects duplicate/environment conflicts", async (t) => {
  const adapter = await startAdapter(t);
  const truncated = await query(adapter.base, { workId: "work-test", fromEpoch: 55, toEpoch: 56 });
  assert.equal(truncated.response.status, 200); assert.equal(truncated.body.complete, false); assert.equal(truncated.body.truncated, true); assert.equal(truncated.body.spanCount, 10);
  const duplicate = await query(adapter.base, { workId: "work-test", fromEpoch: 66, toEpoch: 67 });
  assert.equal(duplicate.response.status, 502); assert.deepEqual(duplicate.body, { error: "DUPLICATE_SPAN_CONFLICT" });
  const environment = await query(adapter.base, { workId: "work-test", fromEpoch: 67, toEpoch: 68 });
  assert.equal(environment.response.status, 502); assert.deepEqual(environment.body, { error: "ENVIRONMENT_SCOPE_MISMATCH" });
});

test("AgentLoop query adapter enforces a deterministic concurrency ceiling", async (t) => {
  const adapter = await startAdapter(t, { concurrency: 1 });
  const first = query(adapter.base, { workId: "work-test", fromEpoch: 77, toEpoch: 78 });
  await waitFor(async () => { try { return (await readFile(adapter.marker, "utf8")) === "entered"; } catch { return false; } });
  const second = await query(adapter.base, { workId: "work-test", fromEpoch: 1, toEpoch: 2 });
  assert.equal(second.response.status, 503);
  assert.deepEqual(second.body, { error: "QUERY_CAPACITY_EXCEEDED" });
  assert.equal((await first).response.status, 200);
});
