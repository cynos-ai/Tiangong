// The shapes in this adapter are taken from the scripts and references
// actually deployed in the AgentTeams v1.2.0 Manager image. They are not the
// similarly named design-document types. The validated Team room
// is used as project_room_id by the Tiangong Team contingency; Tiangong does
// not claim that it invoked the Manager's create-project.sh side effects.

import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";
import {
  projectMetaFile,
  projectPlanFile,
  taskMetaFile,
  taskResultMarkdownFile,
  taskSpecFile,
} from "./shared-fs.mjs";

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeExclusiveOrVerify(path, content) {
  const handle = await open(path, "wx", 0o600).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error(`AgentTeams record conflicts with the bound operation: ${path}`);
    return null;
  });
  if (!handle) return false;
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function replaceAtomic(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function projectMeta(binding, roomId) {
  return {
    project_id: binding.projectId,
    title: `Tiangong delivery ${binding.projectId}`,
    project_room_id: roomId,
    status: "active",
    workers: Object.entries(binding.roleBindings)
      .filter(([role]) => role !== "team_leader")
      .map(([, worker]) => worker)
      .sort(),
    created_at: binding.createdAt,
    confirmed_at: binding.createdAt,
  };
}

function renderInitialPlan(binding, roomId, matrixDomain) {
  const team = Object.entries(binding.roleBindings)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, worker]) => `- @${worker}:${matrixDomain} — ${role}`)
    .join("\n");
  return `# Project: Tiangong delivery ${binding.projectId}\n\n` +
    `**ID**: ${binding.projectId}\n` +
    `**Status**: active\n` +
    `**Room**: ${roomId}\n` +
    `**Created**: ${binding.createdAt}\n` +
    `**Confirmed**: ${binding.createdAt}\n` +
    `**Tiangong Binding**: shared/projects/${binding.projectId}/tiangong/project-binding.json (${binding.contentDigest})\n\n` +
    `## Team\n\n${team}\n\n` +
    `## Task Plan\n\n` +
    `## Change Log\n\n- ${binding.createdAt}: Project created with immutable Tiangong binding\n`;
}

export async function ensureAgentTeamsProject(binding, { rootDir, roomId, env = process.env }) {
  if (typeof roomId !== "string" || roomId === "") {
    throw new Error("A validated AgentTeams project room is required");
  }
  const matrixDomain = env.AGENTTEAMS_MATRIX_DOMAIN;
  if (typeof matrixDomain !== "string" || matrixDomain === "" || /[/@\s]/u.test(matrixDomain)) {
    throw new Error("A validated AgentTeams Matrix domain is required");
  }
  await writeExclusiveOrVerify(
    projectMetaFile(binding.projectId, rootDir),
    `${canonicalJson(projectMeta(binding, roomId))}\n`,
  );
  await writeExclusiveOrVerify(projectPlanFile(binding.projectId, rootDir), renderInitialPlan(binding, roomId, matrixDomain));
}

function taskMeta(task, project, roomId) {
  return {
    task_id: task.taskId,
    project_id: task.projectId,
    task_title: `${task.taskKind}@${task.revisionIndex}`,
    assigned_to: task.assignee,
    room_id: roomId,
    status: "assigned",
    depends_on: [...task.inputRefs],
    assigned_at: task.createdAt,
  };
}

function taskSpec(task, project) {
  return `# Task: ${task.taskKind}@${task.revisionIndex}\n\n` +
    `**Task ID**: ${task.taskId}\n` +
    `**Project ID**: ${task.projectId}\n` +
    `**Assigned to**: ${task.assignee}\n` +
    `**Objective**: ${task.objective}\n` +
    `**Playbook digest**: ${project.playbookDigest}\n` +
    `**Binding**: shared/tasks/${task.taskId}/tiangong/task-binding.json (${task.contentDigest})\n` +
    `**Completion contract digest**: ${task.completionContractDigest}\n` +
    `**Required profile digest**: ${task.sourceProfileDigest}\n` +
    `**Required Skill**: ${task.sourceSkillId} (${task.sourceSkillDigest})\n\n` +
    `Resolve the immutable binding, perform only the assigned professional task, and submit a digest-verified ResultEnvelope.\n`;
}

