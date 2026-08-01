import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { isCapturedArtifactError } from "../artifacts/errors.mjs";
import {
  ARTIFACT_REF_PATTERN,
  deriveArtifactKey,
  deriveArtifactRefDigest,
} from "../artifacts/schema.mjs";
import { practiceRunFail } from "./errors.mjs";

export const TARGET_ID_PATTERN = /^target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const MATERIALIZED_TARGET_KINDS = Object.freeze(["file", "directory_snapshot"]);
export const MAX_SCOPE_TARGETS = 64;
export const MAX_MEMBER_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_TARGET_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN = 960;
export const MAX_DIRECTORY_MEMBERS = 960;
export const MAX_DIRECTORY_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_RUN_DIRECTORY_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_READ_LINES = 2000;
export const MAX_RETURNED_BYTES = 50 * 1024;
export const MAX_CONSUME_SEGMENTS_PER_RESOURCE = 128;
const MAX_PATH_BYTES = 1024;
const MAX_TARGET_DESCRIPTOR_BYTES = 4 * 1024;
const MAX_SCOPE_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_SELECTOR_PREFIXES = 128;
const MAX_SELECTOR_BYTES = 16 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const RFC3339_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const SENSITIVE_EXACT = new Set([
  ".tiangong", ".env", "auth.json", "credentials", "credentials.json",
  "id_ed25519", "id_rsa", "openclaw.json",
]);

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function fail(code, message) {
  practiceRunFail(code, message);
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pathIsWithin(path, prefix) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function pathIsAncestor(path, candidate) {
  return path === "." || candidate === path || candidate.startsWith(`${path}/`);
}

function sensitiveSegment(segment) {
  const lower = segment.toLowerCase();
  return SENSITIVE_EXACT.has(lower) || lower.startsWith(".env.")
    || lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12");
}

function assertNotSensitive(path) {
  if (path.split("/").some(sensitiveSegment)) {
    fail("TARGET_SENSITIVE_PATH_DENIED", "Target selector contains a denied sensitive path segment");
  }
}

export function normalizeRelativePath(value, { allowRoot = false, sensitive = true } = {}) {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.endsWith("/")) {
    fail("TARGET_SELECTOR_INVALID", "Target path has invalid relative-path grammar");
  }
  if (value.startsWith("/")) fail("TARGET_OUTSIDE_WORKSPACE", "Target path escapes the authorized workspace");
  const normalized = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "..") {
      if (segment === "..") fail("TARGET_OUTSIDE_WORKSPACE", "Target path escapes the authorized workspace");
      fail("TARGET_SELECTOR_INVALID", "Target path has an empty component");
    }
    if (segment !== ".") normalized.push(segment);
  }
  const path = normalized.length === 0 ? "." : normalized.join("/");
  if (!allowRoot && path === ".") fail("TARGET_SELECTOR_INVALID", "Target path must identify a file");
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    fail("TARGET_LIMIT_EXCEEDED", "Target path exceeds its fixed byte limit");
  }
  if (sensitive) assertNotSensitive(path);
  return path;
}

function normalizePrefix(value) {
  return normalizeRelativePath(value, { allowRoot: true, sensitive: false });
}

function normalizePrefixArray(value, name) {
  if (!Array.isArray(value) || value.length > MAX_SELECTOR_PREFIXES || (name === "includePrefixes" && value.length === 0)) {
    fail("TARGET_SELECTOR_INVALID", `${name} must be a bounded array`);
  }
  const normalized = value.map(normalizePrefix).sort(utf8Compare);
  for (let index = 0; index < normalized.length; index += 1) {
    if (index > 0 && (normalized[index] === normalized[index - 1]
      || pathIsWithin(normalized[index], normalized[index - 1]))) {
      fail("TARGET_SELECTOR_INVALID", `${name} contains duplicate or overlapping prefixes`);
    }
  }
  return normalized;
}

function normalizeSelection(value) {
  if (!exact(value, ["excludePrefixes", "includePrefixes"])) {
    fail("INVALID_TARGET", "Directory selection has missing or unknown fields");
  }
  const includePrefixes = normalizePrefixArray(value.includePrefixes, "includePrefixes");
  const excludePrefixes = normalizePrefixArray(value.excludePrefixes, "excludePrefixes");
  for (const excluded of excludePrefixes) {
    if (!includePrefixes.some((included) => pathIsWithin(excluded, included))
      || includePrefixes.includes(excluded)) {
      fail("TARGET_SELECTOR_INVALID", "Directory exclusion is outside or equal to its include prefix");
    }
  }
  if (Buffer.byteLength(canonicalJson({ includePrefixes, excludePrefixes }), "utf8") > MAX_SELECTOR_BYTES) {
    fail("TARGET_LIMIT_EXCEEDED", "Directory selector exceeds its fixed byte limit");
  }
  return Object.freeze({ includePrefixes: Object.freeze(includePrefixes), excludePrefixes: Object.freeze(excludePrefixes) });
}

