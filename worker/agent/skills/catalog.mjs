import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../canonical-json.mjs";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const TOP_LEVEL = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const PACKAGE_ENTRIES = new Set(["SKILL.md", "assets", "references", "scripts", "tests"]);
const PROHIBITED = [/(?:^|[\s`'"(])\/(?:home|Users)\//u, /(?:^|[\s`'"(])\.\.\/[A-Za-z0-9._-]+/u, /\bCynos\b|\.cynos\b|cynos_/u, /\bgh[opsu]_[A-Za-z0-9]{20,}\b/u, /\b(?:sk|LTAI)[-_A-Za-z0-9]{16,}\b/u];

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function bounded(value, name, limit) { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /[\u0000\r\n]/u.test(value)) fail("SKILL_PACKAGE_INVALID", `${name} is missing or unbounded`); return value; }
function rootPath(value) { return resolve(value instanceof URL ? fileURLToPath(value) : value); }

function parseFrontmatter(text, source) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/u);
  if (!match) fail("SKILL_PACKAGE_INVALID", `${source}: missing frontmatter or body`);
  const fields = new Map(); const metadata = new Map(); let section = null;
  for (const line of match[1].split("\n")) {
    if (/^  [A-Za-z0-9_-]+:/u.test(line)) {
      if (section !== "metadata") fail("SKILL_PACKAGE_INVALID", `${source}: nested fields are only allowed under metadata`);
      const index = line.indexOf(":"); const key = line.slice(2, index); const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/gu, "");
      if (metadata.has(key)) fail("SKILL_PACKAGE_INVALID", `${source}: duplicate metadata ${key}`); metadata.set(key, value); continue;
    }
    if (/^\s/u.test(line)) fail("SKILL_PACKAGE_INVALID", `${source}: unsupported YAML structure`);
    const index = line.indexOf(":"); if (index < 1) fail("SKILL_PACKAGE_INVALID", `${source}: invalid frontmatter line`);
    const key = line.slice(0, index); const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/gu, "");
    if (!TOP_LEVEL.has(key) || fields.has(key)) fail("SKILL_PACKAGE_INVALID", `${source}: unsupported or duplicate field ${key}`);
    fields.set(key, value); section = key;
  }
  const name = fields.get("name"); const description = fields.get("description"); const license = fields.get("license");
  if (!NAME.test(name ?? "") || name.length > 64) fail("SKILL_PACKAGE_INVALID", `${source}: invalid name`);
  bounded(description, `${source} description`, 1024); if (license !== "Apache-2.0") fail("SKILL_PACKAGE_INVALID", `${source}: native Skills require Apache-2.0`);
  if (metadata.get("source") !== "tiangong" || !VERSION.test(metadata.get("version") ?? "") || [...metadata.keys()].some((key) => !["version", "source"].includes(key))) fail("SKILL_PACKAGE_INVALID", `${source}: invalid version/source metadata`);
  if (match[2].split("\n").length > 500) fail("SKILL_PACKAGE_INVALID", `${source}: body exceeds 500 lines`);
  return { name, description, license, version: metadata.get("version"), instructions: match[2] };
}

async function packageFiles(packageRoot) {
  const entries = await readdir(packageRoot, { withFileTypes: true });
  if (entries.some((entry) => !PACKAGE_ENTRIES.has(entry.name))) fail("SKILL_PACKAGE_INVALID", `${packageRoot}: unsupported package entry`);
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name); const stat = await lstat(path);
      if (stat.isSymbolicLink()) fail("SKILL_PACKAGE_INVALID", `${path}: symbolic links are forbidden`);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) files.push(path); else fail("SKILL_PACKAGE_INVALID", `${path}: unsupported file type`);
    }
  }
  await walk(packageRoot); return files;
}

function stringArray(value, name, minimum = 1) { if (!Array.isArray(value) || value.length < minimum || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) fail("SKILL_PACKAGE_INVALID", `${name} must be non-empty strings`); return value; }

