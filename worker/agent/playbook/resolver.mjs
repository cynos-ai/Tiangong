// Closed TeamPlaybook resolver (architecture §7 / §17 gate 5).
//
// loadPlaybook reads the package manifest.json from disk and verifies its
// canonical digest against the deep-frozen closed registry, so a tampered or
// substituted manifest is rejected. buildProjectBinding / buildTaskBinding
// produce the immutable Tiangong binding manifests carrying the verified
// playbook digest, delegating the record shape to team/manifest.mjs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { findPlaybook } from "./registry.mjs";
import { createProjectBinding, createTaskBinding } from "../team/manifest.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLAYBOOK_ROOT = path.resolve(MODULE_DIR, "../../../team-playbooks");

const FIELDS_MIRROR = [
  "playbookId",
  "version",
  "roleSlots",
  "taskKinds",
  "taskKindRoles",
  "maxRevisionWaves",
  "completionSchemaId",
  "transitionPolicyId",
];

export function readPlaybookManifest(playbookId, { root = DEFAULT_PLAYBOOK_ROOT } = {}) {
  const entry = findPlaybook(playbookId);
  if (!entry) {
    throw new Error(`Unknown closed playbook: ${playbookId}`);
  }
  const manifestPath = path.join(root, entry.packageDir, "manifest.json");
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  const digest = sha256(canonicalJson(parsed));
  if (digest !== entry.contentDigest) {
    throw new Error(
      `Playbook manifest digest mismatch for ${playbookId}: registry=${entry.contentDigest} on-disk=${digest}`,
    );
  }
  for (const field of FIELDS_MIRROR) {
    const regValue = JSON.stringify(entry[field]);
    const fileValue = JSON.stringify(parsed[field]);
    if (regValue !== fileValue) {
      throw new Error(
        `Playbook field '${field}' diverges between registry and manifest for ${playbookId}`,
      );
    }
  }
  return Object.freeze({ ...entry, manifest: Object.freeze(parsed) });
}

export function buildProjectBinding({ playbook, projectId, roleBindings, createdAt }) {
  if (!playbook?.contentDigest) throw new Error("buildProjectBinding requires a loaded playbook");
  return createProjectBinding({
    projectId,
    playbookId: playbook.playbookId,
    playbookVersion: playbook.version,
    playbookDigest: playbook.contentDigest,
    roleBindings,
    createdAt,
  });
}

export function buildTaskBinding({
  playbook,
  taskId,
  projectId,
  taskKind,
  revisionIndex,
  assignee,
  completionContractDigest,
  inputRefs,
  createdAt,
}) {
  if (!playbook?.contentDigest) throw new Error("buildTaskBinding requires a loaded playbook");
  const stepId = playbook.transitionPolicyId;
  return createTaskBinding({
    taskId,
    projectId,
    playbookStepId: `${stepId}:${taskKind}`,
    taskKind,
    revisionIndex,
    assignee,
    completionContractDigest,
    inputRefs,
    createdAt,
  });
}