export function normalizeTargetRequests(value, materializedKinds = MATERIALIZED_TARGET_KINDS) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_TARGETS) {
    fail("INVALID_TARGET", "targets must be a non-empty bounded array");
  }
  const allowed = new Set(materializedKinds);
  const normalized = value.map((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.kind !== "string") {
      fail("INVALID_TARGET", "Target request is invalid");
    }
    if (!["file", "directory_snapshot", "commit", "git_diff"].includes(request.kind)) {
      fail("INVALID_TARGET", "Target kind is unknown");
    }
    if (!allowed.has(request.kind)) fail("TARGET_KIND_NOT_MATERIALIZED", "Target kind is not materialized by this profile");
    let result;
    if (request.kind === "file") {
      if (!exact(request, ["kind", "path"])) fail("INVALID_TARGET", "File target has missing or unknown fields");
      result = { kind: "file", path: normalizeRelativePath(request.path) };
    } else {
      if (!exact(request, ["kind", "path", "selection"])) {
        fail("INVALID_TARGET", "Directory target has missing or unknown fields");
      }
      result = {
        kind: "directory_snapshot",
        path: normalizeRelativePath(request.path, { allowRoot: true }),
        selection: normalizeSelection(request.selection),
      };
    }
    const descriptor = { schemaVersion: 1, source: "model_normalized", value: descriptorValue(result) };
    if (Buffer.byteLength(canonicalJson(descriptor), "utf8") > MAX_TARGET_DESCRIPTOR_BYTES) {
      fail("TARGET_LIMIT_EXCEEDED", "Target descriptor exceeds its fixed byte limit");
    }
    return Object.freeze(result);
  });
  const identities = normalized.map((request) => canonicalJson(request));
  if (new Set(identities).size !== identities.length) {
    fail("SCOPE_TARGET_ALREADY_PRESENT", "Target batch contains duplicate normalized descriptors");
  }
  const descriptorBytes = Buffer.byteLength(canonicalJson(normalized.map((request) => ({
    schemaVersion: 1,
    source: "model_normalized",
    value: descriptorValue(request),
  }))));
  if (descriptorBytes > MAX_SCOPE_DESCRIPTOR_BYTES) {
    fail("TARGET_LIMIT_EXCEEDED", "Target descriptors exceed their aggregate byte limit");
  }
  return Object.freeze(normalized);
}

export function descriptorValue(request) {
  return request.kind === "file"
    ? Object.freeze({ path: request.path })
    : Object.freeze({ path: request.path, selection: {
      includePrefixes: [...request.selection.includePrefixes],
      excludePrefixes: [...request.selection.excludePrefixes],
    } });
}

export function targetRequestsDigest(targets) {
  return sha256(canonicalJson({ schemaId: "tiangong.target-requests.v1", targets }));
}

export function directorySelectionDigest(rootPath, selection) {
  return sha256(canonicalJson({
    schemaId: "tiangong.directory-selection.v1",
    rootPath,
    includePrefixes: selection.includePrefixes,
    excludePrefixes: selection.excludePrefixes,
  }));
}

export function targetSnapshotIdentity({ kind, descriptor, captureVersion, facts, artifacts }) {
  return sha256(canonicalJson({
    schemaId: "tiangong.target-snapshot.v1",
    snapshotSchemaVersion: 1,
    kind,
    descriptor,
    captureVersion,
    facts,
    artifacts: artifacts.map((binding) => binding.contentIdentity),
  }));
}

export function reviewScopeDigest(targets) {
  return sha256(canonicalJson({
    schemaId: "tiangong.review-scope.v2",
    targets: targets.map((target) => ({
      targetId: target.targetId,
      kind: target.kind,
      descriptor: target.descriptor,
      snapshotIdentity: target.snapshot.identity,
    })),
  }));
}

export function resourceSelectorDigest(targetId, memberPath) {
  return sha256(canonicalJson({
    schemaId: "tiangong.review-resource-selector.v1",
    targetId,
    memberPath,
  }));
}

function decodeText(buffer, code = "TARGET_TYPE_UNSUPPORTED") {
  for (const byte of buffer) {
    if ((byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)) || byte === 0x7f) {
      fail(code, "Target content is not supported UTF-8 review text");
    }
  }
  let text;
  try {
    text = UTF8.decode(buffer);
  } catch {
    fail(code, "Target content is not supported UTF-8 review text");
  }
  return Object.freeze({ text, lines: Object.freeze(text.split("\n")) });
}

export function maximalChunk(lines, offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > MAX_READ_LINES || offset > lines.length) {
    fail("TARGET_RANGE_INVALID", "Target consume range is invalid");
  }
  const maximumEnd = Math.min(lines.length, offset + limit - 1);
  let end = offset - 1;
  let bytes = 0;
  for (let line = offset; line <= maximumEnd; line += 1) {
    const addition = Buffer.byteLength(lines[line - 1], "utf8") + (line === offset ? 0 : 1);
    if (bytes + addition > MAX_RETURNED_BYTES) break;
    bytes += addition;
    end = line;
  }
  if (end < offset) fail("TARGET_LIMIT_EXCEEDED", "A target line exceeds the consume byte limit");
  return Object.freeze({
    lineStart: offset,
    lineEnd: end,
    bytes,
    text: lines.slice(offset - 1, end).join("\n"),
    truncated: end < lines.length,
  });
}

function requiredConsumeSegments(lines) {
  let offset = 1;
  let count = 0;
  while (offset <= lines.length) {
    const chunk = maximalChunk(lines, offset, Math.min(MAX_READ_LINES, lines.length - offset + 1));
    count += 1;
    if (count > MAX_CONSUME_SEGMENTS_PER_RESOURCE) {
      fail("TARGET_LIMIT_EXCEEDED", "Target requires too many consume segments");
    }
    offset = chunk.lineEnd + 1;
  }
  return count;
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function mapOsError(error, { changed = false } = {}) {
  if (error?.name === "PracticeRunError") throw error;
  if (changed) fail("TARGET_CHANGED_DURING_CAPTURE", "Target changed during stable capture");
  if (error?.code === "ENOENT") fail("TARGET_NOT_FOUND", "Target source was not found");
  if (["EACCES", "EPERM"].includes(error?.code)) fail("TARGET_UNAVAILABLE", "Target source is unavailable");
  if (error?.code === "ELOOP") fail("TARGET_SYMLINK_DENIED", "Target symbolic links are denied");
  fail("TARGET_UNAVAILABLE", "Target source is unavailable");
}

function mapPostAdmissionError(error) {
  if (error?.name === "PracticeRunError") {
    if (["TARGET_NOT_FOUND", "TARGET_UNAVAILABLE"].includes(error.code)) {
      fail("TARGET_UNAVAILABLE", "Target source is unavailable");
    }
    if ([
      "TARGET_SYMLINK_DENIED", "TARGET_TYPE_UNSUPPORTED", "TARGET_CHANGED_DURING_CAPTURE",
      "TARGET_SENSITIVE_PATH_DENIED", "TARGET_LIMIT_EXCEEDED",
    ].includes(error.code)) fail("TARGET_CHANGED", "Target source no longer matches its snapshot");
    throw error;
  }
  fail("TARGET_UNAVAILABLE", "Target source is unavailable");
}

async function boundedRead(handle) {
  const output = Buffer.alloc(MAX_MEMBER_BYTES + 1);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_MEMBER_BYTES) fail("TARGET_LIMIT_EXCEEDED", "Target content exceeds its fixed byte limit");
  return output.subarray(0, offset);
}

