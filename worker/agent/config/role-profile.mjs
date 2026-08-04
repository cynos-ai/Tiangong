import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { sha256 } from "../canonical-json.mjs";
import { closedRoleRegistries, registryEntry } from "../roles/registry.mjs";

export const FIXED_PROFILE_PATH = "/opt/tiangong-worker/profile.json";
export const FIXED_RESOURCE_ROOT = "/opt/tiangong-worker";

const PROFILE_KEYS = [
  "gatePolicyId",
  "roleId",
  "schemaVersion",
  "skillIds",
  "soulId",
  "title",
  "toolIds",
];
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TITLE_PATTERN = /^[\x20-\x7e]{1,80}$/u;
const MAX_PROFILE_BYTES = 8 * 1024;
const MAX_LIST_ITEMS = 32;
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
  assertExactKeys(profile, PROFILE_KEYS, "Role profile");
  if (profile.schemaVersion !== 1) fail("PROFILE_VERSION_UNSUPPORTED", "Unsupported role profile version");
  assertId(profile.roleId, "roleId");
  if (typeof profile.title !== "string" || !TITLE_PATTERN.test(profile.title)) {
    fail("PROFILE_SCHEMA_MISMATCH", "title must be bounded printable ASCII");
  }
  assertId(profile.soulId, "soulId");
  assertIdList(profile.skillIds, "skillIds");
  assertIdList(profile.toolIds, "toolIds");
  assertId(profile.gatePolicyId, "gatePolicyId");

  const role = registryEntry("roles", profile.roleId);
  if (!role) fail("PROFILE_ID_UNKNOWN", "roleId is not in the closed registry");
  if (profileDigest !== role.profileDigest) {
    fail("PROFILE_DIGEST_MISMATCH", "Role profile digest does not match the closed registry");
  }
  for (const field of ["title", "gatePolicyId", "soulId"]) {
    if (profile[field] !== role[field]) fail("PROFILE_ROLE_CONFLICT", `${field} conflicts with role policy`);
  }
  for (const field of ["skillIds", "toolIds"]) {
    if (!sameArray(profile[field], role[field])) {
      fail("PROFILE_ROLE_CONFLICT", `${field} conflicts with role policy`);
    }
  }
  return role;
}

function validateRegistryBindings(profile) {
  const soul = registryEntry("souls", profile.soulId);
  if (!soul || !soul.supportedRoleIds.includes(profile.roleId)) {
    fail("PROFILE_ID_UNKNOWN", "soulId is not authorized for this role");
  }
  const skills = profile.skillIds.map((id) => {
    const skill = registryEntry("skills", id);
    if (!skill || !skill.supportedRoleIds.includes(profile.roleId)) {
      fail("PROFILE_ID_UNKNOWN", "skillId is not authorized for this role");
    }
    return skill;
  });
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
  return { gatePolicy, skills, soul, tools };
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
  const role = validateProfile(profile, profileResource.digest);
  const bindings = validateRegistryBindings(profile);
  const soulResource = await readTrustedFile(
    join(resourceRoot, bindings.soul.relativePath),
    {
      root: resourceRoot,
      maxBytes: bindings.soul.maxBytes,
      expectedDigest: bindings.soul.digest,
      kind: "SOUL",
    },
  );
  const skills = [];
  for (const skill of bindings.skills) {
    const resource = await readTrustedFile(
      join(resourceRoot, skill.relativePath),
      {
        root: resourceRoot,
        maxBytes: skill.maxBytes,
        expectedDigest: skill.digest,
        kind: "Skill",
      },
    );
    skills.push({
      id: skill.id,
      digest: resource.digest,
      text: resource.text,
    });
  }
  return deepFreeze({
    schemaVersion: profile.schemaVersion,
    profile,
    profileDigest: profileResource.digest,
    runtimeKind: role.runtimeKind,
    soul: {
      id: bindings.soul.id,
      digest: soulResource.digest,
      text: soulResource.text,
    },
    skills,
    gatePolicy: structuredClone(bindings.gatePolicy),
    tools: bindings.tools.map((tool) => structuredClone(tool)),
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
      !Object.isFrozen(bundle?.profile?.skillIds) || !Object.isFrozen(bundle?.tools) ||
      !bundle?.tools?.every((tool) => Object.isFrozen(tool)) || !Object.isFrozen(bundle?.skills) ||
      !bundle?.skills?.every((skill) => Object.isFrozen(skill)) || !Object.isFrozen(bundle?.soul) ||
      !role || !["core", "leader", "member"].includes(bundle.runtimeKind) ||
      bundle.runtimeKind !== role.runtimeKind || !Array.isArray(bundle.profile.toolIds) ||
      bundle.profileDigest !== role.profileDigest ||
      bundle.profile.soulId !== role.soulId || !sameArray(bundle.profile.toolIds, role.toolIds) ||
      !sameArray(bundle.profile.skillIds, role.skillIds) || bundle.soul.id !== role.soulId ||
      !sameArray(bundle.skills.map((skill) => skill.id), role.skillIds)) {
    fail("PROFILE_BUNDLE_INVALID", "Runtime requires a validated frozen RoleProfile bundle");
  }
  const missing = bundle.tools.filter((entry) => !entry.materializedRoleIds.includes(roleId));
  if (missing.length > 0) {
    const error = new Error("The fixed RoleProfile is valid but its runtime tool surface is not materialized");
    error.code = "TIANGONG_ROLE_RUNTIME_UNAVAILABLE";
    throw error;
  }
  return bundle;
}

export function roleRegistrySnapshot() {
  return closedRoleRegistries();
}
