import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { sha256 } from "../canonical-json.mjs";
import { closedRoleRegistries, registryEntry } from "../roles/registry.mjs";

export const FIXED_PROFILE_PATH = "/opt/tiangong-worker/profile.json";
export const FIXED_RESOURCE_ROOT = "/opt/tiangong-worker";

const PROFILE_KEYS_V1 = [
  "gatePolicyId",
  "practiceIds",
  "roleId",
  "roleSkillId",
  "schemaVersion",
  "title",
  "toolIds",
];
const PROFILE_KEYS_V2 = [...PROFILE_KEYS_V1, "targetKindIds"];
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TITLE_PATTERN = /^[\x20-\x7e]{1,80}$/u;
const MAX_PROFILE_BYTES = 8 * 1024;
const MAX_LIST_ITEMS = 32;
const FORBIDDEN_REVIEWER_TOOLS = new Set(["write", "edit", "bash"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class RoleProfileError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "RoleProfileError";
    this.code = "TIANGONG_ROLE_PROFILE_INVALID";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new RoleProfileError(reasonCode, message);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertExactKeys(value, expected, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PROFILE_SCHEMA_MISMATCH", `${kind} must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (!sameArray(keys, [...expected].sort())) {
    fail("PROFILE_SCHEMA_MISMATCH", `${kind} has missing or unknown fields`);
  }
}

function assertId(value, field) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("PROFILE_SCHEMA_MISMATCH", `${field} must be a bounded ASCII identifier`);
  }
}

function assertIdList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    fail("PROFILE_SCHEMA_MISMATCH", `${field} must be a non-empty bounded array`);
  }
  const seen = new Set();
  for (const id of value) {
    assertId(id, field);
    if (seen.has(id)) fail("PROFILE_DUPLICATE_ID", `${field} contains a duplicate identifier`);
    seen.add(id);
  }
}

async function assertNoSymlinkTraversal(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    fail("RESOURCE_PATH_INVALID", "Role resource path escapes its fixed root");
  }
  let current = normalizedRoot;
  for (const segment of pathFromRoot.split(sep)) {
    if (segment === "") continue;
    current = join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") fail("RESOURCE_MISSING", "Required role resource is missing");
      throw error;
    }
    if (stat.isSymbolicLink()) fail("RESOURCE_SYMLINK", "Role resources cannot be symbolic links");
  }
}

