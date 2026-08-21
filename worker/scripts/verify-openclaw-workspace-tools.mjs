import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenClawCodingTools, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness";
import { assertWorkspaceToolRegistry, workspaceToolLock } from "../agent/packages/workspace-tools.mjs";

const root = await mkdtemp(join(tmpdir(), "tiangong-openclaw-tools-"));
const outside = `${root}-outside.txt`;
try {
  await writeFile(join(root, "input.txt"), "before\n", { mode: 0o600 });
  await writeFile(outside, "outside\n", { mode: 0o600 });
  const registered = createOpenClawCodingTools({
    workspaceDir: root,
    config: { tools: { fs: { workspaceOnly: true } } },
    exec: { host: "gateway", security: "full", ask: "off" },
  });
  assertWorkspaceToolRegistry({ openclawVersion: OPENCLAW_VERSION, tools: registered });
  const tool = (name) => registered.find((entry) => entry.name === name);

  const readResult = await tool("read").execute("read-probe", { path: "input.txt" });
  assert.match(readResult.content[0].text, /before/u);
  await tool("write").execute("write-probe", { path: "written.txt", content: "written\n" });
  await tool("edit").execute("edit-probe", { path: "input.txt", edits: [{ oldText: "before", newText: "after" }] });
  const execResult = await tool("exec").execute("exec-probe", { command: "test \"$(cat input.txt)\" = after && printf exec-ok", workdir: root });
  assert.match(execResult.content[0].text, /exec-ok/u);
  const processResult = await tool("process").execute("process-probe", { action: "list" });
  assert.ok(Array.isArray(processResult.content));
  assert.equal(await readFile(join(root, "input.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(root, "written.txt"), "utf8"), "written\n");
  await assert.rejects(() => tool("read").execute("escape-probe", { path: outside }));
  assert.equal(await readFile(outside, "utf8"), "outside\n");

  process.stdout.write(`openclaw_workspace_tools=pass version=${workspaceToolLock.openclawVersion} tools=${workspaceToolLock.tools.join(",")} workspace_only=pass\n`);
} finally {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { force: true })]);
}