function statIdentity(value) {
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  });
}

function captureFacts(buffer) {
  const decoded = decodeText(buffer);
  return Object.freeze({
    buffer: Buffer.from(buffer),
    text: decoded.text,
    lines: decoded.lines,
    contentDigest: sha256(buffer),
    contentBytes: buffer.byteLength,
    contentLines: decoded.lines.length,
    encoding: "utf-8",
    requiredConsumeSegments: requiredConsumeSegments(decoded.lines),
  });
}

function contentFacts(value) {
  return Object.freeze({
    contentDigest: value.contentDigest,
    contentBytes: value.contentBytes,
    contentLines: value.contentLines,
    encoding: value.encoding,
    requiredConsumeSegments: value.requiredConsumeSegments,
  });
}

function contentFactsEqual(left, right) {
  return left.contentDigest === right.contentDigest && left.contentBytes === right.contentBytes
    && left.contentLines === right.contentLines && left.encoding === right.encoding
    && left.requiredConsumeSegments === right.requiredConsumeSegments;
}

function timestamp(clock) {
  const value = clock().toISOString();
  if (!RFC3339_MILLISECONDS.test(value)) fail("STATE_CORRUPTED", "Target capture clock is invalid");
  return value;
}

function artifactBinding(receipt) {
  return Object.freeze({
    artifactRef: receipt.artifactRef,
    artifactRefDigest: receipt.artifactRefDigest,
    artifactKey: receipt.artifactKey,
    storeBinding: Object.freeze({ ...receipt.binding }),
    ordinal: receipt.ordinal,
    encoding: receipt.encoding,
    contentIdentity: Object.freeze({
      purpose: receipt.purpose,
      contentDigest: receipt.contentDigest,
      contentBytes: receipt.contentBytes,
      contentLines: receipt.contentLines,
      mediaType: receipt.mediaType,
      truncated: receipt.truncated,
      producerId: receipt.producerId,
      producerVersion: receipt.producerVersion,
      transformVersion: receipt.transformVersion,
    }),
  });
}

export function expectedArtifactContentIdentity(binding) {
  return Object.freeze({
    ...binding.contentIdentity,
    ordinal: binding.ordinal,
    encoding: binding.encoding,
  });
}

export class ReviewTargetCapture {
  #artifactStore;
  #clock;
  #initialized = null;
  #rootIdentity = null;
  #workspaceDir;
  #workspaceRealpath = null;

  constructor({ workspaceDir, artifactStore, clock = () => new Date() }) {
    if (typeof workspaceDir !== "string" || workspaceDir === "" || !artifactStore || typeof clock !== "function") {
      throw new TypeError("ReviewTargetCapture dependencies are required");
    }
    this.#workspaceDir = resolve(workspaceDir);
    this.#artifactStore = artifactStore;
    this.#clock = clock;
  }

