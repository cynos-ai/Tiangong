import assert from "node:assert/strict";
import test from "node:test";

import { topLevelToolsForGroups } from "../agent/packages/tool-groups.mjs";
import { assertWorkspaceToolRegistry, workspaceToolLock, workspaceToolNames } from "../agent/packages/workspace-tools.mjs";

test("workspace tool lock is the single bounded allowlist for the pinned OpenClaw", () => {
  assert.equal(workspaceToolLock.groupId, "workspace");
  assert.equal(workspaceToolLock.tools.length, 5);
  assert.deepEqual([...workspaceToolNames], workspaceToolLock.tools);
  assert.equal(assertWorkspaceToolRegistry({ openclawVersion: "2026.4.14", tools: workspaceToolLock.tools }), workspaceToolLock);
  assert.deepEqual(topLevelToolsForGroups(["workspace"]), workspaceToolLock.tools);
  assert.deepEqual(topLevelToolsForGroups(["skill-runtime", "workspace"]).slice(1), workspaceToolLock.tools);
});

test("workspace tool registry fails closed on version drift or missing tools", () => {
  assert.throws(() => assertWorkspaceToolRegistry({ openclawVersion: "2026.4.15", tools: workspaceToolLock.tools }), (error) => error.code === "OPENCLAW_VERSION_MISMATCH");
  assert.throws(() => assertWorkspaceToolRegistry({ openclawVersion: "2026.4.14", tools: workspaceToolLock.tools.filter((name) => name !== "exec") }), (error) => error.code === "OPENCLAW_TOOL_MISSING");
  assert.doesNotThrow(() => assertWorkspaceToolRegistry({ openclawVersion: "2026.4.14", tools: [...workspaceToolLock.tools, "new-upstream-tool"] }));
});
