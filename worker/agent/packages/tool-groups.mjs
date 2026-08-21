import { workspaceToolLock } from "./workspace-tools.mjs";

export const coordinationToolNames = Object.freeze([
  "tiangong_list_pending_messages",
  "tiangong_route_message",
  "tiangong_correct_message_association",
  "tiangong_read_work",
  "tiangong_rename_work",
  "tiangong_set_work_spec",
  "tiangong_publish_plan",
  "tiangong_create_task",
  "tiangong_cancel_task",
  "tiangong_complete_work",
  "tiangong_stop_work",
]);

const GROUP_TOOLS = Object.freeze({
  "skill-runtime": Object.freeze(["tiangong_use_skill"]),
  coordination: coordinationToolNames,
  workspace: workspaceToolLock.tools,
});

export function topLevelToolsForGroups(groups) {
  if (!Array.isArray(groups)) throw new TypeError("Agent package toolGroups are required");
  const result = [];
  for (const group of groups) {
    const tools = GROUP_TOOLS[group];
    if (!tools) throw Object.assign(new Error(`Unknown Agent package tool group: ${group}`), { code: "AGENT_TOOL_GROUP_INVALID" });
    for (const tool of tools) if (!result.includes(tool)) result.push(tool);
  }
  return Object.freeze(result);
}