  get workspaceScope() {
    if (!this.#workspaceRealpath) throw new Error("Review target workspace is not initialized");
    return sha256(canonicalJson({ schemaId: "tiangong.workspace-scope.v1", workspaceRealpath: this.#workspaceRealpath }));
  }

  async initialize() {
    if (!this.#initialized) this.#initialized = this.#initialize();
    return this.#initialized;
  }

  async #initialize() {
    let lexical;
    try {
      lexical = await lstat(this.#workspaceDir, { bigint: true });
      if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error("workspace-root-invalid");
      this.#workspaceRealpath = await realpath(this.#workspaceDir);
      const rootHandle = await open(
        this.#workspaceRealpath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        this.#rootIdentity = statIdentity(await rootHandle.stat({ bigint: true }));
      } finally {
        await rootHandle.close();
      }
    } catch {
      fail("TARGET_UNAVAILABLE", "Trusted workspace root is unavailable");
    }
    return this;
  }

  async #verifyRoot({ changed = false } = {}) {
    try {
      const current = await stat(this.#workspaceRealpath, { bigint: true });
      const identity = statIdentity(current);
      if (this.#rootIdentity.dev !== identity.dev || this.#rootIdentity.ino !== identity.ino
          || (this.#rootIdentity.mode & BigInt(constants.S_IFMT)) !== (identity.mode & BigInt(constants.S_IFMT))) {
        if (changed) fail("TARGET_CHANGED_DURING_CAPTURE", "Workspace root changed during capture");
        fail("TARGET_UNAVAILABLE", "Trusted workspace root changed");
      }
    } catch (error) {
      mapOsError(error, { changed });
    }
  }

  async #openPath(relativePath, { directory = false, changed = false } = {}) {
    await this.initialize();
    await this.#verifyRoot({ changed });
    let parent;
    try {
      parent = await open(
        this.#workspaceRealpath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const root = statIdentity(await parent.stat({ bigint: true }));
      if (root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino) {
        await parent.close();
        fail(changed ? "TARGET_CHANGED_DURING_CAPTURE" : "TARGET_UNAVAILABLE", "Trusted workspace root changed");
      }
    } catch (error) {
      mapOsError(error, { changed });
    }
    if (relativePath === ".") {
      if (!directory) {
        await parent.close();
        fail("TARGET_TYPE_UNSUPPORTED", "Target source has an unsupported type");
      }
      return Object.freeze({ handle: parent, owned: true, stat: this.#rootIdentity });
    }
    let parentOwned = true;
    const segments = relativePath.split("/");
    try {
      for (let index = 0; index < segments.length; index += 1) {
        const final = index === segments.length - 1;
        const candidate = `/proc/self/fd/${parent.fd}/${segments[index]}`;
        let before;
        try {
          before = await lstat(candidate, { bigint: true });
        } catch (error) {
          mapOsError(error, { changed });
        }
        if (before.isSymbolicLink()) {
          if (changed) fail("TARGET_CHANGED_DURING_CAPTURE", "Target changed during stable capture");
          fail("TARGET_SYMLINK_DENIED", "Target symbolic links are denied");
        }
        const needDirectory = !final || directory;
        if (needDirectory && !before.isDirectory()) {
          if (changed) fail("TARGET_CHANGED_DURING_CAPTURE", "Target changed during stable capture");
          fail("TARGET_TYPE_UNSUPPORTED", "Target path component has an unsupported type");
        }
        let child;
        try {
          child = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            | (needDirectory ? constants.O_DIRECTORY : 0));
        } catch (error) {
          mapOsError(error, { changed });
        }
        const after = await child.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) {
          await child.close();
          if (changed) fail("TARGET_CHANGED_DURING_CAPTURE", "Target changed during stable capture");
          fail("TARGET_CHANGED_DURING_CAPTURE", "Target changed during stable capture");
        }
        if (needDirectory && !after.isDirectory()) {
          await child.close();
          fail("TARGET_TYPE_UNSUPPORTED", "Target source has an unsupported type");
        }
        if (parentOwned) await parent.close();
        parent = child;
        parentOwned = true;
      }
      return Object.freeze({ handle: parent, owned: parentOwned, stat: statIdentity(await parent.stat({ bigint: true })) });
    } catch (error) {
      if (parentOwned) await parent.close().catch(() => {});
      throw error;
    }
  }

  async #captureFile(relativePath, { changed = false, postAdmission = false } = {}) {
    let opened;
    try {
      opened = await this.#openPath(relativePath, { changed });
      const handle = opened.handle;
      const a = statIdentity(await handle.stat({ bigint: true }));
      if ((a.mode & BigInt(constants.S_IFMT)) !== BigInt(constants.S_IFREG) || a.nlink !== 1n) {
        fail("TARGET_TYPE_UNSUPPORTED", "Target source must be an unlinked ordinary file");
      }
      if (a.size > BigInt(MAX_MEMBER_BYTES)) fail("TARGET_LIMIT_EXCEEDED", "Target content exceeds its fixed byte limit");
      const bufferA = await boundedRead(handle);
      const b = statIdentity(await handle.stat({ bigint: true }));
      const bufferB = await boundedRead(handle);
      const c = statIdentity(await handle.stat({ bigint: true }));
      if (!sameStat(a, b) || !sameStat(b, c) || BigInt(bufferA.byteLength) !== a.size
          || !bufferA.equals(bufferB)) {
        fail("TARGET_CHANGED_DURING_CAPTURE", "Target changed during stable capture");
      }
      const reopened = await this.#openPath(relativePath, { changed: true });
      try {
        const final = statIdentity(await reopened.handle.stat({ bigint: true }));
        if (final.dev !== a.dev || final.ino !== a.ino || final.mode !== a.mode) {
          fail("TARGET_CHANGED_DURING_CAPTURE", "Target changed during stable capture");
        }
      } finally {
        if (reopened.owned) await reopened.handle.close();
      }
      return Object.freeze({ ...captureFacts(bufferA), identity: a });
    } catch (error) {
      if (postAdmission) mapPostAdmissionError(error);
      throw error;
    } finally {
      if (opened?.owned) await opened.handle.close().catch(() => {});
    }
  }

  #selected(path, selection) {
    return selection.includePrefixes.some((prefix) => pathIsWithin(path, prefix))
      && !selection.excludePrefixes.some((prefix) => pathIsWithin(path, prefix));
  }

  #traverse(path, selection) {
    return !selection.excludePrefixes.some((prefix) => pathIsWithin(path, prefix))
      && selection.includePrefixes.some((prefix) => pathIsWithin(path, prefix) || pathIsAncestor(path, prefix));
  }

  async #discover(rootPath, selection, { changed = false, observedPaths = new Set() } = {}) {
    const directories = [];
    const members = [];
    const foundIncludes = new Set(selection.includePrefixes.filter((prefix) => prefix === "."));
    const walk = async (relativeToTarget) => {
      const workspacePath = relativeToTarget === "." ? rootPath
        : rootPath === "." ? relativeToTarget : `${rootPath}/${relativeToTarget}`;
      const opened = await this.#openPath(workspacePath, { directory: true, changed });
      try {
        const directoryIdentity = statIdentity(await opened.handle.stat({ bigint: true }));
        directories.push(Object.freeze({ path: relativeToTarget, identity: directoryIdentity }));
        let entries;
        try {
          entries = await readdir(`/proc/self/fd/${opened.handle.fd}`, { encoding: "buffer", withFileTypes: true });
        } catch (error) {
          mapOsError(error, { changed });
        }
        const decoded = entries.map((entry) => {
          const raw = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, "utf8");
          let name;
          try {
            name = UTF8.decode(raw);
          } catch {
            fail("TARGET_TYPE_UNSUPPORTED", "Traversed directory contains an unsupported entry name");
          }
          if (!Buffer.from(name, "utf8").equals(raw) || name === "." || name === ".." || name.includes("/")) {
            fail("TARGET_TYPE_UNSUPPORTED", "Traversed directory contains an unsupported entry name");
          }
          return { raw, name };
        }).sort((left, right) => Buffer.compare(left.raw, right.raw));
        for (const entry of decoded) {
          const memberPath = relativeToTarget === "." ? entry.name : `${relativeToTarget}/${entry.name}`;
          if (Buffer.byteLength(memberPath, "utf8") > MAX_PATH_BYTES) {
            fail("TARGET_LIMIT_EXCEEDED", "Directory member path exceeds its fixed byte limit");
          }
          const fullPath = rootPath === "." ? memberPath : `${rootPath}/${memberPath}`;
          if (Buffer.byteLength(fullPath, "utf8") > MAX_PATH_BYTES) {
            fail("TARGET_LIMIT_EXCEEDED", "Workspace member path exceeds its fixed byte limit");
          }
          const selected = this.#selected(memberPath, selection);
          const traverse = this.#traverse(memberPath, selection);
          if (!selected && !traverse) continue;
          if (selection.excludePrefixes.some((prefix) => pathIsWithin(memberPath, prefix))) continue;
          if (selected || traverse) {
            for (const prefix of selection.includePrefixes) {
              if (memberPath === prefix) foundIncludes.add(prefix);
            }
          }
          if (selected) assertNotSensitive(fullPath);
          const candidate = `/proc/self/fd/${opened.handle.fd}/${entry.name}`;
          let child;
          try {
            child = await lstat(candidate, { bigint: true });
          } catch (error) {
            mapOsError(error, { changed });
          }
          if (child.isSymbolicLink()) {
            if (changed && observedPaths.has(memberPath)) {
              fail("TARGET_CHANGED_DURING_CAPTURE", "Directory changed during capture");
            }
            fail("TARGET_SYMLINK_DENIED", "Selected symbolic links are denied");
          }
          if (child.isDirectory()) {
            if (traverse) await walk(memberPath);
          } else if (child.isFile()) {
            if (selected) {
              if (child.nlink !== 1n) fail("TARGET_TYPE_UNSUPPORTED", "Selected hardlinks are unsupported");
              members.push(Object.freeze({ path: memberPath, identity: statIdentity(child) }));
              if (members.length > MAX_DIRECTORY_MEMBERS) fail("TARGET_LIMIT_EXCEEDED", "Directory has too many selected members");
            }
          } else if (selected || traverse) {
            fail("TARGET_TYPE_UNSUPPORTED", "Selected directory entry type is unsupported");
          }
        }
      } finally {
        if (opened.owned) await opened.handle.close();
      }
    };
    await walk(".");
    const missing = selection.includePrefixes.find((prefix) => !foundIncludes.has(prefix));
    if (missing) {
      if (changed) fail("TARGET_CHANGED_DURING_CAPTURE", "Directory selection changed during capture");
      fail("TARGET_NOT_FOUND", "A required include prefix was not found");
    }
    members.sort((left, right) => utf8Compare(left.path, right.path));
    if (members.length === 0) fail("TARGET_EMPTY", "Directory selection contains no reviewable members");
    return Object.freeze({ directories: Object.freeze(directories), members: Object.freeze(members) });
  }

  async #directoryPass(rootPath, selection, { changed = false, observedPaths = new Set() } = {}) {
    const discovery = await this.#discover(rootPath, selection, { changed, observedPaths });
    const members = [];
    let totalContentBytes = 0;
    let totalSegments = 0;
    for (const discovered of discovery.members) {
      const fullPath = rootPath === "." ? discovered.path : `${rootPath}/${discovered.path}`;
      const captured = await this.#captureFile(fullPath, { changed });
      if (captured.identity.dev !== discovered.identity.dev || captured.identity.ino !== discovered.identity.ino) {
        fail("TARGET_CHANGED_DURING_CAPTURE", "Directory member changed between discovery and capture");
      }
      totalContentBytes += captured.contentBytes;
      totalSegments += captured.requiredConsumeSegments;
      if (totalContentBytes > MAX_RUN_TARGET_CONTENT_BYTES || totalSegments > MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN) {
        fail("TARGET_LIMIT_EXCEEDED", "Directory target exceeds its aggregate capture limit");
      }
      members.push(Object.freeze({ path: discovered.path, identity: captured.identity, ...contentFacts(captured) }));
    }
    return Object.freeze({
      directories: discovery.directories,
      members: Object.freeze(members),
      totalContentBytes,
      requiredConsumeSegments: totalSegments,
    });
  }

