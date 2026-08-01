import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson } from "../canonical-json.mjs";
import { isProjectBinding, isTaskBinding, verifyContentDigest } from "./manifest.mjs";
import {
  projectBindingFile,
  taskBindingFile,
  projectDir,
  taskDir,
  taskResultFile,
  taskDecisionsDir,
  taskDecisionFile,
} from "./shared-fs.mjs";

// Immutable, digest-verified storage for Tiangong team manifests on the
// AgentTeams shared filesystem.
//
// Write uses an exclusive ("wx") create: a manifest path is written exactly
// once. Re-dispatch, re-accept, replay, or a second submission must reuse the
// saved record rather than overwrite it. Read always re-verifies the content
// digest so a tampered record fails closed.

function assertValidBinding(binding, kind) {
  const isKind = kind === "project" ? isProjectBinding : isTaskBinding;
  if (!isKind(binding)) {
    throw new Error(`Expected a Tiangong ${kind} binding manifest`);
  }
  if (!verifyContentDigest(binding)) {
    throw new Error(`${kind} binding manifest content digest is invalid`);
  }
}

function assertValidRecord(record, label) {
  if (!verifyContentDigest(record)) {
    throw new Error(`${label} content digest is invalid`);
  }
}

async function writeImmutable(filePath, record) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(canonicalJson(record), { mode: 0o600 });
  } finally {
    await handle.close();
  }
}

async function readVerified(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath, { encoding: "utf8" });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No ${label} manifest at ${filePath}`);
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`${label} manifest at ${filePath} is not valid JSON`);
  }
  if (!verifyContentDigest(parsed)) {
    throw new Error(`${label} manifest at ${filePath} failed digest verification`);
  }
  return parsed;
}

export async function writeProjectBinding(binding, { rootDir } = {}) {
  assertValidBinding(binding, "project");
  const filePath = projectBindingFile(binding.projectId, rootDir);
  await writeImmutable(filePath, binding);
  return filePath;
}

export async function readProjectBinding(projectId, { rootDir } = {}) {
  return readVerified(projectBindingFile(projectId, rootDir), "project binding");
}

export async function writeTaskBinding(binding, { rootDir } = {}) {
  assertValidBinding(binding, "task");
  const filePath = taskBindingFile(binding.taskId, rootDir);
  await writeImmutable(filePath, binding);
  return filePath;
}

export async function readTaskBinding(taskId, { rootDir } = {}) {
  return readVerified(taskBindingFile(taskId, rootDir), "task binding");
}

export async function writeTaskResult(result, { rootDir } = {}) {
  assertValidRecord(result, "task result");
  const filePath = taskResultFile(result.taskId, rootDir);
  await writeImmutable(filePath, result);
  return filePath;
}

export async function readTaskResult(taskId, { rootDir } = {}) {
  return readVerified(taskResultFile(taskId, rootDir), "task result");
}

export async function appendTaskDecision(decision, { rootDir } = {}) {
  assertValidRecord(decision, "task decision");
  const filePath = taskDecisionFile(decision.taskId, decision.decisionId, rootDir);
  await writeImmutable(filePath, decision);
  return filePath;
}

export async function readTaskDecisions(taskId, { rootDir } = {}) {
  const dir = taskDecisionsDir(taskId, rootDir);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const decisions = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) continue;
    decisions.push(await readVerified(join(dir, name), "task decision"));
  }
  return decisions;
}

export async function removeProjectTree(projectId, { rootDir } = {}) {
  await rm(projectDir(projectId, rootDir), { recursive: true, force: true });
}

export async function removeTaskTree(taskId, { rootDir } = {}) {
  await rm(taskDir(taskId, rootDir), { recursive: true, force: true });
}