async function readTrustedFile(filePath, { maxBytes, expectedDigest, root, kind }) {
  if (root) await assertNoSymlinkTraversal(root, filePath);
  else {
    let stat;
    try {
      stat = await lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") fail("RESOURCE_MISSING", `Required ${kind} is missing`);
      throw error;
    }
    if (stat.isSymbolicLink()) fail("RESOURCE_SYMLINK", `${kind} cannot be a symbolic link`);
  }

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) fail("RESOURCE_NOT_REGULAR_FILE", `${kind} must be a regular file`);
    if (stat.size === 0 || stat.size > maxBytes) fail("RESOURCE_SIZE_INVALID", `${kind} size is invalid`);
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) fail("RESOURCE_CHANGED", `${kind} changed while loading`);
    const digest = sha256(bytes);
    if (expectedDigest && digest !== expectedDigest) {
      fail("RESOURCE_DIGEST_MISMATCH", `${kind} digest does not match the closed registry`);
    }
    let text;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch {
      fail("RESOURCE_UTF8_INVALID", `${kind} must be valid UTF-8 text`);
    }
    return { text, digest, bytes: bytes.byteLength };
  } catch (error) {
    if (error?.code === "ELOOP") fail("RESOURCE_SYMLINK", `${kind} cannot be a symbolic link`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateProfile(profile, profileDigest) {
  const expectedKeys = profile?.schemaVersion === 2 ? PROFILE_KEYS_V2 : PROFILE_KEYS_V1;
  assertExactKeys(profile, expectedKeys, "Role profile");
  if (![1, 2].includes(profile.schemaVersion) ||
      (profile.roleId === "reviewer" ? profile.schemaVersion !== 2 : profile.schemaVersion !== 1)) {
    fail("PROFILE_VERSION_UNSUPPORTED", "Unsupported role profile version");
  }
  assertId(profile.roleId, "roleId");
  if (typeof profile.title !== "string" || !TITLE_PATTERN.test(profile.title)) {
    fail("PROFILE_SCHEMA_MISMATCH", "title must be bounded printable ASCII");
  }
  assertIdList(profile.practiceIds, "practiceIds");
  assertIdList(profile.toolIds, "toolIds");
  if (profile.schemaVersion === 2) assertIdList(profile.targetKindIds, "targetKindIds");
  assertId(profile.gatePolicyId, "gatePolicyId");
  assertId(profile.roleSkillId, "roleSkillId");

  const role = registryEntry("roles", profile.roleId);
  if (!role) fail("PROFILE_ID_UNKNOWN", "roleId is not in the closed registry");
  if (profileDigest !== role.profileDigest) {
    fail("PROFILE_DIGEST_MISMATCH", "Role profile digest does not match the closed registry");
  }
  for (const field of ["title", "gatePolicyId", "roleSkillId"]) {
    if (profile[field] !== role[field]) fail("PROFILE_ROLE_CONFLICT", `${field} conflicts with role policy`);
  }
  for (const field of profile.schemaVersion === 2 ? ["practiceIds", "targetKindIds", "toolIds"] : ["practiceIds", "toolIds"]) {
    if (!sameArray(profile[field], role[field])) {
      fail("PROFILE_ROLE_CONFLICT", `${field} conflicts with role policy`);
    }
  }
  if (profile.roleId === "reviewer" && profile.toolIds.some((id) => FORBIDDEN_REVIEWER_TOOLS.has(id))) {
    fail("PROFILE_FORBIDDEN_CAPABILITY", "Reviewer profile contains a mutation or command capability");
  }
  return role;
}

function validateRegistryBindings(profile) {
  const roleSkill = registryEntry("roleSkills", profile.roleSkillId);
  if (!roleSkill || !roleSkill.supportedRoleIds.includes(profile.roleId)) {
    fail("PROFILE_ID_UNKNOWN", "roleSkillId is not authorized for this role");
  }
  const gatePolicy = registryEntry("gatePolicies", profile.gatePolicyId);
  if (!gatePolicy || !gatePolicy.supportedRoleIds.includes(profile.roleId) ||
      !sameArray(gatePolicy.toolIds, profile.toolIds)) {
    fail("PROFILE_ROLE_CONFLICT", "gate policy conflicts with the role tool surface");
  }
  const tools = profile.toolIds.map((id) => {
    const tool = registryEntry("tools", id);
    if (!tool || !tool.profileRoleIds.includes(profile.roleId) || tool.executionMode !== "sequential") {
      fail("PROFILE_ID_UNKNOWN", "toolId is not authorized by the closed registry");
    }
    return tool;
  });
  const targetKinds = (profile.targetKindIds ?? []).map((id) => {
    const kind = registryEntry("targetKinds", id);
    if (!kind || !kind.materializedRoleIds.includes(profile.roleId)) {
      fail("PROFILE_ID_UNKNOWN", "targetKindId is not materialized for this role");
    }
    return kind;
  });
  const practices = profile.practiceIds.map((id) => {
    const practice = registryEntry("practices", id);
    if (!practice || !practice.supportedRoleIds.includes(profile.roleId)) {
      fail("PROFILE_ID_UNKNOWN", "practiceId is not authorized by the closed registry");
    }
    const methodology = registryEntry("methodologySkills", practice.methodologySkillId);
    if (!methodology || !methodology.supportedPracticeIds.includes(id)) {
      fail("PROFILE_ID_UNKNOWN", "Practice methodology is not in the closed registry");
    }
    return { definition: practice, methodology };
  });
  return { gatePolicy, practices, roleSkill, targetKinds, tools };
}

export async function loadRoleProfileBundle({ profilePath, resourceRoot }) {
  if (typeof profilePath !== "string" || profilePath === "" ||
      typeof resourceRoot !== "string" || resourceRoot === "") {
    throw new TypeError("profilePath and resourceRoot are required");
  }
  const profileResource = await readTrustedFile(profilePath, {
    maxBytes: MAX_PROFILE_BYTES,
    kind: "role profile",
  });
  let profile;
  try {
    profile = JSON.parse(profileResource.text);
  } catch {
    fail("PROFILE_JSON_INVALID", "Role profile must be valid JSON");
  }
  validateProfile(profile, profileResource.digest);
  const bindings = validateRegistryBindings(profile);
  const roleSkillResource = await readTrustedFile(
    join(resourceRoot, bindings.roleSkill.relativePath),
    {
      root: resourceRoot,
      maxBytes: bindings.roleSkill.maxBytes,
      expectedDigest: bindings.roleSkill.digest,
      kind: "role skill",
    },
  );
  const practices = [];
  for (const practice of bindings.practices) {
    const methodologyResource = await readTrustedFile(
      join(resourceRoot, practice.methodology.relativePath),
      {
        root: resourceRoot,
        maxBytes: practice.methodology.maxBytes,
        expectedDigest: practice.methodology.digest,
        kind: "practice methodology",
      },
    );
    practices.push({
      definition: structuredClone(practice.definition),
      methodology: {
        id: practice.methodology.id,
        digest: methodologyResource.digest,
        text: methodologyResource.text,
      },
    });
  }
  return deepFreeze({
    schemaVersion: profile.schemaVersion,
    profile,
    profileDigest: profileResource.digest,
    roleSkill: {
      id: bindings.roleSkill.id,
      digest: roleSkillResource.digest,
      text: roleSkillResource.text,
    },
    gatePolicy: structuredClone(bindings.gatePolicy),
    tools: bindings.tools.map((tool) => structuredClone(tool)),
    targetKinds: bindings.targetKinds.map((kind) => structuredClone(kind)),
    practices,
  });
}

export function loadFixedRoleProfileBundle() {
  return loadRoleProfileBundle({
    profilePath: FIXED_PROFILE_PATH,
    resourceRoot: FIXED_RESOURCE_ROOT,
  });
}

export function assertRuntimeProfileMaterialized(bundle) {
  const roleId = bundle?.profile?.roleId;
  const role = roleId ? registryEntry("roles", roleId) : undefined;
  if (!Object.isFrozen(bundle) || !Object.isFrozen(bundle?.profile) || !Object.isFrozen(bundle?.profile?.toolIds) ||
      !Object.isFrozen(bundle?.tools) || !bundle?.tools?.every((tool) => Object.isFrozen(tool)) ||
      !Object.isFrozen(bundle?.targetKinds) || !bundle?.targetKinds?.every((kind) => Object.isFrozen(kind)) ||
      !role || !Array.isArray(bundle.profile.toolIds) || bundle.profileDigest !== role.profileDigest ||
      !sameArray(bundle.profile.toolIds, role.toolIds) ||
      !sameArray(bundle.profile.targetKindIds ?? [], role.targetKindIds ?? [])) {
    fail("PROFILE_BUNDLE_INVALID", "Runtime requires a validated frozen role profile bundle");
  }
  const missing = [...bundle.tools, ...bundle.targetKinds]
    .filter((entry) => !entry.materializedRoleIds.includes(roleId));
  if (missing.length > 0) {
    const error = new Error("The fixed role profile is valid but its runtime tool surface is not materialized");
    error.code = "TIANGONG_ROLE_RUNTIME_UNAVAILABLE";
    throw error;
  }
  return bundle;
}

export function roleRegistrySnapshot() {
  return closedRoleRegistries();
}
