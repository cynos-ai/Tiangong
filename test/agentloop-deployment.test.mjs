import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateAgentLoopSecretFile } from "../scripts/validate-agentloop-secret-file.mjs";

const VALID = [
  "AGENTLOOP_ENDPOINT=https://proj-xtrace-test.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry",
  "AGENTLOOP_LICENSE_KEY=synthetic-not-a-real-license-key",
  "AGENTLOOP_PROJECT=proj-xtrace-test-cn-hangzhou",
  "AGENTLOOP_WORKSPACE=default-cms-test-cn-hangzhou",
  "",
].join("\n");

async function fixture(t, content = VALID, mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), "tg-agentloop-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "agentloop.env");
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return { root, path };
}

test("AgentLoop deployment secret accepts only a private exact Alibaba Cloud OTLP base", async (t) => {
  const { path } = await fixture(t);
  assert.deepEqual(await validateAgentLoopSecretFile(path), {
    endpoint: "https://proj-xtrace-test.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry",
    fieldCount: 4,
  });
});

test("AgentLoop deployment secret rejects broad permissions, links, unknown fields, and unsafe endpoints", async (t) => {
  const broad = await fixture(t, VALID, 0o640);
  await assert.rejects(validateAgentLoopSecretFile(broad.path), /UNSAFE/u);

  const target = await fixture(t);
  const link = join(target.root, "linked.env");
  await symlink(target.path, link);
  await assert.rejects(validateAgentLoopSecretFile(link), /UNSAFE/u);

  for (const replacement of [
    "AGENTLOOP_EXTRA=value",
    "AGENTLOOP_ENDPOINT=http://proj-xtrace-test.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry",
    "AGENTLOOP_ENDPOINT=https://evil.example/apm/trace/opentelemetry",
    "AGENTLOOP_ENDPOINT=https://proj-xtrace-test.cn-hangzhou.log.aliyuncs.com/other/apm/trace/opentelemetry",
  ]) {
    const changed = VALID.replace(/^AGENTLOOP_ENDPOINT=.*$/mu, replacement);
    const item = await fixture(t, changed);
    await assert.rejects(validateAgentLoopSecretFile(item.path));
  }
});

test("AgentLoop collector and Worker contracts keep credentials outside the Worker", async () => {
  const [collector, wrapper] = await Promise.all([
    readFile(new URL("../deploy/agentloop/collector.yaml", import.meta.url), "utf8"),
    readFile(new URL("../worker/bin/openclaw", import.meta.url), "utf8"),
  ]);
  assert.match(collector, /protocols:\n      http:/u);
  assert.match(collector, /x-arms-license-key: \$\{env:AGENTLOOP_LICENSE_KEY\}/u);
  assert.doesNotMatch(collector, /grpc:/u);
  assert.match(wrapper, /http:\/\/tiangong-agentloop-collector:4318/u);
  assert.match(wrapper, /credentials and exporter overrides belong in the collector/u);
  assert.doesNotMatch(wrapper, /x-arms-license-key/u);
});
