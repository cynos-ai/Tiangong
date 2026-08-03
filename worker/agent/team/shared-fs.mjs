import { join, resolve, sep } from "node:path";

// AgentTeams v1.2.0 owns the shared Project/Task namespace. Tiangong stores
// immutable binding and decision artifacts *inside* those upstream records;
// it must not create a competing project/task tree.

const DEFAULT_SHARED_ROOT = "/root/agentteams-fs/shared";
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function defaultSharedRoot(env = process.env) {
  const configured = env.TIANGONG_TEAM_SHARED_ROOT;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_SHARED_ROOT;
}

// Kept as the runtime-facing name: this now resolves to the AgentTeams shared
// root, not a Tiangong-owned Project/Task namespace.
export function defaultTiangongRoot(env = process.env) {
  return defaultSharedRoot(env);
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

export function resolveTeamPath(segments, rootDir = defaultSharedRoot()) {
  validateSegments(segments);
  const root = resolve(rootDir);
  const full = resolve(root, ...segments);
  if (full !== root && !full.startsWith(`${root}${sep}`)) {
    throw new Error("Team path escapes the AgentTeams shared root");
  }
  return full;
}

export function projectDir(projectId, rootDir) {
  return resolveTeamPath(["projects", projectId], rootDir);
}

export function projectBindingFile(projectId, rootDir) {
  return resolveTeamPath(["projects", projectId, "tiangong", "project-binding.json"], rootDir);
}

export function projectMetaFile(projectId, rootDir) {
  return resolveTeamPath(["projects", projectId, "meta.json"], rootDir);
}

export function projectPlanFile(projectId, rootDir) {
  return resolveTeamPath(["projects", projectId, "plan.md"], rootDir);
}

export function projectReportFile(projectId, rootDir) {
  return resolveTeamPath(["projects", projectId, "tiangong", "terminal-report.json"], rootDir);
}

export function taskDir(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId], rootDir);
}

export function tasksRoot(rootDir) {
  return resolveTeamPath(["tasks"], rootDir);
}

export function taskBindingFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "tiangong", "task-binding.json"], rootDir);
}

export function taskDispatchStateFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "tiangong", "dispatch-state.json"], rootDir);
}

export function taskMetaFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "meta.json"], rootDir);
}

export function taskSpecFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "spec.md"], rootDir);
}

export function taskResultMarkdownFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "result.md"], rootDir);
}

export function taskResultFile(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "tiangong", "result-envelope.json"], rootDir);
}

export function taskDecisionsDir(taskId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "tiangong", "decisions"], rootDir);
}

export function taskDecisionFile(taskId, decisionId, rootDir) {
  return resolveTeamPath(["tasks", taskId, "tiangong", "decisions", `${decisionId}.json`], rootDir);
}
