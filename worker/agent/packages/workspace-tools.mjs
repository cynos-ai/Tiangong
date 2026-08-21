import { readFileSync } from "node:fs";

const ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}$/u;
const LOCK_FIELDS = new Set(["schemaVersion", "groupId", "openclawVersion", "tools"]);
const lockUrl = new URL("../../openclaw-workspace-tools.json", import.meta.url);

function invalid(message) {
  throw Object.assign(new Error(`OpenClaw workspace tool lock is invalid: ${message}`), { code: "WORKSPACE_TOOL_LOCK_INVALID" });
}

function parseLock() {
  const value = JSON.parse(readFileSync(lockUrl, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !LOCK_FIELDS.has(key)) || Object.keys(value).length !== LOCK_FIELDS.size) invalid("fields");
  if (value.schemaVersion !== 1 || value.groupId !== "workspace" || !VERSION.test(value.openclawVersion ?? "")) invalid("identity");
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 16 || value.tools.some((tool) => typeof tool !== "string" || !ID.test(tool)) || new Set(value.tools).size !== value.tools.length) invalid("tools");
  return Object.freeze({ ...value, tools: Object.freeze([...value.tools]) });
}

export const workspaceToolLock = parseLock();
export const workspaceToolNames = new Set(workspaceToolLock.tools);

export function assertWorkspaceToolRegistry({ openclawVersion, tools } = {}) {
  if (openclawVersion !== workspaceToolLock.openclawVersion) {
    throw Object.assign(new Error(`Pinned OpenClaw version mismatch: expected ${workspaceToolLock.openclawVersion}, got ${openclawVersion ?? "missing"}`), { code: "OPENCLAW_VERSION_MISMATCH" });
  }
  if (!Array.isArray(tools)) invalid("registry");
  const names = tools.map((tool) => typeof tool === "string" ? tool : tool?.name);
  for (const name of workspaceToolLock.tools) {
    if (!names.includes(name)) throw Object.assign(new Error(`Pinned OpenClaw does not register workspace tool ${name}`), { code: "OPENCLAW_TOOL_MISSING" });
  }
  return workspaceToolLock;
}