export async function loadSkillPackage(packageRootInput) {
  const packageRoot = rootPath(packageRootInput); const rootStat = await lstat(packageRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("SKILL_PACKAGE_INVALID", `${packageRoot}: package root must be a real directory`);
  const directoryName = packageRoot.split(sep).at(-1);
  const files = await packageFiles(packageRoot); const skillFile = resolve(packageRoot, "SKILL.md");
  if (!files.includes(skillFile)) fail("SKILL_PACKAGE_INVALID", `${packageRoot}: SKILL.md is required`);
  const fileRecords = [];
  for (const path of files) {
    const content = await readFile(path); const text = content.toString("utf8");
    if (PROHIBITED.some((pattern) => pattern.test(text))) fail("SKILL_PACKAGE_UNSAFE", `${relative(packageRoot, path)} contains prohibited public content`);
    fileRecords.push({ path: relative(packageRoot, path).split(sep).join("/"), digest: sha256(content) });
  }
  const parsed = parseFrontmatter(await readFile(skillFile, "utf8"), directoryName);
  if (parsed.name !== directoryName) fail("SKILL_PACKAGE_INVALID", `${directoryName}: name must match directory`);
  const triggers = JSON.parse(await readFile(resolve(packageRoot, "tests/trigger-cases.json"), "utf8"));
  stringArray(triggers.shouldTrigger, `${directoryName} shouldTrigger`, 2); stringArray(triggers.shouldNotTrigger, `${directoryName} shouldNotTrigger`, 2); stringArray(triggers.ambiguous, `${directoryName} ambiguous`); stringArray(triggers.adjacentSkills, `${directoryName} adjacentSkills`);
  const behavior = JSON.parse(await readFile(resolve(packageRoot, "tests/behavior-cases.json"), "utf8"));
  for (const key of ["success", "blocked", "cleanup"]) if (!Array.isArray(behavior[key]) || behavior[key].length < 1 || behavior[key].some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) fail("SKILL_PACKAGE_INVALID", `${directoryName} requires ${key} behavior cases`);
  return freeze({ kind: "tiangong.skill-package", schemaVersion: 1, skillId: parsed.name, version: parsed.version, description: parsed.description, license: parsed.license, instructions: parsed.instructions, contentDigest: sha256(canonicalJson({ files: fileRecords })), triggers, behavior });
}

export async function loadInstalledSkills({ root = new URL("../../skills/", import.meta.url) } = {}) {
  const path = rootPath(root); const entries = (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const skills = await Promise.all(entries.map((entry) => loadSkillPackage(resolve(path, entry.name)))); const byId = Object.fromEntries(skills.map((skill) => [skill.skillId, skill]));
  if (Object.keys(byId).length !== skills.length) fail("SKILL_PACKAGE_INVALID", "Installed Skill IDs must be unique"); return freeze({ skills, byId });
}

export function effectiveSkills({ installedSkills, packageSkills, allowedSkills } = {}) {
  if (!installedSkills || typeof installedSkills !== "object" || Array.isArray(installedSkills) || !Array.isArray(packageSkills) || !Array.isArray(allowedSkills)) fail("SKILL_CONFIG_INVALID", "Skill resolution inputs are invalid");
  if (new Set(allowedSkills).size !== allowedSkills.length) fail("SKILL_CONFIG_INVALID", "allowedSkills contains duplicates");
  const packageById = new Map(packageSkills.map((entry) => [entry.skillId, entry]));
  for (const skillId of allowedSkills) if (!packageById.has(skillId)) fail("SKILL_NOT_INSTALLED_FOR_AGENT", `${skillId} is not installed by the Agent package`);
  const result = allowedSkills.map((skillId) => {
    const installed = installedSkills[skillId]; const locked = packageById.get(skillId);
    if (!installed || installed.version !== locked.version || installed.contentDigest !== locked.contentDigest) fail("SKILL_LOCK_MISMATCH", `${skillId} does not match the Agent package lock`);
    return installed;
  });
  return freeze(result);
}
