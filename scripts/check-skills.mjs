#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const skillsRoot = resolve(repoRoot, ".agents/skills");
const allowedFields = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const prohibitedContent = [
  { pattern: /(?:^|[\s`'"(])\/(?:home|Users)\//u, label: "local absolute path" },
  { pattern: /(?:^|[\s`'"(])\.\.\/[A-Za-z0-9._-]+/u, label: "sibling repository path" },
  { pattern: /\bCynos\b|\.cynos\b|cynos_/u, label: "unrelated product vocabulary" },
  { pattern: /\bgh[opsu]_[A-Za-z0-9]{20,}\b/u, label: "GitHub token" },
  { pattern: /\b(?:sk|LTAI)[-_A-Za-z0-9]{16,}\b/u, label: "credential-like value" },
];

function fail(message) {
  throw new Error(message);
}

function parseFrontmatter(content, path) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/u);
  if (!match) fail(`${path}: expected YAML frontmatter and a non-empty body`);
  const fields = new Map();
  for (const line of match[1].split("\n")) {
    if (/^\s/u.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator < 1) fail(`${path}: invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
    if (!allowedFields.has(key)) fail(`${path}: unsupported frontmatter field: ${key}`);
    if (fields.has(key)) fail(`${path}: duplicate frontmatter field: ${key}`);
    fields.set(key, value);
  }
  return { fields, body: match[2] };
}

async function walk(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const candidate = resolve(path, entry.name);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) fail(`${relative(repoRoot, candidate)}: symbolic links are not allowed in Skills`);
    if (entry.isDirectory()) files.push(...await walk(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

function assertInsideSkill(skillRoot, candidate, source) {
  const path = resolve(dirname(source), candidate);
  if (path !== skillRoot && !path.startsWith(`${skillRoot}${sep}`)) {
    fail(`${relative(repoRoot, source)}: reference escapes the Skill: ${candidate}`);
  }
  return path;
}

const skillEntries = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));
if (skillEntries.length === 0) fail("No project Skills found");

for (const entry of skillEntries) {
  const skillRoot = resolve(skillsRoot, entry.name);
  const skillFile = resolve(skillRoot, "SKILL.md");
  const content = await readFile(skillFile, "utf8");
  const { fields, body } = parseFrontmatter(content, relative(repoRoot, skillFile));
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (name !== entry.name) fail(`${entry.name}: frontmatter name must equal the directory name`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
    fail(`${entry.name}: invalid Skill name`);
  }
  if (description.length === 0 || description.length > 1024) {
    fail(`${entry.name}: description must contain 1..1024 characters`);
  }
  if (body.split("\n").length > 500) fail(`${entry.name}: SKILL.md exceeds 500 body lines`);

  const triggerFile = resolve(skillRoot, "tests/trigger-cases.json");
  const triggers = JSON.parse(await readFile(triggerFile, "utf8"));
  for (const key of ["shouldTrigger", "shouldNotTrigger"]) {
    if (!Array.isArray(triggers[key]) || triggers[key].length < 2 ||
        triggers[key].some((value) => typeof value !== "string" || value.trim() === "")) {
      fail(`${entry.name}: ${key} must contain at least two non-empty prompts`);
    }
  }

  const files = await walk(skillRoot);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const { pattern, label } of prohibitedContent) {
      if (pattern.test(text)) fail(`${relative(repoRoot, file)}: contains ${label}`);
    }
    if (file.endsWith(".md")) {
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const target = match[1];
        if (/^(?:https?:|#)/u.test(target)) continue;
        const referenced = assertInsideSkill(skillRoot, target, file);
        await lstat(referenced).catch(() => fail(`${relative(repoRoot, file)}: missing reference ${target}`));
      }
    }
  }
  console.log(`skill=${name} validation=pass`);
}