  async #captureDirectory(request) {
    const a = await this.#directoryPass(request.path, request.selection);
    const observedPaths = new Set([
      ...a.directories.map((entry) => entry.path),
      ...a.members.map((entry) => entry.path),
    ]);
    const b = await this.#directoryPass(request.path, request.selection, { changed: true, observedPaths });
    if (a.directories.length !== b.directories.length || a.members.length !== b.members.length) {
      fail("TARGET_CHANGED_DURING_CAPTURE", "Directory changed between capture passes");
    }
    for (let index = 0; index < a.directories.length; index += 1) {
      if (a.directories[index].path !== b.directories[index].path
          || !sameStat(a.directories[index].identity, b.directories[index].identity)) {
        fail("TARGET_CHANGED_DURING_CAPTURE", "Directory changed between capture passes");
      }
    }
    for (let index = 0; index < a.members.length; index += 1) {
      if (a.members[index].path !== b.members[index].path
          || a.members[index].identity.dev !== b.members[index].identity.dev
          || a.members[index].identity.ino !== b.members[index].identity.ino
          || !contentFactsEqual(a.members[index], b.members[index])) {
        fail("TARGET_CHANGED_DURING_CAPTURE", "Directory member changed between capture passes");
      }
    }
    return a;
  }

  async captureTargets({ requests, runId, targetIds, actorId, invocationIdentity, sourceOperationDigest }) {
    await this.initialize();
    if (!Array.isArray(requests) || requests.length !== targetIds.length || !runId || !actorId) {
      throw new TypeError("Capture target identities are required");
    }
    const targets = [];
    let totalContentBytes = 0;
    let totalSegments = 0;
    let totalManifestBytes = 0;
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const targetId = targetIds[index];
      const descriptor = Object.freeze({ schemaVersion: 1, source: "model_normalized", value: descriptorValue(request) });
      let facts;
      let artifacts = [];
      let captureVersion;
      if (request.kind === "file") {
        const captured = await this.#captureFile(request.path);
        facts = contentFacts(captured);
        captureVersion = "review-file-snapshot-v1";
        totalContentBytes += captured.contentBytes;
        totalSegments += captured.requiredConsumeSegments;
      } else {
        const captured = await this.#captureDirectory(request);
        const selectionDigest = directorySelectionDigest(request.path, request.selection);
        const manifest = {
          schemaVersion: 1,
          kind: "directory-manifest",
          rootPath: request.path,
          selectionDigest,
          members: captured.members.map((member) => ({
            path: member.path,
            contentDigest: member.contentDigest,
            contentBytes: member.contentBytes,
            contentLines: member.contentLines,
            encoding: member.encoding,
            requiredConsumeSegments: member.requiredConsumeSegments,
          })),
        };
        const bytes = Buffer.from(canonicalJson(manifest), "utf8");
        if (bytes.byteLength > MAX_DIRECTORY_MANIFEST_BYTES) {
          fail("TARGET_LIMIT_EXCEEDED", "Directory manifest exceeds its fixed byte limit");
        }
        let receipt;
        try {
          receipt = await this.#artifactStore.put({
            binding: {
              kind: "practice_target",
              sessionHash: this.#artifactStore.sessionHash,
              actorId,
              practiceRunId: runId,
              targetId,
              invocationIdentity,
              sourceOperationDigest,
            },
            purpose: "directory_manifest",
            ordinal: 0,
            mediaType: "application/vnd.tiangong.directory-manifest+json;version=1",
            encoding: "utf-8",
            truncated: false,
            producerId: "review-directory-capture",
            producerVersion: 1,
            transformVersion: 1,
            canonicalBytes: bytes,
          });
        } catch (error) {
          this.#mapArtifactError(error);
        }
        artifacts = [artifactBinding(receipt)];
        facts = Object.freeze({
          memberCount: manifest.members.length,
          totalContentBytes: captured.totalContentBytes,
          requiredConsumeSegments: captured.requiredConsumeSegments,
          selectionDigest,
          manifestContentDigest: sha256(bytes),
        });
        captureVersion = "review-directory-snapshot-v1";
        totalContentBytes += captured.totalContentBytes;
        totalSegments += captured.requiredConsumeSegments;
        totalManifestBytes += bytes.byteLength;
      }
      if (totalContentBytes > MAX_RUN_TARGET_CONTENT_BYTES || totalSegments > MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN
          || totalManifestBytes > MAX_RUN_DIRECTORY_MANIFEST_BYTES) {
        fail("CAPTURE_LIMIT_EXCEEDED", "Final target scope exceeds its aggregate capture budget");
      }
      const identity = targetSnapshotIdentity({ kind: request.kind, descriptor, captureVersion, facts, artifacts });
      targets.push(Object.freeze({
        targetId,
        kind: request.kind,
        descriptor,
        snapshot: Object.freeze({
          schemaVersion: 1,
          source: "runtime_captured",
          captureVersion,
          identity,
          capturedAt: timestamp(this.#clock),
          facts,
          artifacts: Object.freeze(artifacts),
        }),
      }));
    }
    return Object.freeze(targets);
  }

  async readDirectoryManifest(target) {
    if (target?.kind !== "directory_snapshot" || target.snapshot?.artifacts?.length !== 1) {
      fail("TARGET_ARTIFACT_INVALID", "Directory target artifact binding is invalid");
    }
    const binding = target.snapshot.artifacts[0];
    let read;
    try {
      read = await this.#artifactStore.readFromJournal({
        artifactKey: binding.artifactKey,
        artifactRef: binding.artifactRef,
        artifactRefDigest: binding.artifactRefDigest,
        expectedBinding: binding.storeBinding,
        expectedContentIdentity: expectedArtifactContentIdentity(binding),
      });
    } catch (error) {
      if (isCapturedArtifactError(error)) fail("TARGET_ARTIFACT_INVALID", "Directory manifest artifact is unavailable or invalid");
      throw error;
    }
    let manifest;
    try {
      manifest = JSON.parse(read.bytes.toString("utf8"));
    } catch {
      fail("TARGET_ARTIFACT_INVALID", "Directory manifest artifact is invalid");
    }
    if (sha256(read.bytes) !== target.snapshot.facts.manifestContentDigest
        || manifest.selectionDigest !== target.snapshot.facts.selectionDigest
        || manifest.rootPath !== target.descriptor.value.path
        || manifest.members.length !== target.snapshot.facts.memberCount
        || manifest.members.reduce((sum, member) => sum + member.contentBytes, 0) !== target.snapshot.facts.totalContentBytes
        || manifest.members.reduce((sum, member) => sum + member.requiredConsumeSegments, 0)
          !== target.snapshot.facts.requiredConsumeSegments) {
      fail("TARGET_ARTIFACT_INVALID", "Directory manifest conflicts with its target snapshot");
    }
    return Object.freeze(manifest);
  }

  async captureResource(target, memberPath) {
    if (target.kind === "file") {
      if (memberPath !== null) fail("TARGET_KIND_MISMATCH", "File target does not accept memberPath");
      const captured = await this.#captureFile(target.descriptor.value.path, { postAdmission: true });
      if (!contentFactsEqual(captured, target.snapshot.facts)) {
        fail("TARGET_CHANGED", "Target source no longer matches its snapshot");
      }
      return Object.freeze({ memberPath: null, ...captured });
    }
    if (target.kind !== "directory_snapshot" || typeof memberPath !== "string") {
      fail("TARGET_KIND_MISMATCH", "Directory target requires memberPath");
    }
    const manifest = await this.readDirectoryManifest(target);
    const member = manifest.members.find((entry) => entry.path === memberPath);
    if (!member) fail("TARGET_MEMBER_NOT_FOUND", "Directory member is not in the target manifest");
    const root = target.descriptor.value.path;
    const fullPath = root === "." ? member.path : `${root}/${member.path}`;
    const captured = await this.#captureFile(fullPath, { postAdmission: true });
    if (!contentFactsEqual(captured, member)) fail("TARGET_CHANGED", "Directory member no longer matches its snapshot");
    return Object.freeze({ memberPath, ...captured });
  }

  #mapArtifactError(error) {
    if (!isCapturedArtifactError(error)) throw error;
    if (["ARTIFACT_LIMIT_EXCEEDED", "ARTIFACT_PRODUCER_NOT_ALLOWED", "ARTIFACT_METADATA_INVALID"].includes(error.code)) {
      fail("TARGET_LIMIT_EXCEEDED", "Captured target artifact violates its fixed producer limit");
    }
    if (error.code === "ARTIFACT_QUOTA_EXCEEDED") {
      fail("CAPTURE_LIMIT_EXCEEDED", "Captured target artifacts exceed their aggregate quota");
    }
    fail("TARGET_UNAVAILABLE", "Captured target artifact storage is unavailable");
  }
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("STATE_CORRUPTED", `${name} is invalid`);
}

