#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const MAX_LOCK_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function packageName(path) {
  return path.split("node_modules/").at(-1);
}

async function readBoundedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_LOCK_BYTES) throw new Error("LOCKFILE_UNSAFE");
  return JSON.parse(await readFile(path, "utf8"));
}

async function responseText(response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > MAX_RESPONSE_BYTES) throw new Error("AUDIT_RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function auditLockfiles(paths, { fetchImpl = globalThis.fetch } = {}) {
  if (!Array.isArray(paths) || paths.length === 0 || typeof fetchImpl !== "function") throw new Error("LOCKFILE_REQUIRED");
  const inventory = new Map();
  for (const input of paths) {
    const lock = await readBoundedJson(resolve(input));
    if (!lock || lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") throw new Error("LOCKFILE_INVALID");
    for (const [path, record] of Object.entries(lock.packages)) {
      if (!path.includes("node_modules/") || typeof record?.version !== "string" || record.dev === true) continue;
      const name = packageName(path);
      if (!PACKAGE_NAME.test(name) || record.version.length > 128) throw new Error("LOCKFILE_PACKAGE_INVALID");
      const versions = inventory.get(name) ?? new Set();
      versions.add(record.version);
      inventory.set(name, versions);
    }
  }
  if (inventory.size === 0 || inventory.size > 4096) throw new Error("LOCKFILE_INVENTORY_INVALID");
  const body = Object.fromEntries([...inventory].sort(([left], [right]) => left.localeCompare(right)).map(([name, versions]) => [name, [...versions].sort()]));
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Tiangong-lockfile-audit" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`AUDIT_ENDPOINT_${response.status}`);
  const findings = JSON.parse(await responseText(response));
  if (!findings || typeof findings !== "object" || Array.isArray(findings)) throw new Error("AUDIT_RESPONSE_INVALID");
  const vulnerablePackages = Object.keys(findings).sort();
  if (vulnerablePackages.length > 0) {
    const summary = vulnerablePackages.map((name) => ({
      name,
      severities: [...new Set((Array.isArray(findings[name]) ? findings[name] : []).map((finding) => finding?.severity).filter((value) => typeof value === "string"))].sort(),
    }));
    const error = new Error("LOCKFILE_VULNERABILITIES_FOUND");
    error.summary = summary;
    throw error;
  }
  return Object.freeze({ packageCount: inventory.size, vulnerabilityCount: 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await auditLockfiles(process.argv.slice(2));
    process.stdout.write(`lockfile_audit=pass packages=${result.packageCount} vulnerabilities=0 endpoint=bulk\n`);
  } catch (error) {
    process.stderr.write(`lockfile_audit=fail code=${error?.message || "UNKNOWN"}${error?.summary ? ` summary=${JSON.stringify(error.summary)}` : ""}\n`);
    process.exitCode = 1;
  }
}
