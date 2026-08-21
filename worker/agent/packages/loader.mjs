import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { isMemberConfig } from "../team/coordination-contracts.mjs";
import { effectiveSkills, loadInstalledSkills } from "../skills/catalog.mjs";

const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const RESPONSIBILITIES = new Set(["leader", "architect", "challenger", "developer", "reviewer", "tester"]);
const SESSION_POLICIES = Object.freeze({ leader: "one-session-per-work", architect: "one-session-per-task", challenger: "one-session-per-task", developer: "one-session-per-task", reviewer: "one-session-per-task", tester: "one-session-per-task" });
const TOOL_GROUPS = Object.freeze({ leader: ["coordination", "skill-runtime"], architect: ["skill-runtime", "workspace"], challenger: ["skill-runtime", "workspace"], developer: ["skill-runtime", "workspace"], reviewer: ["skill-runtime", "workspace"], tester: ["skill-runtime", "workspace"] });
const MANIFEST_FIELDS = new Set(["kind", "schemaVersion", "packageId", "version", "responsibility", "displayName", "instructions", "runtime", "defaultModel", "toolGroups", "sessionPolicy", "installedSkills"]);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function rootPath(value) { return resolve(value instanceof URL ? fileURLToPath(value) : value); }
function exact(value, fields, name) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.has(key))) fail("AGENT_PACKAGE_INVALID", `${name} has missing or unknown fields`); }
function bounded(value, name, limit = 256) { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /[\u0000\r\n]/u.test(value)) fail("AGENT_PACKAGE_INVALID", `${name} is missing or unbounded`); return value; }
function strings(value, name, maximum = 16) { if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !ID.test(entry)) || new Set(value).size !== value.length) fail("AGENT_PACKAGE_INVALID", `${name} is invalid`); return value; }
function normalizeResponsibility(value) { return value === "team_leader" ? "leader" : value === "implementor" ? "developer" : value; }

function skillLocks(value) {
  if (!Array.isArray(value) || value.length > 16) fail("AGENT_PACKAGE_INVALID", "installedSkills is invalid");
  const result = value.map((entry) => {
    exact(entry, new Set(["skillId", "version", "contentDigest"]), "installed Skill lock");
    if (!ID.test(entry.skillId ?? "") || !VERSION.test(entry.version ?? "") || !DIGEST.test(entry.contentDigest ?? "")) fail("AGENT_PACKAGE_INVALID", "installed Skill lock is invalid");
    return { skillId: entry.skillId, version: entry.version, contentDigest: entry.contentDigest };
  });
  if (new Set(result.map((entry) => entry.skillId)).size !== result.length) fail("AGENT_PACKAGE_INVALID", "installed Skill locks contain duplicates"); return result;
}