function validateJournalArtifact(binding, { sessionHash, actorId, runId, targetId }) {
  if (!exact(binding, [
    "artifactRef", "artifactRefDigest", "artifactKey", "storeBinding", "ordinal", "encoding", "contentIdentity",
  ]) || !ARTIFACT_REF_PATTERN.test(binding.artifactRef) || !DIGEST.test(binding.artifactRefDigest)
      || !DIGEST.test(binding.artifactKey) || binding.ordinal !== 0 || binding.encoding !== "utf-8"
      || !exact(binding.storeBinding, [
        "actorId", "invocationIdentity", "kind", "practiceRunId", "sessionHash", "sourceOperationDigest", "targetId",
      ]) || binding.storeBinding.kind !== "practice_target" || binding.storeBinding.sessionHash !== sessionHash
      || binding.storeBinding.actorId !== actorId || binding.storeBinding.practiceRunId !== runId
      || binding.storeBinding.targetId !== targetId || !DIGEST.test(binding.storeBinding.invocationIdentity)
      || !DIGEST.test(binding.storeBinding.sourceOperationDigest)
      || !exact(binding.contentIdentity, [
        "purpose", "contentDigest", "contentBytes", "contentLines", "mediaType", "truncated",
        "producerId", "producerVersion", "transformVersion",
      ]) || binding.contentIdentity.purpose !== "directory_manifest"
      || !DIGEST.test(binding.contentIdentity.contentDigest)
      || !Number.isSafeInteger(binding.contentIdentity.contentBytes) || binding.contentIdentity.contentBytes < 0
      || binding.contentIdentity.contentBytes > MAX_DIRECTORY_MANIFEST_BYTES
      || binding.contentIdentity.contentLines !== 1
      || binding.contentIdentity.mediaType !== "application/vnd.tiangong.directory-manifest+json;version=1"
      || binding.contentIdentity.truncated !== false || binding.contentIdentity.producerId !== "review-directory-capture"
      || binding.contentIdentity.producerVersion !== 1 || binding.contentIdentity.transformVersion !== 1) {
    fail("STATE_CORRUPTED", "Target artifact binding is invalid");
  }
  if (deriveArtifactKey({ binding: binding.storeBinding, purpose: binding.contentIdentity.purpose, ordinal: binding.ordinal })
      !== binding.artifactKey || deriveArtifactRefDigest({ sessionHash, artifactRef: binding.artifactRef })
      !== binding.artifactRefDigest) {
    fail("STATE_CORRUPTED", "Target artifact identity is invalid");
  }
}

