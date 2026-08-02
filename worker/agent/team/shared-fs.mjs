import { join, resolve, sep } from "node:path";

// Path-safe resolution for Tiangong-owned team-coordination files under the
// AgentTeams v1.2.0 shared filesystem. AgentTeams coordinates teams through
// shared files + Matrix @mentions + MinIO sync; TeamTaskPort writes its
// immutable manifests beneath a Tiangong-owned namespace there.
//
// Segment validation (no "..", "/", NUL, or odd characters) plus a resolved
// prefix check prevent workspace escape through worker-controlled names.

const DEFAULT_SHARED_ROOT = "/root/agentteams-fs/shared";
export const TIANGONG_NAMESPACE = "tiangong";
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function defaultSharedRoot(env = process.env) {
  const configured = env.TIANGONG_TEAM_SHARED_ROOT;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_SHARED_ROOT;
}

export function defaultTiangongRoot(env = process.env) {
  return join(defaultSharedRoot(env), TIANGONG_NAMESPACE);
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new TypeError("team path segments are required");
  }
  for (const segment of segments) {
    if (typeof segment !== "string" || !SEGMENT_PATTERN.test(segment)) {
      throw new Error(`Invalid team path segment: ${String(segment)}`);
    }
  }
}

export function resolveTeamPath(segments, rootDir = defaultTiangongRoot()) {
  validateSegments(segments);
  const root = resolve(rootDir);
  const full = resolve(root, ...segments);
  if (full !== root && !full.startsWith(`${root}${sep}`)) {
    throw new Error("Team path escapes the Tiangong shared root");
  }
  return full;
}

export function projectDir(projectId, rootDir) {
  return resolveTeamPath(["projects", projectId], rootDir);
}

export function projectBindingFile(projectId, rootDir) {
  return resolveTeamPath(["projects", projectId, "project-binding.json"], rootDir);
}

export function taskDir(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId], rootDir);
}

export function tasksRoot(rootDir) {
  return resolveTeamPath(["tasks"], rootDir);
}

export function taskBindingFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "task-binding.json"], rootDir);
}

export function taskResultFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "result.json"], rootDir);
}

export function taskDecisionsDir(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "decisions"], rootDir);
}

export function taskDecisionFile(taskId, decisionId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "decisions", `${decisionId}.json`], rootDir);
}