export async function loadAgentPackage(packageRootInput) {
  const packageRoot = rootPath(packageRootInput); const rootStat = await lstat(packageRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("AGENT_PACKAGE_INVALID", `${packageRoot}: package root must be a real directory`);
  const directoryName = packageRoot.split(sep).at(-1); const entries = await readdir(packageRoot, { withFileTypes: true });
  if (entries.length !== 2 || entries.some((entry) => !entry.isFile() || !["agent.json", "instructions.md"].includes(entry.name))) fail("AGENT_PACKAGE_INVALID", `${directoryName}: package must contain only agent.json and instructions.md`);
  for (const entry of entries) if ((await lstat(resolve(packageRoot, entry.name))).isSymbolicLink()) fail("AGENT_PACKAGE_INVALID", `${directoryName}: symbolic links are forbidden`);
  const manifestText = await readFile(resolve(packageRoot, "agent.json"), "utf8"); const manifest = JSON.parse(manifestText); exact(manifest, MANIFEST_FIELDS, "Agent package");
  if (manifest.kind !== "tiangong.agent-package" || manifest.schemaVersion !== 3 || !ID.test(manifest.packageId ?? "") || !VERSION.test(manifest.version ?? "") || !RESPONSIBILITIES.has(manifest.responsibility) || manifest.responsibility !== directoryName) fail("AGENT_PACKAGE_INVALID", `${directoryName}: identity is invalid`);
  if (manifest.instructions !== "instructions.md" || manifest.runtime !== "openclaw-built-in" || typeof manifest.defaultModel !== "string" || manifest.defaultModel.length === 0) fail("AGENT_PACKAGE_INVALID", `${directoryName}: runtime projection is invalid`);
  if (manifest.sessionPolicy !== SESSION_POLICIES[manifest.responsibility]) fail("AGENT_PACKAGE_INVALID", `${directoryName}: session policy is invalid`);
  const instructions = await readFile(resolve(packageRoot, manifest.instructions), "utf8"); bounded(manifest.displayName, "displayName", 64); bounded(manifest.defaultModel, "defaultModel", 128); if (instructions.length === 0 || Buffer.byteLength(instructions) > 16 * 1024) fail("AGENT_PACKAGE_INVALID", `${directoryName}: instructions are invalid`);
  const installedSkills = skillLocks(manifest.installedSkills); const toolGroups = strings(manifest.toolGroups, "toolGroups");
  if (canonicalJson(toolGroups) !== canonicalJson(TOOL_GROUPS[manifest.responsibility])) fail("AGENT_PACKAGE_INVALID", `${directoryName}: tool groups do not match the responsibility`);
  const packageDigest = sha256(canonicalJson({ manifest, instructionsDigest: sha256(instructions) }));
  return freeze({ ...manifest, installedSkills, toolGroups, instructions, packageDigest });
}

export async function loadAgentPackages({ root = new URL("../../agent-packages/", import.meta.url) } = {}) {
  const path = rootPath(root); const entries = (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const packages = await Promise.all(entries.map((entry) => loadAgentPackage(resolve(path, entry.name))));
  const byId = Object.fromEntries(packages.map((entry) => [entry.packageId, entry])); const responsibilities = new Set(packages.map((entry) => entry.responsibility));
  if (Object.keys(byId).length !== packages.length || responsibilities.size !== RESPONSIBILITIES.size || [...RESPONSIBILITIES].some((entry) => !responsibilities.has(entry))) fail("AGENT_PACKAGE_INVALID", "Exactly one package per initial responsibility is required"); return freeze({ packages, byId });
}

export async function resolveMemberAgent({ memberConfig, packageRoot, skillsRoot } = {}) {
  if (!isMemberConfig(memberConfig) || !memberConfig.enabled) fail("MEMBER_AGENT_INVALID", "An enabled MemberConfig is required");
  const [{ byId }, installed] = await Promise.all([loadAgentPackages({ root: packageRoot }), loadInstalledSkills({ root: skillsRoot })]);
  const agentPackage = byId[memberConfig.agentPackageId]; const responsibility = normalizeResponsibility(memberConfig.role);
  if (!agentPackage || agentPackage.version !== memberConfig.agentPackageVersion) fail("AGENT_PACKAGE_NOT_INSTALLED", "MemberConfig Agent package is not installed at the configured version");
  if (agentPackage.responsibility !== responsibility || agentPackage.runtime !== memberConfig.runtime) fail("MEMBER_AGENT_MISMATCH", "MemberConfig does not match its Agent package");
  const skills = effectiveSkills({ installedSkills: installed.byId, packageSkills: agentPackage.installedSkills, allowedSkills: memberConfig.allowedSkills });
  return freeze({ memberId: memberConfig.memberId, memberRevision: memberConfig.revision, agentPackage, effectiveSkills: skills, sessionPolicy: agentPackage.sessionPolicy, model: memberConfig.model });
}

function csv(value, name) {
  if (typeof value !== "string") fail("MEMBER_AGENT_ENV_INVALID", `${name} is required`); if (value === "") return [];
  const items = value.split(","); if (items.some((entry) => !ID.test(entry)) || new Set(items).size !== items.length) fail("MEMBER_AGENT_ENV_INVALID", `${name} is invalid`); return items;
}

/** Validate the deployment projection before OpenClaw config mutation and on every turn/tool selection. */
export async function resolveAgentRuntimeFromEnvironment(env = process.env, options = {}) {
  const responsibility = normalizeResponsibility(env.TIANGONG_MEMBER_RESPONSIBILITY); const packageId = env.TIANGONG_MEMBER_AGENT_PACKAGE_ID; const packageVersion = env.TIANGONG_MEMBER_AGENT_PACKAGE_VERSION;
  const memberRevision = Number(env.TIANGONG_MEMBER_REVISION);
  if (!RESPONSIBILITIES.has(responsibility) || !ID.test(packageId ?? "") || !VERSION.test(packageVersion ?? "") || !Number.isSafeInteger(memberRevision) || memberRevision < 1 || typeof env.TIANGONG_MEMBER_MODEL !== "string" || env.TIANGONG_MEMBER_MODEL.length === 0 || env.TIANGONG_MEMBER_MODEL.length > 128) fail("MEMBER_AGENT_ENV_INVALID", "Agent package deployment projection is missing or invalid");
  const [{ byId }, installed] = await Promise.all([loadAgentPackages({ root: options.packageRoot }), loadInstalledSkills({ root: options.skillsRoot })]); const agentPackage = byId[packageId];
  if (!agentPackage || agentPackage.version !== packageVersion || agentPackage.responsibility !== responsibility || agentPackage.runtime !== env.TIANGONG_MEMBER_RUNTIME) fail("MEMBER_AGENT_MISMATCH", "Environment does not match the installed Agent package");
  const skills = effectiveSkills({ installedSkills: installed.byId, packageSkills: agentPackage.installedSkills, allowedSkills: csv(env.TIANGONG_MEMBER_ALLOWED_SKILLS, "TIANGONG_MEMBER_ALLOWED_SKILLS") });
  return freeze({ agentPackage, effectiveSkills: skills, memberRevision, model: env.TIANGONG_MEMBER_MODEL, memberId: env.TIANGONG_MEMBER_ID ?? env.AGENTTEAMS_WORKER_NAME ?? null });
}

export { SESSION_POLICIES, TOOL_GROUPS };