async function appendTaskToPlan(task, rootDir) {
  const path = projectPlanFile(task.projectId, rootDir);
  await withFileLock(path, async () => {
    const current = await readFile(path, "utf8");
    const marker = `- [~] ${task.taskId} — ${task.taskKind}@${task.revisionIndex}`;
    if (current.includes(`${marker} `)) return;
    const insertion = `${marker} (assigned: ${task.assignee})\n` +
      `  - Spec: /root/agentteams-fs/shared/tasks/${task.taskId}/spec.md\n` +
      `  - Result: /root/agentteams-fs/shared/tasks/${task.taskId}/result.md\n`;
    const anchor = "## Change Log\n";
    if (!current.includes(anchor)) throw new Error("AgentTeams project plan is missing its Change Log anchor");
    await replaceAtomic(path, current.replace(anchor, `${insertion}\n${anchor}`));
  });
}

export async function ensureAgentTeamsTask(task, project, { rootDir, roomId }) {
  if (typeof roomId !== "string" || roomId === "") {
    throw new Error("A validated AgentTeams task room is required");
  }
  await writeExclusiveOrVerify(taskMetaFile(task.taskId, rootDir), `${canonicalJson(taskMeta(task, project, roomId))}\n`);
  await writeExclusiveOrVerify(taskSpecFile(task.taskId, rootDir), taskSpec(task, project));
  await appendTaskToPlan(task, rootDir);
}

async function updateTaskStatus(taskId, status, rootDir) {
  const path = taskMetaFile(taskId, rootDir);
  await withFileLock(path, async () => {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed.status === status) return;
    if (parsed.status !== "assigned") {
      throw new Error(`AgentTeams task ${taskId} is already terminal (${parsed.status})`);
    }
    parsed.status = status;
    await replaceAtomic(path, `${canonicalJson(parsed)}\n`);
  });
}

export async function ensureAgentTeamsResult(result, { rootDir }) {
  const outcome = result.blocker ? "BLOCKED" : result.revisionRequest ? "REVISION_NEEDED" : "SUCCESS";
  const summary = result.blocker ?? result.claim;
  const markdown = `# Task Result: ${result.taskKind}@${result.revisionIndex}\n\n` +
    `**Task ID**: ${result.taskId}\n` +
    `**Completed**: ${result.createdAt}\n\n` +
    `## Outcome\n\n**Status**: ${outcome}\n\n` +
    `## Summary\n\n${summary}\n\n` +
    `## Tiangong ResultEnvelope\n\n` +
    `Path: shared/tasks/${result.taskId}/tiangong/result-envelope.json\n\n` +
    `Digest: ${result.contentDigest}\n\n` +
    `## Deliverables\n\n${[...result.artifactRefs, ...result.evidenceRefs].map((ref) => `- ${ref}`).join("\n") || "(none)"}\n\n` +
    `## Notes\n\nTiangong binding and Evidence are supplemental to this AgentTeams result.\n`;
  await writeExclusiveOrVerify(taskResultMarkdownFile(result.taskId, rootDir), markdown);
}

async function updatePlanDecision(task, decision, rootDir) {
  const path = projectPlanFile(task.projectId, rootDir);
  await withFileLock(path, async () => {
    const current = await readFile(path, "utf8");
    const prefix = `- [~] ${task.taskId} —`;
    const replacement = decision.decision === "accept" ? `- [x] ${task.taskId} —`
      : decision.decision === "revision" ? `- [→] ${task.taskId} —`
        : `- [!] ${task.taskId} —`;
    if (current.includes(replacement)) return;
    if (!current.includes(prefix)) throw new Error(`AgentTeams plan has no active task ${task.taskId}`);
    await replaceAtomic(path, current.replace(prefix, replacement));
  });
}

export async function applyAgentTeamsDecision(task, decision, { rootDir }) {
  const status = decision.decision === "accept" ? "completed"
    : decision.decision === "blocked" ? "blocked" : null;
  if (status) await updateTaskStatus(task.taskId, status, rootDir);
  await updatePlanDecision(task, decision, rootDir);
}