export function validateMaterializedTarget(target, context) {
  if (!exact(target, ["targetId", "kind", "descriptor", "snapshot"]) || !TARGET_ID_PATTERN.test(target.targetId)
      || !MATERIALIZED_TARGET_KINDS.includes(target.kind)
      || !exact(target.descriptor, ["schemaVersion", "source", "value"])
      || target.descriptor.schemaVersion !== 1 || target.descriptor.source !== "model_normalized"
      || !exact(target.snapshot, [
        "schemaVersion", "source", "captureVersion", "identity", "capturedAt", "facts", "artifacts",
      ]) || target.snapshot.schemaVersion !== 1 || target.snapshot.source !== "runtime_captured"
      || !RFC3339_MILLISECONDS.test(target.snapshot.capturedAt)
      || new Date(target.snapshot.capturedAt).toISOString() !== target.snapshot.capturedAt
      || !Array.isArray(target.snapshot.artifacts)) {
    fail("STATE_CORRUPTED", "Materialized target schema is invalid");
  }
  assertDigest(target.snapshot.identity, "target snapshot identity");
  let normalized;
  try {
    normalized = normalizeTargetRequests([{ kind: target.kind, ...target.descriptor.value }]);
  } catch {
    fail("STATE_CORRUPTED", "Materialized target descriptor is invalid");
  }
  if (canonicalJson(descriptorValue(normalized[0])) !== canonicalJson(target.descriptor.value)) {
    fail("STATE_CORRUPTED", "Materialized target descriptor is not canonical");
  }
  if (target.kind === "file") {
    if (target.snapshot.captureVersion !== "review-file-snapshot-v1" || target.snapshot.artifacts.length !== 0
        || !exact(target.snapshot.facts, [
          "contentDigest", "contentBytes", "contentLines", "encoding", "requiredConsumeSegments",
        ]) || !DIGEST.test(target.snapshot.facts.contentDigest)
        || !Number.isSafeInteger(target.snapshot.facts.contentBytes) || target.snapshot.facts.contentBytes < 0
        || target.snapshot.facts.contentBytes > MAX_MEMBER_BYTES
        || !Number.isSafeInteger(target.snapshot.facts.contentLines) || target.snapshot.facts.contentLines < 1
        || target.snapshot.facts.encoding !== "utf-8"
        || !Number.isSafeInteger(target.snapshot.facts.requiredConsumeSegments)
        || target.snapshot.facts.requiredConsumeSegments < 1
        || target.snapshot.facts.requiredConsumeSegments > MAX_CONSUME_SEGMENTS_PER_RESOURCE) {
      fail("STATE_CORRUPTED", "File target snapshot facts are invalid");
    }
  } else {
    if (target.snapshot.captureVersion !== "review-directory-snapshot-v1" || target.snapshot.artifacts.length !== 1
        || !exact(target.snapshot.facts, [
          "memberCount", "totalContentBytes", "requiredConsumeSegments", "selectionDigest", "manifestContentDigest",
        ]) || !Number.isSafeInteger(target.snapshot.facts.memberCount) || target.snapshot.facts.memberCount < 1
        || target.snapshot.facts.memberCount > MAX_DIRECTORY_MEMBERS
        || !Number.isSafeInteger(target.snapshot.facts.totalContentBytes) || target.snapshot.facts.totalContentBytes < 0
        || target.snapshot.facts.totalContentBytes > MAX_RUN_TARGET_CONTENT_BYTES
        || !Number.isSafeInteger(target.snapshot.facts.requiredConsumeSegments)
        || target.snapshot.facts.requiredConsumeSegments < target.snapshot.facts.memberCount
        || target.snapshot.facts.requiredConsumeSegments > MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN
        || !DIGEST.test(target.snapshot.facts.selectionDigest) || !DIGEST.test(target.snapshot.facts.manifestContentDigest)
        || target.snapshot.facts.selectionDigest !== directorySelectionDigest(
          target.descriptor.value.path,
          target.descriptor.value.selection,
        )) {
      fail("STATE_CORRUPTED", "Directory target snapshot facts are invalid");
    }
    validateJournalArtifact(target.snapshot.artifacts[0], { ...context, targetId: target.targetId });
    if (target.snapshot.artifacts[0].contentIdentity.contentDigest !== target.snapshot.facts.manifestContentDigest) {
      fail("STATE_CORRUPTED", "Directory target manifest digest conflicts with its facts");
    }
  }
  const expectedIdentity = targetSnapshotIdentity({
    kind: target.kind,
    descriptor: target.descriptor,
    captureVersion: target.snapshot.captureVersion,
    facts: target.snapshot.facts,
    artifacts: target.snapshot.artifacts,
  });
  if (expectedIdentity !== target.snapshot.identity) fail("STATE_CORRUPTED", "Target snapshot identity mismatch");
  return target;
}

