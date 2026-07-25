import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { sha256 } from "../canonical-json.mjs";

const TOOL_POLICY_VERSION = "workspace-tools-v1";
const SENSITIVE_PATH_NAMES = new Set([
  ".env",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "openclaw.json",
]);

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertNonSensitivePath(relativePath) {
  const segments = relativePath.split(sep);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (SENSITIVE_PATH_NAMES.has(lower) || lower.startsWith(".env.") ||
        lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12")) {
      throw new Error("Credential-bearing paths are not accessible to tools");
    }
  }
}

export async function resolveWorkspacePath(workspaceDir, requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath === "") throw new TypeError("path is required");
  const workspace = await realpath(workspaceDir);
  const candidate = resolve(workspace, requestedPath);
  if (!isWithin(workspace, candidate)) throw new Error("Path is outside the authorized workspace");

  const relativePath = relative(workspace, candidate) || ".";
  if (relativePath.split(sep)[0] === ".tiangong") {
    throw new Error("The Tiangong runtime state directory is not accessible to tools");
  }
  assertNonSensitivePath(relativePath);
  let current = workspace;
  for (const segment of relativePath.split(sep)) {
    if (segment === ".") continue;
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in authorized tool paths");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return {
    absolutePath: candidate,
    relativePath,
    workspaceScope: sha256(workspace),
  };
}

async function existingFileDigest(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("Write target must be a regular file or not exist");
    const content = await readFile(path);
    return { existed: true, previousDigest: sha256(content), previousBytes: content.byteLength };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { existed: false, previousDigest: null, previousBytes: 0 };
    }
    throw error;
  }
}

export async function summarizeRead(workspaceDir, params) {
  const target = await resolveWorkspacePath(workspaceDir, params.path);
  return {
    policyVersion: TOOL_POLICY_VERSION,
    workspaceScope: target.workspaceScope,
    toolName: "read",
    target: target.relativePath,
    input: {
      offset: params.offset ?? null,
      limit: params.limit ?? null,
    },
  };
}

export async function summarizeWrite(workspaceDir, params) {
  if (typeof params.content !== "string") throw new TypeError("write content must be a string");
  const target = await resolveWorkspacePath(workspaceDir, params.path);
  const previous = await existingFileDigest(target.absolutePath);
  return {
    policyVersion: TOOL_POLICY_VERSION,
    workspaceScope: target.workspaceScope,
    toolName: "write",
    target: target.relativePath,
    input: {
      contentDigest: sha256(params.content),
      contentBytes: Buffer.byteLength(params.content),
    },
    precondition: previous,
  };
}
