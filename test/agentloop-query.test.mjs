import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const WRAPPER = join(ROOT, "scripts", "agentloop-trace-query.sh");
const PYTHON = join(ROOT, "scripts", "agentloop_trace_query.py");
const SENTINEL_ID = "synthetic-access-key-id-never-print";
const SENTINEL_SECRET = "synthetic-access-key-secret-never-print";
const ARGS = [
  "--endpoint", "https://proj-xtrace-test-cn-hangzhou.cn-hangzhou.log.aliyuncs.com",
  "--project", "proj-xtrace-test-cn-hangzhou",
  "--service", "tiangong-agentloop-query-test",
  "--from-epoch", "1787288400",
  "--to-epoch", "1787292000",
  "--expected-work-id", "work-test",
  "--expected-task-id", "task-test",
  "--validate-only",
];

async function secretFixture(t, mode = 0o600, content) {
  const root = await mkdtemp(join(tmpdir(), "tg-agentloop-query-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "aliyun-readonly.env");
  await writeFile(path, content ?? [
    `ALIBABA_CLOUD_ACCESS_KEY_ID=${SENTINEL_ID}`,
    `ALIBABA_CLOUD_ACCESS_KEY_SECRET=${SENTINEL_SECRET}`,
    "",
  ].join("\n"), { mode });
  await chmod(path, mode);
  return { root, path };
}

function run(args = ARGS, env = {}) {
  return spawnSync("bash", [WRAPPER, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

function assertNoCredentialOutput(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, new RegExp(SENTINEL_ID, "u"));
  assert.doesNotMatch(output, new RegExp(SENTINEL_SECRET, "u"));
}

test("AgentLoop query smoke fails closed before loading the SDK when no secret path is selected", () => {
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agentloop_trace_query=fail code=QUERY_SECRET_FILE_REQUIRED/u);
  assert.equal(result.stdout, "");
});

test("AgentLoop query smoke accepts only an owned private exact two-field credential file", async (t) => {
  const valid = await secretFixture(t);
  const accepted = run(ARGS, { TIANGONG_AGENTLOOP_QUERY_SECRET_FILE: valid.path });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), {
    agentloop_trace_query: "ready",
    credential_boundary: "external-file",
  });
  assertNoCredentialOutput(accepted);

  const broad = await secretFixture(t, 0o640);
  const rejectedBroad = run(ARGS, { TIANGONG_AGENTLOOP_QUERY_SECRET_FILE: broad.path });
  assert.notEqual(rejectedBroad.status, 0);
  assert.match(rejectedBroad.stderr, /code=QUERY_SECRET_FILE_UNSAFE/u);
  assertNoCredentialOutput(rejectedBroad);

  const linked = join(valid.root, "linked.env");
  await symlink(valid.path, linked);
  const rejectedLink = run(ARGS, { TIANGONG_AGENTLOOP_QUERY_SECRET_FILE: linked });
  assert.notEqual(rejectedLink.status, 0);
  assert.match(rejectedLink.stderr, /code=QUERY_SECRET_FILE_UNSAFE/u);
  assertNoCredentialOutput(rejectedLink);

  const unknown = await secretFixture(t, 0o600, [
    `ALIBABA_CLOUD_ACCESS_KEY_ID=${SENTINEL_ID}`,
    `ALIBABA_CLOUD_ACCESS_KEY_SECRET=${SENTINEL_SECRET}`,
    "ALIBABA_CLOUD_REGION=cn-hangzhou",
    "",
  ].join("\n"));
  const rejectedUnknown = run(ARGS, { TIANGONG_AGENTLOOP_QUERY_SECRET_FILE: unknown.path });
  assert.notEqual(rejectedUnknown.status, 0);
  assert.match(rejectedUnknown.stderr, /code=QUERY_SECRET_FILE_INVALID/u);
  assertNoCredentialOutput(rejectedUnknown);
});

test("AgentLoop query smoke emits only bounded correlation facts from the SDK response", async (t) => {
  const secret = await secretFixture(t);
  const fakeRoot = await mkdtemp(join(tmpdir(), "tg-agentloop-query-sdk-"));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));
  const packageRoot = join(fakeRoot, "aliyun");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "__init__.py"), "", { mode: 0o600 });
  await writeFile(join(packageRoot, "log.py"), `
class _Log:
    def __init__(self, contents): self._contents = contents
    def get_contents(self): return self._contents
class _Response:
    def get_logs(self):
        return [
            _Log({"serviceName":"tiangong-agentloop-query-test","spanName":"gateway_start","traceID":"0123456789abcdef0123456789abcdef","attributes":"{\\"deployment.environment\\":\\"isolated-test\\"}","input.value":"raw-content-must-not-print"}),
            _Log({"serviceName":"tiangong-agentloop-query-test","spanName":"invoke_agent main","traceID":"0123456789abcdef0123456789abcdef","attributes":{"tiangong.work.id":"work-test","tiangong.task.id":"task-test"}}),
        ]
class LogClient:
    def __init__(self, endpoint, access_key_id, access_key_secret): pass
    def get_log(self, *args): return _Response()
`, { mode: 0o600 });

  const queryArgs = ARGS.filter((value) => value !== "--validate-only");
  const result = run(queryArgs, {
    TIANGONG_AGENTLOOP_QUERY_SECRET_FILE: secret.path,
    PYTHONPATH: fakeRoot,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    agentloop_trace_query: "pass",
    correlated_spans: 1,
    environment: "isolated-test",
    matching_spans: 2,
    raw_content_emitted: false,
    service: "tiangong-agentloop-query-test",
    span_names: ["gateway_start", "invoke_agent main"],
    trace_count: 1,
    trace_ids: ["0123456789abcdef0123456789abcdef"],
  });
  assert.doesNotMatch(result.stdout, /raw-content-must-not-print/u);
  assertNoCredentialOutput(result);
});

test("AgentLoop query smoke keeps output bounded and does not expose raw records", async () => {
  const [wrapper, python] = await Promise.all([
    readFile(WRAPPER, "utf8"),
    readFile(PYTHON, "utf8"),
  ]);
  assert.match(wrapper, /TIANGONG_AGENTLOOP_QUERY_SECRET_FILE/u);
  assert.match(python, /"raw_content_emitted": False/u);
  assert.match(python, /"logstore-tracing"/u);
  assert.doesNotMatch(python, /print\(secret/u);
  assert.doesNotMatch(python, /print\(contents/u);
});