export function validateReviewScope(scope, context) {
  if (!exact(scope, ["digest", "revision", "targets"]) || !Number.isSafeInteger(scope.revision)
      || scope.revision < 1 || !Array.isArray(scope.targets) || scope.targets.length < 1
      || scope.targets.length > MAX_SCOPE_TARGETS) fail("STATE_CORRUPTED", "Review target scope is invalid");
  const ids = new Set();
  const snapshots = new Set();
  for (const target of scope.targets) {
    validateMaterializedTarget(target, context);
    if (ids.has(target.targetId)) fail("STATE_CORRUPTED", "Review target IDs are duplicated");
    ids.add(target.targetId);
    const identity = canonicalJson({ kind: target.kind, descriptor: target.descriptor, snapshot: target.snapshot.identity });
    if (snapshots.has(identity)) fail("STATE_CORRUPTED", "Review scope contains a duplicate snapshot");
    snapshots.add(identity);
  }
  assertDigest(scope.digest, "scope digest");
  if (scope.digest !== reviewScopeDigest(scope.targets)) fail("STATE_CORRUPTED", "Review scope digest mismatch");
  try {
    assertFinalScopeFeasible(scope.targets);
  } catch {
    fail("STATE_CORRUPTED", "Review scope exceeds its aggregate feasibility limits");
  }
  return scope;
}

export function findTarget(run, targetId) {
  if (!TARGET_ID_PATTERN.test(targetId)) fail("INVALID_TARGET", "targetId is invalid");
  const target = run.scope.targets.find((entry) => entry.targetId === targetId);
  if (!target) fail("TARGET_NOT_FOUND", "Target is not in the active PracticeRun");
  return target;
}

export function normalizeMemberPath(value) {
  try {
    return normalizeRelativePath(value, { sensitive: false });
  } catch (error) {
    if (error?.code === "TARGET_LIMIT_EXCEEDED") {
      fail("TARGET_SELECTOR_INVALID", "Directory member path exceeds its selector limit");
    }
    throw error;
  }
}

export function assertFinalScopeFeasible(targets) {
  const contentBytes = targets.reduce((sum, target) => sum + (target.kind === "file"
    ? target.snapshot.facts.contentBytes : target.snapshot.facts.totalContentBytes), 0);
  const segments = targets.reduce((sum, target) => sum + target.snapshot.facts.requiredConsumeSegments, 0);
  const manifestBytes = targets.reduce((sum, target) => sum + (target.kind === "directory_snapshot"
    ? target.snapshot.artifacts[0].contentIdentity.contentBytes : 0), 0);
  if (targets.length > MAX_SCOPE_TARGETS || contentBytes > MAX_RUN_TARGET_CONTENT_BYTES
      || segments > MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN || manifestBytes > MAX_RUN_DIRECTORY_MANIFEST_BYTES) {
    fail("CAPTURE_LIMIT_EXCEEDED", "Final target scope exceeds its aggregate capture budget");
  }
}
