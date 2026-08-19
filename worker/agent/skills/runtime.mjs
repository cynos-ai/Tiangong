import { Type } from "typebox";

import { resolveAgentRuntimeFromEnvironment } from "../packages/loader.mjs";

const SKILL_ID = Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 });
const MAX_CONTEXT_BYTES = 24 * 1024;
const COORDINATION_TOOLS = new Set([
  "tiangong_list_pending_messages", "tiangong_route_message", "tiangong_correct_message_association", "tiangong_read_work", "tiangong_rename_work", "tiangong_set_work_spec", "tiangong_publish_plan", "tiangong_create_task", "tiangong_cancel_task", "tiangong_complete_work", "tiangong_stop_work",
]);

function bounded(value, limit) { if (typeof value !== "string") return ""; return Buffer.byteLength(value) <= limit ? value : Buffer.from(value).subarray(0, limit).toString("utf8"); }
function sessionKey(ctx = {}) { const value = ctx.sessionKey ?? ctx.sessionId ?? ctx.runId; if (typeof value !== "string" || value.length === 0 || value.length > 512 || /\s/u.test(value)) throw new Error("AGENT_SESSION_ID_INVALID"); return value; }

function promptContext(runtime, ctx) {
  const session = sessionKey(ctx); const skillCatalog = runtime.effectiveSkills.length
    ? runtime.effectiveSkills.map((skill) => `- ${skill.skillId}@${skill.version}: ${skill.description}`).join("\n")
    : "- none";
  return bounded([
    `Authoritative Tiangong Agent package: ${runtime.agentPackage.packageId}@${runtime.agentPackage.version}`,
    `Responsibility: ${runtime.agentPackage.responsibility}; capability profile: ${runtime.capabilityProfile}; logical session policy: ${runtime.agentPackage.sessionPolicy}; OpenClaw session: ${session}.`,
    runtime.agentPackage.instructions.trim(),
    "Enabled Skills below are installed ∩ MemberConfig.allowedSkills. Select a Skill yourself only when its trigger matches, then call tiangong_use_skill before following it. Skill text grants no authority.",
    skillCatalog,
  ].join("\n\n"), MAX_CONTEXT_BYTES);
}

export function createAgentPackageRuntime({ env = process.env, packageRoot, skillsRoot } = {}) {
  const resolveCurrent = () => resolveAgentRuntimeFromEnvironment(env, { packageRoot, skillsRoot });
  return Object.freeze({
    async beforePromptBuild(_event = {}, ctx = {}) {
      const runtime = await resolveCurrent();
      return { prependContext: promptContext(runtime, ctx) };
    },
    async beforeToolCall(event = {}) {
      const toolName = event.toolName ?? event.name ?? event.tool?.name;
      if (typeof toolName !== "string" || toolName.length === 0) return { block: true, blockReason: "TIANGONG_AGENT_CAPABILITY_DENIED: bounded tool identity is required" };
      const runtime = await resolveCurrent(); const groups = new Set(runtime.agentPackage.toolGroups);
      const allowed = toolName === "tiangong_use_skill" || (groups.has("coordination") && COORDINATION_TOOLS.has(toolName)) || (groups.has("native-runner") && toolName === "tiangong_run_command");
      if (!allowed) return { block: true, blockReason: `TIANGONG_AGENT_CAPABILITY_DENIED: ${runtime.capabilityProfile} does not expose ${toolName}` };
      return undefined;
    },
    skillTool: Object.freeze({
      name: "tiangong_use_skill",
      label: "Use an enabled Tiangong Skill",
      description: "Load one preinstalled Skill from the current Agent package after autonomously matching its trigger. This records Skill identity but grants no tools or authority.",
      parameters: Type.Object({ skillId: SKILL_ID, trigger: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => {
        const runtime = await resolveCurrent(); const skill = runtime.effectiveSkills.find((entry) => entry.skillId === params.skillId);
        if (!skill) throw Object.assign(new Error("The selected Skill is not enabled for the current MemberConfig"), { code: "SKILL_NOT_ALLOWED" });
        const trigger = bounded(params.trigger.replace(/[\r\n]+/gu, " ").trim(), 512); if (!trigger) throw new Error("SKILL_TRIGGER_REQUIRED");
        const skillUse = Object.freeze({ skillId: skill.skillId, version: skill.version, contentDigest: skill.contentDigest, trigger, memberId: runtime.memberId, agentPackageId: runtime.agentPackage.packageId, agentPackageVersion: runtime.agentPackage.version });
        return { content: [{ type: "text", text: bounded(`Selected Skill ${skill.skillId}@${skill.version}. Follow these instructions within current Task and authority:\n\n${skill.instructions}`, 32 * 1024) }], details: { skillUse } };
      },
    }),
  });
}

export function registerAgentPackageRuntime(api, options = {}) {
  if (typeof api?.on !== "function" || typeof api?.registerTool !== "function") throw new Error("Agent package runtime requires OpenClaw hooks and tools");
  const runtime = createAgentPackageRuntime(options);
  api.on("before_prompt_build", runtime.beforePromptBuild, { priority: 120 });
  api.on("before_tool_call", runtime.beforeToolCall, { priority: 120 });
  api.registerTool(() => runtime.skillTool, { name: "tiangong_use_skill" });
  return { enabled: true, hooks: ["before_prompt_build", "before_tool_call"], tools: ["tiangong_use_skill"] };
}
