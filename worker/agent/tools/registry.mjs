import { createReadToolDefinition } from "./openclaw-tool-definitions.mjs";

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

}

export function createCoreToolRegistry({
  workspaceDir,
  rollbackDir,
  gate,
  evidence,
  idempotencyStore,
  pendingOperationStore,
  getInvocation,
  profile,
}) {
  if (profile?.roleId !== "kernel" || profile.gatePolicyId !== "workspace-tools-v1" ||
      profile.toolIds?.length !== 2 || profile.toolIds[0] !== "read" || profile.toolIds[1] !== "write") {
    throw new Error("The core tool registry requires the fixed kernel role profile");
  }
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
