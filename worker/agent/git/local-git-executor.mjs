import { createHash, randomUUID } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import {
  ARTIFACT_LOCK_TIMEOUT_SECONDS,
  withKernelFileLock,
} from "../persistence/kernel-file-lock.mjs";
import { practiceRunFail } from "../practices/errors.mjs";

export const GIT_POLICY_VERSION = "review-local-git-v1";
export const GIT_ARGV_SCHEMA_VERSION = "review-local-git-argv-v1";
export const GIT_RUNTIME_VERSION = "2.43.0";
export const MAX_GIT_COMMIT_MEMBERS = 256;
export const MAX_GIT_CHANGED_PATHS = 256;
export const MAX_GIT_DIFF_BYTES = 4 * 1024 * 1024;
export const MAX_GIT_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_GIT_TARGETS_PER_ADMISSION = 4;
export const MAX_GIT_TARGETS_PER_RUN = 16;

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PACKED_REFS_BYTES = 4 * 1024 * 1024;
const MAX_PACK_PAIRS = 16;
const MAX_PACK_ENTRIES = 96;
const MAX_PACK_MIRROR_BYTES = 64 * 1024 * 1024;
const MAX_IGNORED_PACK_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_IGNORED_PACK_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_KEEP_BYTES = 4 * 1024;
const MAX_LOOSE_MIRROR_BYTES = 40 * 1024 * 1024;
const MAX_SANDBOX_BYTES = 128 * 1024 * 1024;
const MAX_COMMIT_OBJECT_BYTES = 1024 * 1024;
const MAX_TAG_OBJECT_BYTES = 1024 * 1024;
const MAX_TREE_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_TREE_OBJECTS = 1024;
const MAX_TREE_ENTRY_VISITS = 8192;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_COMMIT_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ATTRIBUTE_BYTES = 1024 * 1024;
const MAX_CHILDREN = 16;
const MAX_OBJECT_REQUESTS = 8192;
const MAX_BATCH_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const SHORT_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 60_000;
const MAX_TAG_DEPTH = 8;
const MAX_TEMP_RESIDUE = 8;
const EMPTY_OID_SHA1 = "0".repeat(40);
const EMPTY_OID_SHA256 = "0".repeat(64);
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const SAFE_DIFF_PATH = /^(?!-)(?!\.\.?$)[A-Za-z0-9._@+-]+(?:\/(?!-)(?!\.\.?$)[A-Za-z0-9._@+-]+)*$/u;
const SENSITIVE_EXACT = new Set([
  ".tiangong", ".env", "auth.json", "credentials", "credentials.json",
  "id_ed25519", "id_rsa", "openclaw.json",
]);
const PRLIMIT_PREFIX = Object.freeze([
  "--as=268435456", "--core=0", "--cpu=65", "--fsize=0", "--nofile=64", "--", "/usr/bin/git",
]);
const GIT_GLOBAL_PREFIX = Object.freeze([
  "--no-pager",
  "--no-replace-objects",
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c", "color.ui=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.commitGraph=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.multiPackIndex=false",
  "-c", "credential.helper=",
  "-c", "diff.external=",
  "-c", "diff.renames=false",
  "-c", "pager.diff=false",
  "-c", "protocol.allow=never",
  "-c", "submodule.recurse=false",
]);

function fail(code, message) {
  practiceRunFail(code, message);
}

function exactMode(value, mode) {
  return (value.mode & 0o7777) === mode;
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameStableFile(left, right) {
  return sameNode(left, right) && left.nlink === right.nlink && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sensitivePath(path) {
  return path.split("/").some((segment) => {
    const lower = segment.toLowerCase();
    return SENSITIVE_EXACT.has(lower) || lower.startsWith(".env.")
      || lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12");
  });
}

function pathWithin(path, prefix) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function prefixIntersects(path, prefixes) {
  return prefixes.some((prefix) => prefix === "." || pathWithin(path, prefix) || pathWithin(prefix, path));
}

function selectedPath(path, prefixes) {
  return prefixes.some((prefix) => pathWithin(path, prefix));
}

function validGitMemberPath(path) {
  return typeof path === "string" && path !== "" && !path.startsWith("-") && !path.startsWith(":")
    && !path.includes("\\") && !/[\x00-\x1f\x7f]/u.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function decodeReviewText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("TARGET_TYPE_UNSUPPORTED", "Git object content BOM is not supported review text");
  }
  for (const byte of bytes) {
    if ((byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)) || byte === 0x7f) {
      fail("TARGET_TYPE_UNSUPPORTED", "Git object content is not supported review text");
    }
  }
  try {
    const text = UTF8.decode(bytes);
    return Object.freeze({ text, lines: Object.freeze(text.split("\n")) });
  } catch {
    fail("TARGET_TYPE_UNSUPPORTED", "Git object content is not valid UTF-8 review text");
  }
}

function requiredSegments(lines) {
  let next = 1;
  let segments = 0;
  while (next <= lines.length) {
    const requestedEnd = Math.min(lines.length, next + 1999);
    let returnedEnd = next - 1;
    let bytes = 0;
    for (let line = next; line <= requestedEnd; line += 1) {
      const addition = Buffer.byteLength(lines[line - 1], "utf8") + (line === next ? 0 : 1);
      if (bytes + addition > 50 * 1024) break;
      bytes += addition;
      returnedEnd = line;
    }
    if (returnedEnd < next) fail("TARGET_LIMIT_EXCEEDED", "Git resource contains an unconsumable logical line");
    segments += 1;
    if (segments > 128) fail("TARGET_LIMIT_EXCEEDED", "Git resource requires too many consume segments");
    next = returnedEnd + 1;
  }
  return segments;
}

function contentFacts(bytes) {
  const decoded = decodeReviewText(bytes);
  return Object.freeze({
    buffer: Buffer.from(bytes),
    text: decoded.text,
    lines: decoded.lines,
    contentDigest: sha256(bytes),
    contentBytes: bytes.byteLength,
    contentLines: decoded.lines.length,
    encoding: "utf-8",
    requiredConsumeSegments: requiredSegments(decoded.lines),
  });
}

function strictAscii(bytes, code, message) {
  if ([...bytes].some((byte) => byte > 0x7f)) fail(code, message);
  return bytes.toString("ascii");
}

function strictUtf8(bytes, code, message) {
  try { return UTF8.decode(bytes); }
  catch { fail(code, message); }
}

