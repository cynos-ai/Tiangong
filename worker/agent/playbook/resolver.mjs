import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { registryEntry } from "../roles/registry.mjs";
import { findPlaybook } from "./registry.mjs";
import { createProjectBinding, createTaskBinding } from "../team/manifest.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLAYBOOK_ROOT = path.resolve(MODULE_DIR, "../../../team-playbooks");

const PACKAGE_FILES = Object.freeze([
  "PLAYBOOK.md",
  "schemas/project-binding.schema.json",
  "schemas/task-binding.schema.json",
  "schemas/result-envelope.schema.json",
  "schemas/transition-decision.schema.json",
  "transition-policy.mjs",
  "tests/transition-truth-table.json",
]);
const TASK_KIND_ROLE = Object.freeze({ design: "designer", implement: "implementor", assess: "assessor", release: "operator" });
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

function readRegular(pathname, label) {
  const stat = lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return readFileSync(pathname);
}

export function computePlaybookPackageDigest(packageRoot, manifest) {
  const unsignedManifest = structuredClone(manifest);
  delete unsignedManifest.contentDigest;
  const files = {};
  for (const relativePath of PACKAGE_FILES) {
    files[relativePath] = sha256(readRegular(path.join(packageRoot, relativePath), relativePath));
  }
  return {
    contentDigest: sha256(canonicalJson({ manifest: unsignedManifest, files })),
    fileDigests: Object.freeze(files),
  };
}

export function readPlaybookManifest(playbookId, { root = DEFAULT_PLAYBOOK_ROOT } = {}) {
  const entry = findPlaybook(playbookId);
  if (!entry) throw new Error(`Unknown closed playbook: ${playbookId}`);
  const packageRoot = path.join(root, entry.packageDir);
  const manifestPath = path.join(packageRoot, "manifest.json");
  const parsed = JSON.parse(readRegular(manifestPath, "playbook manifest").toString("utf8"));
  const computed = computePlaybookPackageDigest(packageRoot, parsed);
  if (parsed.contentDigest !== computed.contentDigest || entry.contentDigest !== computed.contentDigest) {
    throw new Error(
      `Playbook package digest mismatch for ${playbookId}: registry=${entry.contentDigest} ` +
      `manifest=${parsed.contentDigest} computed=${computed.contentDigest}`,
    );
  }
  for (const field of FIELDS_MIRROR) {
    if (canonicalJson(entry[field]) !== canonicalJson(parsed[field])) {
      throw new Error(`Playbook field '${field}' diverges between registry and manifest for ${playbookId}`);
    }
  }
  return Object.freeze({ ...entry, manifest: Object.freeze(parsed), fileDigests: computed.fileDigests });
}

export function buildProjectBinding({ playbook, projectId, requester, roleBindings, createdAt }) {
  if (!playbook?.contentDigest) throw new Error("buildProjectBinding requires a loaded playbook");
  return createProjectBinding({
    projectId,
    playbookId: playbook.playbookId,
    playbookVersion: playbook.version,
    playbookDigest: playbook.contentDigest,
    requester,
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
  objective,
  completionContractDigest,
  inputRefs,
  createdAt,
}) {
  if (!playbook?.contentDigest) throw new Error("buildTaskBinding requires a loaded playbook");
  const role = registryEntry("roles", TASK_KIND_ROLE[taskKind]);
  const sourceSkillId = role?.skillIds?.[0];
  const sourceSkill = sourceSkillId && registryEntry("skills", sourceSkillId);
  if (!role || !sourceSkill) throw new Error(`No closed professional profile for Task kind: ${taskKind}`);
  return createTaskBinding({
    taskId,
    projectId,
    playbookStepId: `${playbook.transitionPolicyId}:${taskKind}`,
    taskKind,
    revisionIndex,
    assignee,
    objective,
    completionContractDigest,
    sourceProfileDigest: role.profileDigest,
    sourceSkillId: sourceSkill.id,
    sourceSkillDigest: sourceSkill.digest,
    inputRefs,
    createdAt,
  });
}
