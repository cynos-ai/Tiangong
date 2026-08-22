import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

describe("M9-A0 patched before_model_call wiring", () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    resetEmbeddedAttemptHarness();
    await cleanupTempPaths(tempPaths);
  });

  it("blocks the actual session/provider call when the model gate rejects", async () => {
    const promptCalls: string[] = [];
    const events: string[] = [];
    const hookRunner = {
      hasHooks: (name: string) => {
        events.push(`has:${name}`);
        return name === "before_model_call";
      },
      runBeforeModelCall: vi.fn(async () => {
        events.push("before_model_call");
        return { block: true, blockReason: "BOOTSTRAP_INVALID" };
      }),
    };
    getHoisted().getGlobalHookRunnerMock.mockReturnValue(hookRunner);

    const attemptPromise = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:test:main",
      tempPaths,
      sessionPrompt: async (_session, prompt) => {
        events.push("session_prompt");
        promptCalls.push(prompt);
      },
      attemptOverrides: { disableTools: true, timeoutMs: 250 },
    });
    const result = await Promise.race([
      attemptPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MODEL_GATE_DIAGNOSTIC_TIMEOUT events=${events.join(",")}`)), 15000),
      ),
    ], 30000);

    expect(promptCalls).toEqual([]);
    expect(hookRunner.runBeforeModelCall).toHaveBeenCalledTimes(1);
    expect(result.promptError).toBeInstanceOf(Error);
    expect(String(result.promptError)).toContain("BOOTSTRAP_INVALID");
  });
});