function objectHash(type, bytes, objectFormat) {
  const algorithm = objectFormat === "sha1" ? "sha1" : "sha256";
  return createHash(algorithm)
    .update(Buffer.from(`${type} ${bytes.byteLength}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

function oidPattern(objectFormat) {
  return objectFormat === "sha1" ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
}

function zeroOid(objectFormat) {
  return objectFormat === "sha1" ? EMPTY_OID_SHA1 : EMPTY_OID_SHA256;
}

function assertOid(oid, objectFormat, code = "TARGET_ARTIFACT_INVALID") {
  if (typeof oid !== "string" || !oidPattern(objectFormat).test(oid)) fail(code, "Git object identity is invalid");
  return oid;
}

function parseHeaderBlock(bytes, kind, objectFormat) {
  const separator = bytes.indexOf(Buffer.from("\n\n"));
  if (separator < 0) fail("TARGET_ARTIFACT_INVALID", `Git ${kind} header is invalid`);
  const header = bytes.subarray(0, separator);
  if (header.includes(0) || header.includes(0x0d)) fail("TARGET_ARTIFACT_INVALID", `Git ${kind} header is invalid`);
  const lines = strictUtf8(header, "TARGET_ARTIFACT_INVALID", `Git ${kind} header is invalid`).split("\n");
  if (kind === "commit") {
    const trees = lines.filter((line) => line.startsWith("tree "));
    if (trees.length !== 1) fail("TARGET_ARTIFACT_INVALID", "Git commit tree header is invalid");
    return Object.freeze({ treeOid: assertOid(trees[0].slice(5), objectFormat) });
  }
  const objects = lines.filter((line) => line.startsWith("object "));
  const types = lines.filter((line) => line.startsWith("type "));
  if (objects.length !== 1 || types.length !== 1 || !["tag", "commit"].includes(types[0].slice(5))) {
    fail("TARGET_ARTIFACT_INVALID", "Git tag header is invalid");
  }
  return Object.freeze({ objectOid: assertOid(objects[0].slice(7), objectFormat), objectType: types[0].slice(5) });
}

function parseTree(bytes, objectFormat) {
  const oidBytes = objectFormat === "sha1" ? 20 : 32;
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 1 + oidBytes > bytes.length) {
      fail("TARGET_ARTIFACT_INVALID", "Git tree object framing is invalid");
    }
    const mode = strictAscii(
      bytes.subarray(offset, space),
      "TARGET_ARTIFACT_INVALID",
      "Git tree object mode is invalid",
    );
    if (!["40000", "100644", "100755", "120000", "160000"].includes(mode)) {
      fail("TARGET_ARTIFACT_INVALID", "Git tree object mode is invalid");
    }
    const nameBytes = bytes.subarray(space + 1, nul);
    if (nameBytes.includes(0x2f)) fail("TARGET_ARTIFACT_INVALID", "Git tree entry name is invalid");
    let name;
    try { name = UTF8.decode(nameBytes); }
    catch { name = null; }
    const oid = bytes.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
    entries.push(Object.freeze({ mode, name, nameBytes: Buffer.from(nameBytes), oid }));
    offset = nul + 1 + oidBytes;
  }
  const names = new Set();
  for (const entry of entries) {
    const key = entry.nameBytes.toString("hex");
    if (names.has(key)) fail("TARGET_ARTIFACT_INVALID", "Git tree entry name is duplicated");
    names.add(key);
  }
  for (let index = 1; index < entries.length; index += 1) {
    const left = Buffer.concat([entries[index - 1].nameBytes, entries[index - 1].mode === "40000" ? Buffer.from("/") : Buffer.alloc(0)]);
    const right = Buffer.concat([entries[index].nameBytes, entries[index].mode === "40000" ? Buffer.from("/") : Buffer.alloc(0)]);
    if (Buffer.compare(left, right) >= 0) fail("TARGET_ARTIFACT_INVALID", "Git tree entry order is invalid");
  }
  return Object.freeze(entries);
}

function stableRefName(value, { input = false } = {}) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024
      || value.includes("..") || value.includes("@{") || value.includes("//")
      || /[\x00-\x20\x7f~^:?*[\\]/u.test(value) || value.endsWith(".") || value.endsWith("/")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith(".") || segment.endsWith(".lock"))) return false;
  return input ? (value.startsWith("refs/heads/") || value.startsWith("refs/tags/")) : value.startsWith("refs/");
}

function parsePackedRefs(bytes, objectFormat) {
  if (bytes.byteLength === 0) return Object.freeze({ refs: new Map(), replaceFound: false });
  if (bytes.byteLength > MAX_PACKED_REFS_BYTES || bytes.at(-1) !== 0x0a || bytes.includes(0x0d)) {
    fail("GIT_REPOSITORY_UNSUPPORTED", "Git packed refs are unsupported");
  }
  let text;
  try { text = UTF8.decode(bytes); }
  catch { fail("GIT_REPOSITORY_UNSUPPORTED", "Git packed refs are unsupported"); }
  const lines = text.slice(0, -1).split("\n");
  let index = 0;
  if (lines[0]?.startsWith("#")) {
    const match = /^# pack-refs with: ((?:peeled |fully-peeled |sorted )*)$/u.exec(lines[0]);
    if (!match) fail("GIT_REPOSITORY_UNSUPPORTED", "Git packed refs header is unsupported");
    const tokens = match[1].trim() === "" ? [] : match[1].trim().split(" ");
    const order = ["peeled", "fully-peeled", "sorted"];
    if (new Set(tokens).size !== tokens.length || tokens.some((token, tokenIndex) => order.indexOf(token) <= order.indexOf(tokens[tokenIndex - 1]))) {
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git packed refs header is unsupported");
    }
    index = 1;
  }
  const refs = new Map();
  let previous = null;
  let lastRef = null;
  let peeled = false;
  let replaceFound = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("^")) {
      if (!lastRef?.startsWith("refs/tags/") || peeled || !oidPattern(objectFormat).test(line.slice(1))) {
        fail("GIT_REPOSITORY_UNSUPPORTED", "Git packed peeled ref is invalid");
      }
      peeled = true;
      continue;
    }
    const space = line.indexOf(" ");
    if (space < 0) fail("GIT_REPOSITORY_UNSUPPORTED", "Git packed ref entry is invalid");
    const oid = line.slice(0, space);
    const ref = line.slice(space + 1);
    if (!oidPattern(objectFormat).test(oid) || !stableRefName(ref) || (previous && utf8Compare(previous, ref) >= 0)) {
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git packed ref entry is invalid");
    }
    refs.set(ref, oid);
    replaceFound ||= ref.startsWith("refs/replace/");
    previous = ref;
    lastRef = ref;
    peeled = false;
  }
  return Object.freeze({ refs, replaceFound });
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function writeExclusiveSynced(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureExactDirectory(path, { create = false } = {}) {
  if (create) await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid() || !exactMode(value, 0o700)) {
    fail("GIT_RUNTIME_UNAVAILABLE", "Local Git temporary directory is invalid");
  }
}

async function openLockTarget(path, sessionHash) {
  const handles = [];
  try {
    const sessionDirectory = dirname(path);
    const localGitRoot = dirname(sessionDirectory);
    const stateDirectory = dirname(localGitRoot);
    if (basename(path) !== "lock-target" || basename(sessionDirectory) !== sessionHash
        || basename(localGitRoot) !== "local-git"
        || path !== join(stateDirectory, "local-git", sessionHash, "lock-target")) {
      throw new Error("invalid-lock-path");
    }
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const stateLexical = await lstat(stateDirectory);
    if (!stateLexical.isDirectory() || stateLexical.isSymbolicLink() || stateLexical.uid !== process.getuid()) {
      throw new Error("invalid-state-root");
    }
    const stateHandle = await open(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(stateHandle);
    if (!sameNode(stateLexical, await stateHandle.stat())) throw new Error("state-root-race");

    const openChild = async (parentHandle, name) => {
      const childPath = `/proc/self/fd/${parentHandle.fd}/${name}`;
      await mkdir(childPath, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
      const lexical = await lstat(childPath);
      if (!lexical.isDirectory() || lexical.isSymbolicLink() || lexical.uid !== process.getuid()
          || !exactMode(lexical, 0o700)) throw new Error("invalid-lock-directory");
      const childHandle = await open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(childHandle);
      const identity = await childHandle.stat();
      if (!sameNode(lexical, identity)) throw new Error("lock-directory-race");
      return { childHandle, binding: Object.freeze({ path: childPath, handle: childHandle, identity }) };
    };
    const local = await openChild(stateHandle, "local-git");
    const session = await openChild(local.childHandle, sessionHash);
    const lockPath = `/proc/self/fd/${session.childHandle.fd}/lock-target`;
    const lockHandle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    handles.push(lockHandle);
    let opened = await lockHandle.stat();
    if (!opened.isFile() || opened.uid !== process.getuid() || opened.nlink !== 1 || opened.size !== 0) {
      throw new Error("invalid-lock");
    }
    if (!exactMode(opened, 0o600)) {
      await lockHandle.chmod(0o600);
      opened = await lockHandle.stat();
    }
    const current = await lstat(lockPath);
    if (!current.isFile() || current.isSymbolicLink() || !sameNode(current, opened)
        || current.uid !== process.getuid() || current.nlink !== 1 || current.size !== 0
        || !exactMode(current, 0o600)) throw new Error("lock-race");
    return Object.freeze({
      handle: lockHandle,
      handles: Object.freeze(handles),
      statePath: stateDirectory,
      stateIdentity: stateLexical,
      bindings: Object.freeze([
        local.binding,
        session.binding,
        Object.freeze({ path: lockPath, handle: lockHandle, identity: opened }),
      ]),
    });
  } catch {
    await Promise.all(handles.reverse().map((handle) => handle.close().catch(() => {})));
    fail("GIT_EXECUTION_LOCK_FAILED", "Local Git lifecycle lock is unavailable");
  }
}

async function validateLockTarget(lock) {
  const state = await lstat(lock.statePath);
  if (!sameNode(state, lock.stateIdentity)) throw new Error("state-root-changed");
  for (const binding of lock.bindings) {
    const lexical = await lstat(binding.path);
    const opened = await binding.handle.stat();
    if (!sameNode(lexical, binding.identity) || !sameNode(opened, binding.identity)) {
      throw new Error("lock-path-changed");
    }
  }
}

class LifecycleCallbackError extends Error {
  constructor(cause) {
    super("Local Git lifecycle callback failed", { cause });
    this.name = "LifecycleCallbackError";
  }
}

function makeError(code) {
  const error = new Error(code);
  error.localGitCode = code;
  return error;
}

class BufferedChild {
  constructor(child, { timeoutMs, maxStdout, maxStderr, deadline }) {
    this.child = child;
    child.stdin.on("error", () => {});
    this.stdout = [];
    this.stderrBytes = 0;
    this.stdoutBytes = 0;
    this.capError = null;
    this.spawnError = null;
    const remaining = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
    this.timer = setTimeout(() => {
      this.capError = makeError("GIT_EXECUTION_TIMEOUT");
      child.kill("SIGKILL");
    }, remaining);
    this.timer.unref?.();
    child.stdout.on("data", (chunk) => {
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > maxStdout) {
        this.capError = makeError("TARGET_LIMIT_EXCEEDED");
        child.kill("SIGKILL");
      } else this.stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > maxStderr) {
        this.capError = makeError("TARGET_LIMIT_EXCEEDED");
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => { this.spawnError = error; });
    this.closed = new Promise((resolve) => child.once("close", (code, signal) => {
      clearTimeout(this.timer);
      resolve({ code, signal });
    }));
  }

  async finish(input = null) {
    if (input) this.child.stdin.end(input);
    else this.child.stdin.end();
    const outcome = await this.closed;
    if (this.capError) throw this.capError;
    if (this.spawnError) throw this.spawnError;
    return { ...outcome, stdout: Buffer.concat(this.stdout) };
  }
}

class ObjectBatch {
  #buffer = Buffer.alloc(0);
  #error = null;
  #exit;
  #notify = [];
  #requests = 0;
  #responseBytes = 0;
  #stderrBytes = 0;
  #timer;
  #closed = false;

  constructor(child, { deadline, objectFormat }) {
    this.child = child;
    child.stdin.on("error", () => {});
    this.objectFormat = objectFormat;
    const remaining = Math.max(1, deadline - Date.now());
    this.#timer = setTimeout(() => this.#abort(makeError("GIT_EXECUTION_TIMEOUT")), remaining);
    this.#timer.unref?.();
    child.stdout.on("data", (chunk) => {
      this.#responseBytes += chunk.length;
      if (this.#responseBytes > MAX_BATCH_RESPONSE_BYTES) {
        this.#abort(makeError("TARGET_LIMIT_EXCEEDED"));
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#wake();
    });
    child.stderr.on("data", (chunk) => {
      this.#stderrBytes += chunk.length;
      if (this.#stderrBytes > MAX_STDERR_BYTES) this.#abort(makeError("TARGET_LIMIT_EXCEEDED"));
    });
    child.once("error", () => this.#abort(makeError("GIT_EXECUTION_FAILED")));
    this.#exit = new Promise((resolve) => child.once("close", (code, signal) => {
      clearTimeout(this.#timer);
      this.#closed = true;
      if ((code !== 0 || signal !== null) && !this.#error) this.#error = makeError("TARGET_ARTIFACT_INVALID");
      this.#wake();
      resolve({ code, signal });
    }));
  }

  #abort(error) {
    this.#error ??= error;
    this.child.kill("SIGKILL");
    this.#wake();
  }

  #wake() {
    for (const wake of this.#notify.splice(0)) wake();
  }

  async #wait() {
    if (this.#error) throw this.#error;
    if (this.#closed) throw makeError("TARGET_ARTIFACT_INVALID");
    await new Promise((resolve) => this.#notify.push(resolve));
    if (this.#error) throw this.#error;
    if (this.#closed) throw makeError("TARGET_ARTIFACT_INVALID");
  }

  async #line() {
    while (true) {
      const index = this.#buffer.indexOf(0x0a);
      if (index >= 0) {
        const line = this.#buffer.subarray(0, index);
        this.#buffer = this.#buffer.subarray(index + 1);
        return line;
      }
      await this.#wait();
    }
  }

  async #bytes(count) {
    while (this.#buffer.length < count) await this.#wait();
    const bytes = this.#buffer.subarray(0, count);
    this.#buffer = this.#buffer.subarray(count);
    return Buffer.from(bytes);
  }

  async get(oid, maxBytes) {
    this.#requests += 1;
    if (this.#requests > MAX_OBJECT_REQUESTS) throw makeError("TARGET_LIMIT_EXCEEDED");
    if (!this.child.stdin.write(`contents ${oid}\nflush\n`, "ascii")) {
      await new Promise((resolve) => this.child.stdin.once("drain", resolve));
    }
    const lineBytes = await this.#line();
    if ([...lineBytes].some((byte) => byte > 0x7f)) throw makeError("TARGET_ARTIFACT_INVALID");
    const line = lineBytes.toString("ascii");
    if (line === `${oid} missing`) return null;
    const match = /^([a-f0-9]+) (tag|commit|tree|blob) (0|[1-9][0-9]*)$/u.exec(line);
    if (!match || match[1] !== oid) {
      const error = makeError("TARGET_ARTIFACT_INVALID");
      this.#abort(error);
      throw error;
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > maxBytes) {
      const error = makeError("TARGET_LIMIT_EXCEEDED");
      this.#abort(error);
      throw error;
    }
    const bytes = await this.#bytes(size);
    const protocol = await this.#bytes(1);
    if (protocol[0] !== 0x0a) {
      const error = makeError("TARGET_ARTIFACT_INVALID");
      this.#abort(error);
      throw error;
    }
    return Object.freeze({ type: match[2], bytes });
  }

  async close() {
    this.child.stdin.end();
    await this.#exit;
    if (this.#error) throw this.#error;
    if (this.#buffer.length !== 0) throw makeError("TARGET_ARTIFACT_INVALID");
  }
}

export class LocalGitExecutor {
  #execFile;
  #gitExecPath;
  #gitPath;
  #initialized = null;
  #lockPath;
  #prlimitPath;
  #reportedVersion;
  #sessionHash;
  #tmpSessionRoot;
  #versionOutput;
  #workspaceDir;
  #workspaceIdentity;
  #workspaceRealpath;

  constructor({
    workspaceDir,
    sessionHash,
    lockPath,
    execFile = nodeExecFile,
    gitPath = "/usr/bin/git",
    gitExecPath = "/usr/lib/git-core",
    prlimitPath = "/usr/bin/prlimit",
    expectedVersionOutput = "git version 2.43.0\n",
    reportedVersion = GIT_RUNTIME_VERSION,
    tempRoot = "/tmp/tiangong-local-git",
  }) {
    if (typeof workspaceDir !== "string" || workspaceDir === "" || typeof sessionHash !== "string"
        || !/^[a-f0-9]{64}$/u.test(sessionHash) || typeof lockPath !== "string" || lockPath === ""
        || typeof execFile !== "function") throw new TypeError("LocalGitExecutor dependencies are required");
    this.#workspaceDir = resolve(workspaceDir);
    this.#sessionHash = sessionHash;
    this.#lockPath = lockPath;
    this.#execFile = execFile;
    this.#gitPath = gitPath;
    this.#gitExecPath = gitExecPath;
    this.#prlimitPath = prlimitPath;
    this.#versionOutput = expectedVersionOutput;
    this.#reportedVersion = reportedVersion;
    this.#tmpSessionRoot = join(tempRoot, sessionHash);
  }

  async initialize() {
    if (!this.#initialized) this.#initialized = this.#initialize();
    return this.#initialized;
  }

  async #initialize() {
    const root = await lstat(this.#workspaceDir);
    if (!root.isDirectory() || root.isSymbolicLink()) fail("TARGET_UNAVAILABLE", "Trusted workspace root is unavailable");
    this.#workspaceRealpath = await realpath(this.#workspaceDir);
    const resolvedRoot = await lstat(this.#workspaceRealpath);
    if (!sameNode(root, resolvedRoot)) fail("TARGET_UNAVAILABLE", "Trusted workspace root changed during initialization");
    this.#workspaceIdentity = Object.freeze({ dev: root.dev, ino: root.ino, mode: root.mode });
    for (const executable of [this.#gitPath, this.#prlimitPath]) {
      const node = await lstat(executable).catch(() => null);
      if (!node?.isFile() || node.isSymbolicLink() || node.uid !== 0 || (node.mode & 0o111) === 0) {
        fail("GIT_RUNTIME_UNAVAILABLE", "Local Git runtime executable is unavailable");
      }
    }
    const execDirectory = await lstat(this.#gitExecPath).catch(() => null);
    if (!execDirectory?.isDirectory() || execDirectory.isSymbolicLink() || execDirectory.uid !== 0) {
      fail("GIT_RUNTIME_UNAVAILABLE", "Local Git execution directory is unavailable");
    }
    await ensureExactDirectory(dirname(this.#tmpSessionRoot), { create: true });
    await ensureExactDirectory(this.#tmpSessionRoot, { create: true });
    await this.#residues();
    return this;
  }

  async #residues() {
    const residues = await readdir(this.#tmpSessionRoot);
    if (residues.length > MAX_TEMP_RESIDUE || residues.some((name) => !/^git-op-[a-f0-9]{64}-[0-9a-f-]{36}$/u.test(name))) {
      fail("GIT_RUNTIME_UNAVAILABLE", "Local Git temporary residue is invalid");
    }
    for (const name of residues) {
      const value = await lstat(join(this.#tmpSessionRoot, name));
      if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid() || !exactMode(value, 0o700)) {
        fail("GIT_RUNTIME_UNAVAILABLE", "Local Git temporary residue is invalid");
      }
    }
    return residues;
  }

  #baseEnv(sandbox, { object = false } = {}) {
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      XDG_CONFIG_HOME: "/nonexistent",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EDITOR: "/bin/false",
      GIT_SEQUENCE_EDITOR: "/bin/false",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_EXEC_PATH: this.#gitExecPath,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: sandbox,
      GIT_DIR: object ? sandbox : join(sandbox, "no-repository"),
    };
    if (object) env.GIT_OBJECT_DIRECTORY = join(sandbox, "objects");
    return env;
  }

  #spawn(lifecycle, gitArgs, { object = false }) {
    lifecycle.children += 1;
    if (lifecycle.children > MAX_CHILDREN) throw makeError("TARGET_LIMIT_EXCEEDED");
    try {
      return this.#execFile(
        this.#prlimitPath,
        [...PRLIMIT_PREFIX.slice(0, -1), this.#gitPath, ...gitArgs],
        {
          cwd: lifecycle.sandbox,
          env: this.#baseEnv(lifecycle.sandbox, { object }),
          shell: false,
          windowsHide: true,
          encoding: "buffer",
        },
      );
    } catch {
      throw makeError("GIT_RUNTIME_UNAVAILABLE");
    }
  }

  async #runBuffered(lifecycle, args, {
    object = false, input = null, maxStdout = 16 * 1024, timeoutMs = SHORT_TIMEOUT_MS,
  } = {}) {
    if (Date.now() >= lifecycle.deadline) throw makeError("GIT_EXECUTION_TIMEOUT");
    const child = this.#spawn(lifecycle, args, { object });
    const buffered = new BufferedChild(child, {
      timeoutMs, maxStdout, maxStderr: MAX_STDERR_BYTES, deadline: lifecycle.deadline,
    });
    return buffered.finish(input);
  }

  async #version(lifecycle) {
    let result;
    try { result = await this.#runBuffered(lifecycle, ["--version"], { maxStdout: 128 }); }
    catch (error) {
      if (error?.localGitCode === "GIT_EXECUTION_TIMEOUT") fail("GIT_EXECUTION_TIMEOUT", "Local Git version check timed out");
      fail("GIT_RUNTIME_UNAVAILABLE", "Local Git runtime version is unavailable");
    }
    if (result.code !== 0 || result.signal !== null || !result.stdout.equals(Buffer.from(this.#versionOutput, "ascii"))) {
      fail("GIT_RUNTIME_UNAVAILABLE", "Local Git runtime version is unsupported");
    }
  }

  async #configQuery(lifecycle, configBytes, args, { absent = false, postAdmission = false } = {}) {
    let result;
    try {
      result = await this.#runBuffered(lifecycle, ["config", "--file", "-", "--no-includes", "--null", ...args], {
        input: configBytes, maxStdout: 16 * 1024,
      });
    } catch (error) {
      if (error.localGitCode === "GIT_EXECUTION_TIMEOUT") fail("GIT_EXECUTION_TIMEOUT", "Local Git config probe timed out");
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository config is unavailable");
      if (error.localGitCode === "TARGET_LIMIT_EXCEEDED") fail("TARGET_LIMIT_EXCEEDED", "Git config probe exceeds its fixed limit");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository config is unsupported");
    }
    if (absent && result.code === 1 && result.signal === null && result.stdout.length === 0) return [];
    if (result.code !== 0 || result.signal !== null) {
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository config is unavailable");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository config is unsupported");
    }
    if (result.stdout.length === 0 || result.stdout.at(-1) !== 0) {
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository config is unavailable");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository config framing is unsupported");
    }
    let fields;
    try { fields = UTF8.decode(result.stdout.subarray(0, -1)).split("\0"); }
    catch {
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository config is unavailable");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository config framing is unsupported");
    }
    if (fields.some((field) => Buffer.byteLength(field, "utf8") > 4096)) {
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository config is unavailable");
      fail("TARGET_LIMIT_EXCEEDED", "Git config probe exceeds its fixed limit");
    }
    return fields;
  }

  async #probeConfig(lifecycle, configBytes, { postAdmission = false } = {}) {
    const query = (args, options) => this.#configQuery(lifecycle, configBytes, args, { postAdmission, ...options });
    const repositoryFormat = await query(["--type=int", "--get-all", "core.repositoryformatversion"], { absent: true });
    const bare = await query(["--type=bool", "--get-all", "core.bare"], { absent: true });
    const worktree = await query(["--get-all", "core.worktree"], { absent: true });
    const extensions = await query(["--name-only", "--get-regexp", "^extensions\\."], { absent: true });
    const objectFormat = await query(["--get-all", "extensions.objectformat"], { absent: true });
    const include = await query(["--name-only", "--get-regexp", "^include\\."], { absent: true });
    const includeIf = await query(["--name-only", "--get-regexp", "^includeif\\."], { absent: true });
    const promisor = await query(["--name-only", "--get-regexp", "^remote\\..*\\.promisor$"], { absent: true });
    const filter = await query(["--name-only", "--get-regexp", "^remote\\..*\\.partialclonefilter$"], { absent: true });
    const format = repositoryFormat.length === 0 ? 0 : Number(repositoryFormat[0]);
    if (repositoryFormat.length > 1 || ![0, 1].includes(format) || bare.length > 1 || (bare.length === 1 && bare[0] !== "false")
        || worktree.length !== 0 || include.length !== 0 || includeIf.length !== 0 || promisor.length !== 0 || filter.length !== 0
        || extensions.length > 1 || (extensions.length === 1 && extensions[0] !== "extensions.objectformat")
        || (format === 0 && objectFormat.length !== 0) || (format === 1 && (objectFormat.length !== 1 || objectFormat[0] !== "sha256"))) {
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository config is unavailable");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository format is unsupported");
    }
    return Object.freeze({ repositoryFormat: format, objectFormat: format === 0 ? "sha1" : "sha256" });
  }

  async #stableFile(path, maxBytes, { nlinkOne = false, missing = false, postAdmission = false } = {}) {
    let handle;
    try {
      const lexical = await lstat(path);
      if (lexical.isSymbolicLink() || !lexical.isFile() || (nlinkOne && lexical.nlink !== 1)) {
        fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository file layout is unsupported");
      }
      if (lexical.size > maxBytes) fail("TARGET_LIMIT_EXCEEDED", "Git repository source exceeds its fixed limit");
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const a = await handle.stat();
      if (!sameNode(lexical, a) || (nlinkOne && a.nlink !== 1) || a.size > maxBytes) {
        fail("TARGET_CHANGED_DURING_CAPTURE", "Git repository source changed before stable read");
      }
      const readExact = async () => {
        const output = Buffer.alloc(a.size);
        let offset = 0;
        while (offset < output.length) {
          const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const extra = Buffer.alloc(1);
        const extraRead = await handle.read(extra, 0, 1, a.size);
        if (offset !== output.length || extraRead.bytesRead !== 0) {
          fail("TARGET_CHANGED_DURING_CAPTURE", "Git repository source changed during stable read");
        }
        return output;
      };
      const first = await readExact();
      const b = await handle.stat();
      const second = await readExact();
      const c = await handle.stat();
      if (!sameStableFile(a, b) || !sameStableFile(b, c) || !first.equals(second)) {
        fail("TARGET_CHANGED_DURING_CAPTURE", "Git repository source changed during capture");
      }
      return Object.freeze({
        bytes: first,
        stat: Object.freeze({
          dev: a.dev,
          ino: a.ino,
          mode: a.mode,
          nlink: a.nlink,
          size: a.size,
          mtimeMs: a.mtimeMs,
          ctimeMs: a.ctimeMs,
        }),
      });
    } catch (error) {
      if (missing && error?.code === "ENOENT") return null;
      if (error?.name === "PracticeRunError") throw error;
      if (error?.code === "ENOENT") fail(postAdmission ? "GIT_OBJECT_UNAVAILABLE" : "GIT_REPOSITORY_UNSUPPORTED", "Git repository source is unavailable");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository source is unavailable");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #repository(lifecycle, repositoryPath, { postAdmission = false } = {}) {
    const changedCode = postAdmission ? "TARGET_CHANGED" : "TARGET_CHANGED_DURING_CAPTURE";
    const unavailableCode = postAdmission ? "GIT_OBJECT_UNAVAILABLE" : "GIT_REPOSITORY_UNSUPPORTED";
    const openDirectory = async (parent, name, { missingCode = unavailableCode } = {}) => {
      const path = name === null ? parent : join(parent, name);
      let lexical;
      let handle;
      try {
        lexical = await lstat(path);
        if (lexical.isSymbolicLink()) {
          fail(postAdmission ? "GIT_OBJECT_UNAVAILABLE" : "TARGET_SYMLINK_DENIED", "Git repository symbolic links are denied");
        }
        if (!lexical.isDirectory()) fail(unavailableCode, "Git repository directory layout is unsupported");
        handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (!sameNode(lexical, opened)) fail(changedCode, "Git repository directory changed during capture");
        lifecycle.sourceHandles.push(handle);
        if (name !== null) {
          lifecycle.directoryBindings.push(Object.freeze({
            path,
            handle,
            identity: Object.freeze({ dev: opened.dev, ino: opened.ino, mode: opened.mode }),
          }));
        }
        return handle;
      } catch (error) {
        if (handle && !lifecycle.sourceHandles.includes(handle)) await handle.close().catch(() => {});
        if (error?.name === "PracticeRunError") throw error;
        if (error?.code === "ENOENT") fail(missingCode, "Git repository directory is unavailable");
        fail(unavailableCode, "Git repository directory layout is unsupported");
      }
    };

    const workspaceHandle = await openDirectory(this.#workspaceRealpath, null, {
      missingCode: postAdmission ? "GIT_OBJECT_UNAVAILABLE" : "TARGET_UNAVAILABLE",
    });
    const workspaceStat = await workspaceHandle.stat();
    if (!sameNode(workspaceStat, this.#workspaceIdentity)) fail(changedCode, "Trusted workspace root changed during capture");
    let rootHandle = workspaceHandle;
    let sourceRoot = `/proc/self/fd/${workspaceHandle.fd}`;
    if (repositoryPath !== ".") {
      for (const segment of repositoryPath.split("/")) {
        rootHandle = await openDirectory(sourceRoot, segment, {
          missingCode: postAdmission ? "GIT_OBJECT_UNAVAILABLE" : "TARGET_NOT_FOUND",
        });
        sourceRoot = `/proc/self/fd/${rootHandle.fd}`;
      }
    }
    const root = repositoryPath === "." ? this.#workspaceRealpath : join(this.#workspaceRealpath, repositoryPath);
    const gitDir = join(root, ".git");
    const rootStat = await rootHandle.stat();
    const gitHandle = await openDirectory(sourceRoot, ".git");
    const gitStat = await gitHandle.stat();
    const sourceGitDir = `/proc/self/fd/${gitHandle.fd}`;
    const refsHandle = await openDirectory(sourceGitDir, "refs");
    const objectsHandle = await openDirectory(sourceGitDir, "objects");
    const sourceObjectDir = `/proc/self/fd/${objectsHandle.fd}`;
    const packHandle = await openDirectory(sourceObjectDir, "pack");
    const absentPaths = [];
    const deniedDirect = [
      join(sourceGitDir, "commondir"),
      join(sourceGitDir, "config.worktree"),
      join(`/proc/self/fd/${refsHandle.fd}`, "replace"),
    ];
    for (const denied of deniedDirect) {
      const value = await lstat(denied).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (value) {
        if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository layout is unavailable");
        fail("GIT_REPOSITORY_UNSUPPORTED", "Git repository layout is unsupported");
      }
      absentPaths.push(denied);
    }
    const infoNode = await lstat(join(sourceObjectDir, "info")).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (infoNode) {
      if (!infoNode.isDirectory() || infoNode.isSymbolicLink()) {
        if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository layout is unavailable");
        fail("GIT_REPOSITORY_UNSUPPORTED", "Git object info layout is unsupported");
      }
      const infoHandle = await openDirectory(sourceObjectDir, "info");
      for (const name of ["alternates", "http-alternates"]) {
        const value = await lstat(`/proc/self/fd/${infoHandle.fd}/${name}`)
          .catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (value) {
          if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository object storage is unavailable");
          fail("GIT_REPOSITORY_UNSUPPORTED", "Git alternate object storage is unsupported");
        }
        absentPaths.push(`/proc/self/fd/${infoHandle.fd}/${name}`);
      }
    } else {
      absentPaths.push(join(sourceObjectDir, "info"));
    }
    const config = await this.#stableFile(join(sourceGitDir, "config"), MAX_CONFIG_BYTES, { nlinkOne: true, postAdmission });
    const format = await this.#probeConfig(lifecycle, config.bytes, { postAdmission });
    const head = await this.#stableFile(join(sourceGitDir, "HEAD"), 2048, { nlinkOne: true, postAdmission });
    const packed = await this.#stableFile(join(sourceGitDir, "packed-refs"), MAX_PACKED_REFS_BYTES, { nlinkOne: true, missing: true });
    const parsedPacked = parsePackedRefs(packed?.bytes ?? Buffer.alloc(0), format.objectFormat);
    if (parsedPacked.replaceFound) {
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository refs are unavailable");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git replace refs are unsupported");
    }
    const headText = strictAscii(head.bytes, postAdmission ? "GIT_OBJECT_UNAVAILABLE" : "GIT_REPOSITORY_UNSUPPORTED", "Git HEAD is unsupported");
    const headOidPattern = oidPattern(format.objectFormat);
    if (!(headText.endsWith("\n") && !headText.slice(0, -1).includes("\n")
        && (headOidPattern.test(headText.slice(0, -1))
          || (headText.startsWith("ref: ") && stableRefName(headText.slice(5, -1), { input: true })
            && headText.slice(5, -1).startsWith("refs/heads/"))))) {
      if (postAdmission) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository HEAD is unavailable");
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git HEAD is unsupported");
    }
    return Object.freeze({
      root, gitDir, rootHandle, gitHandle, sourceHandles: lifecycle.sourceHandles,
      sourceGitDir, sourceRefsDir: `/proc/self/fd/${refsHandle.fd}`,
      objectDir: sourceObjectDir, packDir: `/proc/self/fd/${packHandle.fd}`,
      rootIdentity: Object.freeze({ dev: rootStat.dev, ino: rootStat.ino, mode: rootStat.mode }),
      gitIdentity: Object.freeze({ dev: gitStat.dev, ino: gitStat.ino, mode: gitStat.mode }),
      headText,
      headIdentity: head.stat,
      configIdentity: config.stat,
      packed: parsedPacked,
      packedPresent: Boolean(packed),
      packedIdentity: packed?.stat ?? null,
      absentPaths,
      absentLooseRefs: [],
      resolvedLooseRefs: [],
      resolvedRefDirectories: [],
      ...format,
    });
  }

  async #finalRepository(repository, lifecycle, { postAdmission = false } = {}) {
    try {
      const root = await lstat(repository.root);
      const git = await lstat(repository.gitDir);
      const pinnedRoot = await repository.rootHandle.stat();
      const pinnedGit = await repository.gitHandle.stat();
      if (!sameNode(root, repository.rootIdentity) || !sameNode(pinnedRoot, repository.rootIdentity)
          || !sameNode(git, repository.gitIdentity) || !sameNode(pinnedGit, repository.gitIdentity)) {
        throw new Error("root-change");
      }
      for (const expected of lifecycle.directoryBindings) {
        const lexical = await lstat(expected.path);
        const current = await expected.handle.stat();
        if (!sameNode(lexical, expected.identity) || !sameNode(current, expected.identity)) {
          throw new Error("directory-change");
        }
      }
      const configNow = await lstat(join(repository.sourceGitDir, "config"));
      const headNow = await lstat(join(repository.sourceGitDir, "HEAD"));
      if (!sameStableFile(configNow, repository.configIdentity) || !sameStableFile(headNow, repository.headIdentity)) {
        throw new Error("repository-file-change");
      }
      const packedNow = await lstat(join(repository.sourceGitDir, "packed-refs"))
        .catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (Boolean(packedNow) !== repository.packedPresent
          || (packedNow && !sameStableFile(packedNow, repository.packedIdentity))) throw new Error("packed-change");
      for (const expected of repository.resolvedRefDirectories) {
        const lexical = await lstat(expected.path);
        const opened = await expected.handle.stat();
        if (!sameNode(lexical, expected.identity) || !sameNode(opened, expected.identity)) {
          throw new Error("loose-ref-directory-change");
        }
      }
      for (const path of [...repository.absentPaths, ...repository.absentLooseRefs]) {
        const current = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (current) throw new Error("absent-source-created");
      }
      for (const expected of repository.resolvedLooseRefs) {
        const current = await lstat(expected.path);
        if (!sameStableFile(current, expected.identity)) throw new Error("loose-ref-change");
      }
      const packNames = (await readdir(repository.packDir)).sort();
      if (packNames.join("\0") !== lifecycle.packNames.join("\0")) throw new Error("pack-set-change");
    } catch {
      fail(postAdmission ? "TARGET_CHANGED" : "TARGET_CHANGED_DURING_CAPTURE", "Git repository changed during capture");
    }
  }

  async #copyStable(source, destination, maxBytes, lifecycle) {
    let input;
    let output;
    try {
      const lexical = await lstat(source);
      if (!lexical.isFile() || lexical.isSymbolicLink()) fail("GIT_REPOSITORY_UNSUPPORTED", "Git source file layout is unsupported");
      input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await input.stat();
      if (!sameNode(lexical, before)) fail("TARGET_CHANGED_DURING_CAPTURE", "Git source changed before stable copy");
      if (before.size > maxBytes || lifecycle.sandboxBytes + before.size > MAX_SANDBOX_BYTES) {
        fail("TARGET_LIMIT_EXCEEDED", "Git source mirror exceeds its fixed limit");
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const firstHash = createHash("sha256");
      const chunk = Buffer.alloc(1024 * 1024);
      let position = 0;
      while (position < before.size) {
        if (Date.now() >= lifecycle.deadline) throw makeError("GIT_EXECUTION_TIMEOUT");
        const count = Math.min(chunk.length, before.size - position);
        const { bytesRead } = await input.read(chunk, 0, count, position);
        if (bytesRead !== count) fail("TARGET_CHANGED_DURING_CAPTURE", "Git source changed during stable copy");
        firstHash.update(chunk.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written, position + written);
          if (result.bytesWritten <= 0) throw makeError("GIT_EXECUTION_FAILED");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await output.sync();
      const middle = await input.stat();
      const secondHash = createHash("sha256");
      position = 0;
      while (position < before.size) {
        if (Date.now() >= lifecycle.deadline) throw makeError("GIT_EXECUTION_TIMEOUT");
        const count = Math.min(chunk.length, before.size - position);
        const { bytesRead } = await input.read(chunk, 0, count, position);
        if (bytesRead !== count) fail("TARGET_CHANGED_DURING_CAPTURE", "Git source changed during stable copy");
        secondHash.update(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await input.stat();
      if (!sameStableFile(before, middle) || !sameStableFile(middle, after)
          || firstHash.digest("hex") !== secondHash.digest("hex")) {
        fail("TARGET_CHANGED_DURING_CAPTURE", "Git source changed during stable copy");
      }
      lifecycle.sandboxBytes += before.size;
      return before.size;
    } finally {
      await output?.close().catch(() => {});
      await input?.close().catch(() => {});
    }
  }

  async #mirrorPacks(repository, lifecycle) {
    const namesA = (await readdir(repository.packDir)).sort();
    const namesB = (await readdir(repository.packDir)).sort();
    if (namesA.join("\0") !== namesB.join("\0") || namesA.length > MAX_PACK_ENTRIES) {
      fail("TARGET_CHANGED_DURING_CAPTURE", "Git pack set changed during capture");
    }
    lifecycle.packNames = Object.freeze([...namesA]);
    const width = repository.objectFormat === "sha1" ? 40 : 64;
    const pairs = new Map();
    let ignoredBytes = 0;
    for (const name of namesA) {
      const pair = new RegExp(`^pack-([a-f0-9]{${width}})\\.(pack|idx)$`, "u").exec(name);
      if (pair) {
        const current = pairs.get(pair[1]) ?? new Set();
        current.add(pair[2]);
        pairs.set(pair[1], current);
        continue;
      }
      const optional = new RegExp(`^pack-[a-f0-9]{${width}}\\.(rev|bitmap|keep|mtimes)$`, "u").exec(name);
      if (optional || name === "multi-pack-index") {
        const value = await lstat(join(repository.packDir, name));
        if (!value.isFile() || value.isSymbolicLink()
            || value.size > (name.endsWith(".keep") ? MAX_KEEP_BYTES : MAX_SINGLE_IGNORED_PACK_METADATA_BYTES)) {
          fail("GIT_REPOSITORY_UNSUPPORTED", "Git pack metadata is unsupported");
        }
        ignoredBytes += value.size;
        if (ignoredBytes > MAX_IGNORED_PACK_METADATA_BYTES) fail("TARGET_LIMIT_EXCEEDED", "Git pack metadata exceeds its limit");
        continue;
      }
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git pack directory contains an unsupported entry");
    }
    if (pairs.size > MAX_PACK_PAIRS || [...pairs.values()].some((set) => set.size !== 2)) {
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git pack pairs are unsupported");
    }
    let total = 0;
    for (const hash of [...pairs.keys()].sort()) {
      for (const extension of ["pack", "idx"]) {
        const name = `pack-${hash}.${extension}`;
        const source = join(repository.packDir, name);
        const copied = await this.#copyStable(
          source,
          join(lifecycle.sandbox, "objects", "pack", name),
          MAX_PACK_MIRROR_BYTES - total,
          lifecycle,
        );
        total += copied;
      }
    }
  }

  async #mirrorLoose(repository, lifecycle, oid) {
    if (lifecycle.mirroredLoose.has(oid)) return;
    lifecycle.mirroredLoose.add(oid);
    let fanout;
    try {
      fanout = await open(
        join(repository.objectDir, oid.slice(0, 2)),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error.code === "ENOENT") return;
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git loose object fanout is unsupported");
    }
    try {
      const source = `/proc/self/fd/${fanout.fd}/${oid.slice(2)}`;
      const lexical = await lstat(source).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (!lexical) return;
      if (!lexical.isFile() || lexical.isSymbolicLink()) fail("GIT_REPOSITORY_UNSUPPORTED", "Git loose object layout is unsupported");
      const copied = await this.#copyStable(
        source,
        join(lifecycle.sandbox, "objects", oid.slice(0, 2), oid.slice(2)),
        MAX_LOOSE_MIRROR_BYTES - lifecycle.looseBytes,
        lifecycle,
      );
      lifecycle.looseBytes += copied;
    } finally {
      await fanout.close().catch(() => {});
    }
  }

  async #batch(lifecycle, repository) {
    const child = this.#spawn(lifecycle, [...GIT_GLOBAL_PREFIX, "cat-file", "--batch-command", "--buffer"], { object: true });
    const batch = new ObjectBatch(child, { deadline: lifecycle.deadline, objectFormat: repository.objectFormat });
    const cache = new Map();
    const order = [];
    const get = async (oid, maxBytes, expectedType = null) => {
      assertOid(oid, repository.objectFormat);
      if (cache.has(oid)) {
        const found = cache.get(oid);
        if (expectedType && found.type !== expectedType) fail("TARGET_ARTIFACT_INVALID", "Git object type conflicts with its tree");
        return found;
      }
      await this.#mirrorLoose(repository, lifecycle, oid);
      let found;
      try { found = await batch.get(oid, maxBytes); }
      catch (error) {
        if (error.localGitCode === "GIT_EXECUTION_TIMEOUT") fail("GIT_EXECUTION_TIMEOUT", "Git object read timed out");
        if (error.localGitCode === "TARGET_LIMIT_EXCEEDED") fail("TARGET_LIMIT_EXCEEDED", "Git object response exceeds its limit");
        if (error.localGitCode === "GIT_EXECUTION_FAILED") fail("GIT_EXECUTION_FAILED", "Git object process failed");
        fail("TARGET_ARTIFACT_INVALID", "Git object response is invalid");
      }
      if (!found) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git object is unavailable");
      if (expectedType && found.type !== expectedType) fail("TARGET_ARTIFACT_INVALID", "Git object type conflicts with its tree");
      if (objectHash(found.type, found.bytes, repository.objectFormat) !== oid) {
        fail("TARGET_ARTIFACT_INVALID", "Git object content conflicts with its OID");
      }
      cache.set(oid, found);
      order.push(oid);
      return found;
    };
    return Object.freeze({ batch, cache, order, get });
  }

  async #closeBatch(session) {
    try { await session.batch.close(); }
    catch (error) {
      if (error.localGitCode === "GIT_EXECUTION_TIMEOUT") fail("GIT_EXECUTION_TIMEOUT", "Git object process timed out");
      if (error.localGitCode === "TARGET_LIMIT_EXCEEDED") fail("TARGET_LIMIT_EXCEEDED", "Git object response exceeds its limit");
      if (error.localGitCode === "GIT_EXECUTION_FAILED") fail("GIT_EXECUTION_FAILED", "Git object process failed");
      fail("TARGET_ARTIFACT_INVALID", "Git object process output is invalid");
    }
  }

  async #peel(session, oid, objectFormat) {
    const seen = new Set();
    let current = oid;
    let declaredType = null;
    for (let depth = 0; depth <= MAX_TAG_DEPTH; depth += 1) {
      if (seen.has(current)) fail("GIT_OBJECT_UNAVAILABLE", "Git tag cycle is unsupported");
      seen.add(current);
      const object = await session.get(current, MAX_TAG_OBJECT_BYTES);
      if (declaredType && object.type !== declaredType) fail("TARGET_ARTIFACT_INVALID", "Git tag type conflicts with its object");
      if (object.type === "commit") return Object.freeze({ commitOid: current, commitBytes: object.bytes });
      if (object.type !== "tag" || depth === MAX_TAG_DEPTH) fail("GIT_OBJECT_UNAVAILABLE", "Git ref does not resolve to a commit");
      const tag = parseHeaderBlock(object.bytes, "tag", objectFormat);
      current = tag.objectOid;
      declaredType = tag.objectType;
    }
    fail("GIT_OBJECT_UNAVAILABLE", "Git tag chain exceeds its limit");
  }

  async #looseRef(repository, ref) {
    const segments = ref.split("/").slice(1);
    let parent = repository.sourceRefsDir;
    for (const segment of segments.slice(0, -1)) {
      const path = join(parent, segment);
      let lexical;
      let handle;
      try {
        lexical = await lstat(path);
        if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
          fail("GIT_REPOSITORY_UNSUPPORTED", "Git loose ref directory is unsupported");
        }
        handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (!sameNode(lexical, opened)) fail("TARGET_CHANGED_DURING_CAPTURE", "Git loose ref directory changed during capture");
      } catch (error) {
        if (handle && !repository.sourceHandles.includes(handle)) await handle.close().catch(() => {});
        if (error?.name === "PracticeRunError") throw error;
        if (error?.code === "ENOENT") {
          repository.absentLooseRefs.push(path);
          return null;
        }
        fail("GIT_REPOSITORY_UNSUPPORTED", "Git loose ref directory is unsupported");
      }
      repository.sourceHandles.push(handle);
      const identity = Object.freeze({ dev: lexical.dev, ino: lexical.ino, mode: lexical.mode });
      repository.resolvedRefDirectories.push(Object.freeze({ path, handle, identity }));
      parent = `/proc/self/fd/${handle.fd}`;
    }
    const path = join(parent, segments.at(-1));
    const source = await this.#stableFile(path, 256, { nlinkOne: true, missing: true });
    if (!source) {
      repository.absentLooseRefs.push(path);
      return null;
    }
    const text = strictAscii(source.bytes, "GIT_REPOSITORY_UNSUPPORTED", "Git loose ref is unsupported");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || !oidPattern(repository.objectFormat).test(text.slice(0, -1))) {
      fail("GIT_REPOSITORY_UNSUPPORTED", "Git loose ref is unsupported");
    }
    repository.resolvedLooseRefs.push(Object.freeze({ path, identity: source.stat }));
    return text.slice(0, -1);
  }

  async #resolveRef(repository, ref) {
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(ref)) {
      if (!oidPattern(repository.objectFormat).test(ref)) fail("GIT_REF_INVALID", "Git OID length conflicts with repository object format");
      return ref;
    }
    let selected = ref;
    if (ref === "HEAD") {
      if (!repository.headText.startsWith("ref: ")) return repository.headText.slice(0, -1);
      selected = repository.headText.slice(5, -1);
    }
    const loose = await this.#looseRef(repository, selected);
    const oid = loose ?? repository.packed.refs.get(selected);
    if (!oid) fail("GIT_OBJECT_UNAVAILABLE", "Requested Git ref is unavailable");
    return oid;
  }

  async #walkTree(lifecycle, session, repository, rootOid, prefixes, budget = null) {
    const files = new Map();
    const trees = new Map();
    const activeBudget = budget ?? { treeVisits: 0, entryVisits: 0, metadataBytes: 0 };
    const ancestors = new Set();
    const walk = async (oid, parent) => {
      if (Date.now() >= lifecycle.deadline) throw makeError("GIT_EXECUTION_TIMEOUT");
      activeBudget.treeVisits += 1;
      if (activeBudget.treeVisits > MAX_TREE_OBJECTS || ancestors.has(oid)) {
        fail(ancestors.has(oid) ? "TARGET_ARTIFACT_INVALID" : "TARGET_LIMIT_EXCEEDED", "Git tree traversal exceeds its limit");
      }
      ancestors.add(oid);
      try {
        let entries = trees.get(oid);
        if (!entries) {
          const object = await session.get(oid, MAX_TREE_OBJECT_BYTES, "tree");
          activeBudget.metadataBytes += object.bytes.length;
          if (activeBudget.metadataBytes > MAX_TREE_METADATA_BYTES) fail("TARGET_LIMIT_EXCEEDED", "Git tree metadata exceeds its limit");
          entries = parseTree(object.bytes, repository.objectFormat);
          trees.set(oid, entries);
        }
        for (const entry of entries) {
          if (Date.now() >= lifecycle.deadline) throw makeError("GIT_EXECUTION_TIMEOUT");
          activeBudget.entryVisits += 1;
          if (activeBudget.entryVisits > MAX_TREE_ENTRY_VISITS) fail("TARGET_LIMIT_EXCEEDED", "Git tree entries exceed their traversal limit");
          if (entry.name === null) {
            if (prefixes.includes(".") || (parent !== "" && selectedPath(parent, prefixes))) {
              fail("TARGET_TYPE_UNSUPPORTED", "Selected Git path is not valid UTF-8");
            }
            continue;
          }
          const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
          if (entry.mode === "40000") {
            if (prefixIntersects(path, prefixes)) await walk(entry.oid, path);
          } else if (selectedPath(path, prefixes)) {
            if (files.size >= MAX_GIT_COMMIT_MEMBERS) fail("TARGET_LIMIT_EXCEEDED", "Git target has too many selected members");
            if (Buffer.byteLength(path, "utf8") > 1024 || !validGitMemberPath(path) || sensitivePath(path)) {
              fail(sensitivePath(path) ? "TARGET_SENSITIVE_PATH_DENIED" : "TARGET_TYPE_UNSUPPORTED", "Selected Git path is unsupported");
            }
            if (!["100644", "100755"].includes(entry.mode)) fail("TARGET_TYPE_UNSUPPORTED", "Selected Git tree mode is unsupported");
            files.set(path, Object.freeze({ path, mode: entry.mode, oid: entry.oid }));
          }
        }
        return entries;
      } finally {
        ancestors.delete(oid);
      }
    };
    await walk(rootOid, "");
    return Object.freeze({ files, trees, metadataBytes: activeBudget.metadataBytes });
  }

  async #lookupPath(session, repository, rootOid, path) {
    let treeOid = rootOid;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const object = await session.get(treeOid, MAX_TREE_OBJECT_BYTES, "tree");
      const entry = parseTree(object.bytes, repository.objectFormat).find((candidate) => candidate.name === parts[index]);
      if (!entry) return null;
      if (index === parts.length - 1) return entry;
      if (entry.mode !== "40000") return null;
      treeOid = entry.oid;
    }
    return null;
  }

  async #captureAttributes(session, repository, headTreeOid, changedPaths) {
    const paths = new Set([".gitattributes"]);
    for (const path of changedPaths) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        paths.add(`${parts.slice(0, index).join("/")}/.gitattributes`);
      }
    }
    const attributes = new Map();
    let total = 0;
    for (const path of [...paths].sort(utf8Compare)) {
      const entry = await this.#lookupPath(session, repository, headTreeOid, path);
      if (!entry) continue;
      if (!["100644", "100755"].includes(entry.mode)) fail("TARGET_TYPE_UNSUPPORTED", "Git attributes mode is unsupported");
      const object = await session.get(entry.oid, MAX_ATTRIBUTE_BYTES, "blob");
      decodeReviewText(object.bytes);
      if (!attributes.has(entry.oid)) total += object.bytes.length;
      if (total > MAX_ATTRIBUTE_BYTES) fail("TARGET_LIMIT_EXCEEDED", "Git attributes exceed their fixed limit");
      attributes.set(entry.oid, Object.freeze({ path, digest: sha256(object.bytes), bytes: object.bytes.length }));
    }
    return attributes;
  }

  async #setupSandbox(lifecycle, objectFormat) {
    const config = objectFormat === "sha1"
      ? "[core]\n\trepositoryformatversion = 0\n\tbare = true\n"
      : "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n";
    await Promise.all([
      mkdir(join(lifecycle.sandbox, "objects", "pack"), { recursive: true, mode: 0o700 }),
      mkdir(join(lifecycle.sandbox, "refs"), { recursive: true, mode: 0o700 }),
    ]);
    await writeExclusiveSynced(join(lifecycle.sandbox, "HEAD"), "ref: refs/heads/__tiangong__\n");
    await writeExclusiveSynced(join(lifecycle.sandbox, "config"), config);
    await syncDirectory(join(lifecycle.sandbox, "objects", "pack"));
    await syncDirectory(join(lifecycle.sandbox, "objects"));
    await syncDirectory(join(lifecycle.sandbox, "refs"));
    await syncDirectory(lifecycle.sandbox);
    lifecycle.sandboxBytes += Buffer.byteLength(config) + Buffer.byteLength("ref: refs/heads/__tiangong__\n");
  }

  async #withLifecycle(repositoryPath, callback, {
    postAdmission = false,
    invocationIdentity,
    onValidated = null,
  } = {}) {
    await this.initialize();
    const lock = await openLockTarget(this.#lockPath, this.#sessionHash);
    try {
      return await withKernelFileLock(lock.handle, async () => {
        const residues = await this.#residues();
        for (const name of residues) await rm(join(this.#tmpSessionRoot, name), { recursive: true, force: true });
        if (residues.length > 0) await syncDirectory(this.#tmpSessionRoot);
        const operationIdentity = typeof invocationIdentity === "string" && /^[a-f0-9]{64}$/u.test(invocationIdentity)
          ? invocationIdentity
          : sha256(canonicalJson({ schemaId: "tiangong.local-git-operation.v1", repositoryPath }));
        const sandbox = join(this.#tmpSessionRoot, `git-op-${operationIdentity}-${randomUUID()}`);
        await mkdir(sandbox, { mode: 0o700 });
        const lifecycle = {
          sandbox,
          deadline: Date.now() + OPERATION_TIMEOUT_MS,
          children: 0,
          sandboxBytes: 0,
          looseBytes: 0,
          mirroredLoose: new Set(),
          sourceHandles: [],
          directoryBindings: [],
        };
        let failed = false;
        try {
          await this.#version(lifecycle);
          const repository = await this.#repository(lifecycle, repositoryPath, { postAdmission });
          await this.#setupSandbox(lifecycle, repository.objectFormat);
          await this.#mirrorPacks(repository, lifecycle);
          const result = await callback(lifecycle, repository);
          await this.#finalRepository(repository, lifecycle, { postAdmission });
          if (onValidated) {
            try {
              const validated = await onValidated(result);
              if (Date.now() >= lifecycle.deadline) throw makeError("GIT_EXECUTION_TIMEOUT");
              await validateLockTarget(lock);
              return validated;
            } catch (error) {
              if (error?.localGitCode) throw error;
              throw new LifecycleCallbackError(error);
            }
          }
          await validateLockTarget(lock);
          return result;
        } catch (error) {
          failed = true;
          if (error?.name === "LifecycleCallbackError") throw error;
          if (error?.name === "PracticeRunError") {
            if (postAdmission && error.code === "TARGET_CHANGED_DURING_CAPTURE") {
              fail("TARGET_CHANGED", "Pinned Git source changed during consume");
            }
            if (postAdmission && [
              "GIT_REPOSITORY_UNSUPPORTED", "TARGET_NOT_FOUND", "TARGET_UNAVAILABLE",
              "TARGET_SYMLINK_DENIED", "TARGET_LIMIT_EXCEEDED",
            ].includes(error.code)) {
              fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git repository is unavailable");
            }
            throw error;
          }
          if (error?.localGitCode) fail(error.localGitCode, "Local Git operation failed");
          fail(postAdmission ? "GIT_OBJECT_UNAVAILABLE" : "GIT_EXECUTION_FAILED", "Local Git operation failed");
        } finally {
          await Promise.all(lifecycle.sourceHandles.map((sourceHandle) => sourceHandle.close().catch(() => {})));
          try {
            await rm(sandbox, { recursive: true, force: true });
            await syncDirectory(this.#tmpSessionRoot);
          } catch {
            if (!failed) fail("GIT_EXECUTION_FAILED", "Local Git sandbox cleanup failed");
          }
        }
      }, { timeoutSeconds: ARTIFACT_LOCK_TIMEOUT_SECONDS });
    } catch (error) {
      if (error?.name === "LifecycleCallbackError") throw error.cause;
      if (error?.name === "PracticeRunError") throw error;
      fail("GIT_EXECUTION_LOCK_FAILED", "Local Git lifecycle lock failed");
    } finally {
      await Promise.all([...lock.handles].reverse().map((handle) => handle.close().catch(() => {})));
    }
  }

  #repositoryIdentity(repositoryPath, repository) {
    const gitDirectoryPath = repositoryPath === "." ? ".git" : `${repositoryPath}/.git`;
    return sha256(canonicalJson({
      schemaId: "tiangong.git-repository.v1",
      repositoryPath,
      gitDirectoryPath,
      objectFormat: repository.objectFormat,
      repositoryFormat: repository.repositoryFormat,
      refStorage: "files-v1",
      objectStorage: "local-only-v1",
    }));
  }

  async captureCommit(request, { invocationIdentity, onValidated } = {}) {
    return this.#withLifecycle(request.repositoryPath, async (lifecycle, repository) => {
      const session = await this.#batch(lifecycle, repository);
      try {
        const requestedOid = await this.#resolveRef(repository, request.ref);
        const peeled = await this.#peel(session, requestedOid, repository.objectFormat);
        const commit = parseHeaderBlock(peeled.commitBytes, "commit", repository.objectFormat);
        const walked = await this.#walkTree(lifecycle, session, repository, commit.treeOid, request.pathPrefixes);
        const members = [];
        let totalContentBytes = 0;
        let requiredConsumeSegments = 0;
        for (const entry of [...walked.files.values()].sort((left, right) => utf8Compare(left.path, right.path))) {
          if (members.length >= MAX_GIT_COMMIT_MEMBERS) fail("TARGET_LIMIT_EXCEEDED", "Git commit has too many selected members");
          const object = await session.get(entry.oid, MAX_BLOB_BYTES, "blob");
          const facts = contentFacts(object.bytes);
          totalContentBytes += facts.contentBytes;
          requiredConsumeSegments += facts.requiredConsumeSegments;
          if (totalContentBytes > MAX_COMMIT_CONTENT_BYTES || requiredConsumeSegments > 960) {
            fail("TARGET_LIMIT_EXCEEDED", "Git commit target exceeds its aggregate limit");
          }
          members.push(Object.freeze({
            path: entry.path,
            mode: entry.mode,
            blobOid: entry.oid,
            contentDigest: facts.contentDigest,
            contentBytes: facts.contentBytes,
            contentLines: facts.contentLines,
            encoding: "utf-8",
            requiredConsumeSegments: facts.requiredConsumeSegments,
          }));
        }
        if (members.length === 0) fail("TARGET_EMPTY", "Git commit selection is empty");
        const selectionDigest = sha256(canonicalJson({
          schemaId: "tiangong.git-selection.v1",
          repositoryPath: request.repositoryPath,
          pathPrefixes: request.pathPrefixes,
        }));
        const manifest = Object.freeze({
          schemaVersion: 1,
          kind: "git-tree-manifest",
          repositoryPath: request.repositoryPath,
          objectFormat: repository.objectFormat,
          commitOid: peeled.commitOid,
          treeOid: commit.treeOid,
          selectionDigest,
          members: Object.freeze(members),
        });
        const bytes = Buffer.from(canonicalJson(manifest), "utf8");
        if (bytes.length > MAX_GIT_MANIFEST_BYTES) fail("TARGET_LIMIT_EXCEEDED", "Git commit manifest exceeds its limit");
        return Object.freeze({
          manifest,
          bytes,
          facts: Object.freeze({
            objectFormat: repository.objectFormat,
            repositoryIdentity: this.#repositoryIdentity(request.repositoryPath, repository),
            gitPolicyVersion: GIT_POLICY_VERSION,
            gitVersion: this.#reportedVersion,
            commitOid: peeled.commitOid,
            treeOid: commit.treeOid,
            memberCount: members.length,
            totalContentBytes,
            requiredConsumeSegments,
            selectionDigest,
            manifestContentDigest: sha256(bytes),
          }),
        });
      } finally {
        await this.#closeBatch(session);
      }
    }, { invocationIdentity, onValidated });
  }

  async #diffPass(lifecycle, repository, request, pinned = null, firstFacts = null) {
    const session = await this.#batch(lifecycle, repository);
    try {
      let activePinned = pinned;
      if (!activePinned) {
        const base = await this.#peel(session, await this.#resolveRef(repository, request.baseRef), repository.objectFormat);
        const head = await this.#peel(session, await this.#resolveRef(repository, request.headRef), repository.objectFormat);
        if (base.commitOid === head.commitOid) fail("TARGET_EMPTY", "Git diff endpoints resolve to the same commit");
        const baseCommit = parseHeaderBlock(base.commitBytes, "commit", repository.objectFormat);
        const headCommit = parseHeaderBlock(head.commitBytes, "commit", repository.objectFormat);
        activePinned = Object.freeze({
          baseCommitOid: base.commitOid,
          headCommitOid: head.commitOid,
          baseTreeOid: baseCommit.treeOid,
          headTreeOid: headCommit.treeOid,
        });
      } else {
        const baseCommit = parseHeaderBlock(
          (await session.get(activePinned.baseCommitOid, MAX_COMMIT_OBJECT_BYTES, "commit")).bytes,
          "commit",
          repository.objectFormat,
        );
        const headCommit = parseHeaderBlock(
          (await session.get(activePinned.headCommitOid, MAX_COMMIT_OBJECT_BYTES, "commit")).bytes,
          "commit",
          repository.objectFormat,
        );
        if (baseCommit.treeOid !== activePinned.baseTreeOid || headCommit.treeOid !== activePinned.headTreeOid) {
          fail("TARGET_ARTIFACT_INVALID", "Git commit tree identities changed between passes");
        }
      }
      const traversalBudget = { treeVisits: 0, entryVisits: 0, metadataBytes: 0 };
      const baseWalk = await this.#walkTree(
        lifecycle, session, repository, activePinned.baseTreeOid, request.pathPrefixes, traversalBudget,
      );
      const headWalk = await this.#walkTree(
        lifecycle, session, repository, activePinned.headTreeOid, request.pathPrefixes, traversalBudget,
      );
      const paths = [...new Set([...baseWalk.files.keys(), ...headWalk.files.keys()])].sort(utf8Compare);
      const changes = [];
      const blobFacts = new Map();
      let sourceBytes = 0;
      for (const path of paths) {
        const old = baseWalk.files.get(path) ?? null;
        const next = headWalk.files.get(path) ?? null;
        if (old?.mode === next?.mode && old?.oid === next?.oid) continue;
        if (changes.length >= MAX_GIT_CHANGED_PATHS) fail("TARGET_LIMIT_EXCEEDED", "Git diff has too many changed paths");
        if (!SAFE_DIFF_PATH.test(path)) fail("TARGET_TYPE_UNSUPPORTED", "Git diff path cannot be represented canonically");
        changes.push(Object.freeze({ path, old, next }));
        for (const side of [old, next]) {
          if (!side || blobFacts.has(side.oid)) continue;
          const object = await session.get(side.oid, MAX_BLOB_BYTES, "blob");
          const facts = contentFacts(object.bytes);
          sourceBytes += facts.contentBytes;
          if (sourceBytes > MAX_DIFF_SOURCE_BYTES) fail("TARGET_LIMIT_EXCEEDED", "Git diff source exceeds its limit");
          blobFacts.set(side.oid, Object.freeze({ digest: facts.contentDigest, bytes: facts.contentBytes }));
        }
      }
      if (changes.length === 0) fail("TARGET_EMPTY", "Git diff selection is empty");
      const attributes = await this.#captureAttributes(session, repository, activePinned.headTreeOid, changes.map((entry) => entry.path));
      for (const [oid, value] of attributes) {
        if (!blobFacts.has(oid)) {
          sourceBytes += value.bytes;
          if (sourceBytes > MAX_DIFF_SOURCE_BYTES) fail("TARGET_LIMIT_EXCEEDED", "Git diff source exceeds its limit");
        }
      }
      const width = repository.objectFormat === "sha1" ? 40 : 64;
      const rawArgs = [
        ...GIT_GLOBAL_PREFIX,
        `--attr-source=${activePinned.headCommitOid}`,
        "diff-tree", "--raw", "-r", "-z", "--no-commit-id", "--no-renames", `--abbrev=${width}`,
        activePinned.baseCommitOid, activePinned.headCommitOid, "--", ...request.pathPrefixes,
      ];
      const raw = await this.#runBuffered(lifecycle, rawArgs, { object: true, maxStdout: 2 * 1024 * 1024 });
      if (raw.code !== 0 || raw.signal !== null) fail("GIT_EXECUTION_FAILED", "Git raw diff execution failed");
      const parsedRaw = this.#parseRawDiff(raw.stdout, repository.objectFormat);
      const expectedRaw = changes.map((change) => ({
        path: change.path,
        oldMode: change.old?.mode ?? "000000",
        newMode: change.next?.mode ?? "000000",
        oldOid: change.old?.oid ?? zeroOid(repository.objectFormat),
        newOid: change.next?.oid ?? zeroOid(repository.objectFormat),
        status: change.old ? change.next ? "M" : "D" : "A",
      }));
      if (canonicalJson(parsedRaw) !== canonicalJson(expectedRaw)) fail("TARGET_ARTIFACT_INVALID", "Git raw diff conflicts with pinned trees");
      const patchArgs = [
        ...GIT_GLOBAL_PREFIX,
        `--attr-source=${activePinned.headCommitOid}`,
        "diff-tree", "--no-commit-id", "-r", "-p", "--no-renames", "--no-ext-diff", "--no-textconv",
        "--no-color", "--full-index", "--unified=3", "--diff-algorithm=myers", "--no-indent-heuristic",
        "--src-prefix=a/", "--dst-prefix=b/", activePinned.baseCommitOid, activePinned.headCommitOid,
        "--", ...request.pathPrefixes,
      ];
      const patch = await this.#runBuffered(lifecycle, patchArgs, { object: true, maxStdout: MAX_GIT_DIFF_BYTES });
      if (patch.code !== 0 || patch.signal !== null) fail("GIT_EXECUTION_FAILED", "Git patch execution failed");
      const patchFacts = contentFacts(patch.stdout);
      if (patch.stdout.length === 0) fail("TARGET_EMPTY", "Git diff selection is empty");
      this.#validatePatchFraming(patchFacts.text, expectedRaw.map((entry) => entry.path));
      const facts = Object.freeze({
        rawDigest: sha256(raw.stdout),
        patchDigest: patchFacts.contentDigest,
        blobs: Object.freeze([...blobFacts.entries()].sort(([left], [right]) => left.localeCompare(right))),
        attributes: Object.freeze([...attributes.entries()].sort(([left], [right]) => left.localeCompare(right))),
      });
      if (firstFacts && canonicalJson(firstFacts) !== canonicalJson(facts)) {
        fail("TARGET_ARTIFACT_INVALID", "Git diff passes disagree on the immutable mirror");
      }
      return Object.freeze({ changes, patchFacts, facts, pinned: activePinned });
    } finally {
      await this.#closeBatch(session);
    }
  }

  #parseRawDiff(bytes, objectFormat) {
    const output = [];
    let offset = 0;
    const width = objectFormat === "sha1" ? 40 : 64;
    while (offset < bytes.length) {
      const headerEnd = bytes.indexOf(0, offset);
      const pathEnd = headerEnd < 0 ? -1 : bytes.indexOf(0, headerEnd + 1);
      if (headerEnd < 0 || pathEnd < 0) fail("TARGET_ARTIFACT_INVALID", "Git raw diff framing is invalid");
      const header = strictAscii(bytes.subarray(offset, headerEnd), "TARGET_ARTIFACT_INVALID", "Git raw diff framing is invalid");
      const match = new RegExp(`^:(000000|100644|100755) (000000|100644|100755) ([a-f0-9]{${width}}) ([a-f0-9]{${width}}) ([ADMT])$`, "u").exec(header);
      if (!match) fail("TARGET_TYPE_UNSUPPORTED", "Git raw diff mode is unsupported");
      let path;
      try { path = UTF8.decode(bytes.subarray(headerEnd + 1, pathEnd)); }
      catch { fail("TARGET_TYPE_UNSUPPORTED", "Git diff path is not valid UTF-8"); }
      output.push(Object.freeze({ path, oldMode: match[1], newMode: match[2], oldOid: match[3], newOid: match[4], status: match[5] }));
      offset = pathEnd + 1;
    }
    return Object.freeze(output);
  }

  #validatePatchFraming(text, paths) {
    const lines = text.split("\n");
    if (lines.some((line) => line.startsWith("GIT binary patch") || line.startsWith("Binary files ")
        || line.startsWith("Submodule "))) {
      fail("TARGET_TYPE_UNSUPPORTED", "Git patch contains unsupported content");
    }
    const found = text.split("\n")
      .filter((line) => line.startsWith("diff --git "))
      .map((line) => {
        const match = /^diff --git a\/([^ ]+) b\/([^ ]+)$/u.exec(line);
        if (!match || match[1] !== match[2]) fail("TARGET_ARTIFACT_INVALID", "Git patch path framing is invalid");
        return match[1];
      });
    if (canonicalJson(found) !== canonicalJson(paths)) fail("TARGET_ARTIFACT_INVALID", "Git patch paths conflict with raw diff");
  }

  async captureDiff(request, { invocationIdentity, onValidated } = {}) {
    return this.#withLifecycle(request.repositoryPath, async (lifecycle, repository) => {
      const first = await this.#diffPass(lifecycle, repository, request);
      const pinned = first.pinned;
      const second = await this.#diffPass(lifecycle, repository, request, pinned, first.facts);
      if (!first.patchFacts.buffer.equals(second.patchFacts.buffer)) fail("TARGET_ARTIFACT_INVALID", "Git patch passes disagree");
      return Object.freeze({
        bytes: first.patchFacts.buffer,
        facts: Object.freeze({
          objectFormat: repository.objectFormat,
          repositoryIdentity: this.#repositoryIdentity(request.repositoryPath, repository),
          gitPolicyVersion: GIT_POLICY_VERSION,
          gitVersion: this.#reportedVersion,
          baseCommitOid: pinned.baseCommitOid,
          headCommitOid: pinned.headCommitOid,
          changedFileCount: first.changes.length,
          diffContentDigest: first.patchFacts.contentDigest,
          diffContentBytes: first.patchFacts.contentBytes,
          diffContentLines: first.patchFacts.contentLines,
          requiredConsumeSegments: first.patchFacts.requiredConsumeSegments,
        }),
      });
    }, { invocationIdentity, onValidated });
  }

  async readCommitBlob({
    repositoryPath,
    objectFormat,
    blobOid,
    expected,
    invocationIdentity,
    onValidated,
  }) {
    return this.#withLifecycle(repositoryPath, async (lifecycle, repository) => {
      if (repository.objectFormat !== objectFormat) fail("GIT_OBJECT_UNAVAILABLE", "Pinned Git object format is unavailable");
      const session = await this.#batch(lifecycle, repository);
      try {
        const object = await session.get(blobOid, MAX_BLOB_BYTES, "blob");
        const facts = contentFacts(object.bytes);
        if (facts.contentDigest !== expected.contentDigest || facts.contentBytes !== expected.contentBytes
            || facts.contentLines !== expected.contentLines || facts.requiredConsumeSegments !== expected.requiredConsumeSegments) {
          fail("TARGET_ARTIFACT_INVALID", "Pinned Git blob conflicts with its manifest");
        }
        return facts;
      } finally {
        await this.#closeBatch(session);
      }
    }, { postAdmission: true, invocationIdentity, onValidated });
  }
}
