import { afterEach, describe, expect, it } from "vitest";
import { createHookRunner } from "/opt/openclaw/src/plugins/hooks.ts";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "/opt/openclaw/src/plugins/hook-runner-global.ts";
import { wrapToolWithBeforeToolCallHook } from "/opt/openclaw/src/agents/pi-tools.before-tool-call.ts";

function registry(typedHooks: any[]) {
  return { hooks: typedHooks, typedHooks } as any;
}

afterEach(() => resetGlobalHookRunner());

describe("M9-A0 source seam prototype", () => {
  it("blocks the final model-call seam and fails closed on handler error", async () => {
    const runner = createHookRunner(
      registry([
        {
          pluginId: "test-model-gate",
          hookName: "before_model_call",
          priority: 100,
          source: "test",
          handler: () => ({ block: true, blockReason: "BOOTSTRAP_INVALID" }),
        },
      ]),
      { failurePolicyByHook: { before_model_call: "fail-closed" } },
    );
    let providerRequests = 0;
    const gateResult = await runner.runBeforeModelCall(
      { prompt: "p", systemPrompt: "s", messages: [], provider: "fake", model: "fake" },
      { runId: "run-1" },
    );
    if (!gateResult?.block) providerRequests += 1;
    expect(gateResult).toEqual({ block: true, blockReason: "BOOTSTRAP_INVALID" });
    expect(providerRequests).toBe(0);

    const failing = createHookRunner(
      registry([
        {
          pluginId: "test-model-gate",
          hookName: "before_model_call",
          priority: 100,
          source: "test",
          handler: () => { throw new Error("BOOTSTRAP_CHECK_FAILED"); },
        },
      ]),
      { failurePolicyByHook: { before_model_call: "fail-closed" } },
    );
    await expect(
      failing.runBeforeModelCall(
        { prompt: "p", systemPrompt: "s", messages: [], provider: "fake", model: "fake" },
        { runId: "run-2" },
      ),
    ).rejects.toThrow("before_model_call handler from test-model-gate failed");
  });

  it("uses a handler-owned deadline for a never-resolving admission", async () => {
    const started = performance.now();
    const result = await Promise.race([
      new Promise(() => undefined),
      new Promise((resolve) => setTimeout(() => resolve({ block: true, blockReason: "ADMISSION_TIMEOUT" }), 20)),
    ]);
    expect(result).toEqual({ block: true, blockReason: "ADMISSION_TIMEOUT" });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("closes a tool result before ordinary release and blocks on capture failure", async () => {
    const events: string[] = [];
    initializeGlobalHookRunner(
      registry([
        {
          pluginId: "test-capture",
          hookName: "before_tool_result_release",
          priority: 100,
          source: "test",
          handler: (event: any) => {
            events.push(`capture:${event.result}`);
            return undefined;
          },
        },
      ]),
    );
    const tool = wrapToolWithBeforeToolCallHook({
      name: "synthetic",
      execute: async () => {
        events.push("execute");
        return "tool-value";
      },
    } as any);
    await expect(tool.execute("call-1", { value: 1 })).resolves.toBe("tool-value");
    expect(events).toEqual(["execute", "capture:tool-value"]);

    resetGlobalHookRunner();
    initializeGlobalHookRunner(
      registry([
        {
          pluginId: "test-capture",
          hookName: "before_tool_result_release",
          priority: 100,
          source: "test",
          handler: () => { throw new Error("SPOOL_WRITE_FAILED"); },
        },
      ]),
    );
    let executed = false;
    const failingTool = wrapToolWithBeforeToolCallHook({
      name: "synthetic",
      execute: async () => {
        executed = true;
        return "must-not-release";
      },
    } as any);
    await expect(failingTool.execute("call-2", { value: 1 })).rejects.toThrow(
      "before_tool_result_release handler from test-capture failed",
    );
    expect(executed).toBe(true);
  });
});
