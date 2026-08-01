import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson } from "../canonical-json.mjs";
import {
  isProjectBinding,
  isTaskBinding,
  verifyBindingDigest,
} from "./manifest.mjs";
import {
  projectBindingFile,
  taskBindingFile,
  projectDir,
  taskDir,
} from "./shared-fs.mjs";

// Immutable, digest-verified storage for Tiangong Project/Task binding
// manifests on the AgentTeams shared filesystem.
//
// Write uses an exclusive ("wx") create: a manifest path is written exactly
// once. Re-dispatch, re-accept, or replay must reuse the saved manifest
// rather than overwrite it. Read always re-verifies the content digest so a
// tampered manifest fails closed.

function assertValidBinding(binding, kind) {
  const isKind = kind === "project" ? isProjectBinding : isTaskBinding;
  if (!isKind(binding)) {
    throw new Error(`Expected a Tiangong ${kind} binding manifest`);
  }
  if (!verifyBindingDigest(binding)) {
    throw new Error(`${kind} binding manifest content digest is invalid`);
  }
}

async function writeImmutable(filePath, binding) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(canonicalJson(binding), { mode: 0o600 });
  } finally {
    await handle.close();
  }
}

async function readVerified(filePath, kind) {
  let bytes;
  try {
    bytes = await readFile(filePath, { encoding: "utf8" });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No ${kind} binding manifest at ${filePath}`);
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`${kind} binding manifest at ${filePath} is not valid JSON`);
  }
  if (!verifyBindingDigest(parsed)) {
    throw new Error(`${kind} binding manifest at ${filePath} failed digest verification`);
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
  return readVerified(projectBindingFile(projectId, rootDir), "project");
}

export async function writeTaskBinding(binding, { rootDir } = {}) {
  assertValidBinding(binding, "task");
  const filePath = taskBindingFile(binding.taskId, rootDir);
  await writeImmutable(filePath, binding);
  return filePath;
}

export async function readTaskBinding(taskId, { rootDir } = {}) {
  return readVerified(taskBindingFile(taskId, rootDir), "task");
}

export async function removeProjectTree(projectId, { rootDir } = {}) {
  await rm(projectDir(projectId, rootDir), { recursive: true, force: true });
}

export async function removeTaskTree(taskId, { rootDir } = {}) {
  await rm(taskDir(taskId, rootDir), { recursive: true, force: true });
}
