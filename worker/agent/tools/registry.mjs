import {
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createConstrainedWrite } from "./constrained-write.mjs";
import { summarizeRead, summarizeWrite } from "./operations.mjs";
import { createGatedTool } from "./wrapper.mjs";

export class TiangongToolRegistry {
  #tools = new Map();

  register(tool) {
    if (!tool?.name) throw new TypeError("Tool name is required");
    if (this.#tools.has(tool.name)) throw new Error(`Duplicate Tiangong tool: ${tool.name}`);
    if (tool.executionMode !== "sequential") {
      throw new Error(`Tiangong tool must be sequential: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return tool;
  }

  definitions() {
    return [...this.#tools.values()];
  }

  names() {
    return [...this.#tools.keys()];
  }

  assertSession(session) {
    const active = session.agent.state.tools;
    const expected = this.names();
    if (active.length !== expected.length) throw new Error("Unexpected active pi tool count");
    for (const tool of active) {
      const registered = this.#tools.get(tool.name);
      if (!registered || tool.label !== registered.label || tool.executionMode !== "sequential") {
        throw new Error(`Unwrapped or unexpected pi tool is active: ${tool.name}`);
      }
    }
  }
}

export function createCoreToolRegistry({
  workspaceDir,
  rollbackDir,
  gate,
  evidence,
  idempotencyStore,
  pendingOperationStore,
  getInvocation,
}) {
  const registry = new TiangongToolRegistry();
  const read = createReadToolDefinition(workspaceDir);
  registry.register(createGatedTool({
    definition: { ...read, label: "Tiangong gated read" },
    summarize: (params) => summarizeRead(workspaceDir, params),
    gate,
    evidence,
    getInvocation,
  }));

  const write = createConstrainedWrite({ workspaceDir, rollbackDir });
  registry.register(createGatedTool({
    definition: { ...write.definition, label: "Tiangong gated write" },
    summarize: (params) => summarizeWrite(workspaceDir, params),
    gate,
    evidence,
    idempotencyStore,
    pendingOperationStore,
    getInvocation,
    sideEffect: true,
    lifecycle: write.lifecycle,
    replayResult(result) {
      return {
        content: result.content,
        details: { replayed: true },
      };
    },
  }));
  return registry;
}
