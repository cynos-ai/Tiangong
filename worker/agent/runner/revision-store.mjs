import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";
import { createChangeRevisionRef, isChangeRevisionRef } from "../work/change-revision-ref.mjs";
import { inspectRunnerFixture } from "./docker-executor.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const INVOCATION = DIGEST;
const CAPTURE_PATH = "/workspace/scratch/revision";
const MAX_ARCHIVE_OUTPUT_BYTES = 96 * 1024 * 1024;

const ARCHIVE_SCRIPT = String.raw`
import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
const root = "/workspace/scratch/revision";
let count = 0;
let bytes = 0;
async function walk(directory, prefix = "") {
  const handle = await opendir(directory);
  const children = [];
  for await (const entry of handle) children.push(entry);
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of children) {
    count += 1;
    if (count > 4096) throw new Error("archive entry limit exceeded");
    const entryPath = directory + "/" + entry.name;
    const relativePath = prefix ? prefix + "/" + entry.name : entry.name;
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) throw new Error("archive link rejected");
    if (metadata.isDirectory()) {
      process.stdout.write(JSON.stringify(["d", relativePath]) + "\n");
      await walk(entryPath, relativePath);
    } else if (metadata.isFile()) {
      if (metadata.nlink !== 1) throw new Error("archive hard link rejected");
      const content = await readFile(entryPath);
      bytes += content.length;
      if (bytes > 67108864) throw new Error("archive byte limit exceeded");
      process.stdout.write(JSON.stringify([
        "f", relativePath, Boolean(metadata.mode & 0o111), content.length,
        createHash("sha256").update(content).digest("hex"), content.toString("base64"),
      ]) + "\n");
    } else {
      throw new Error("archive entry rejected");
    }
  }
}
await walk(root);
`;

function demand(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} has an invalid format`);
  return value;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function makeTreeReadOnly(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) throw new Error("ChangeRevision contains a symbolic link");
    if (metadata.isDirectory()) {
      await makeTreeReadOnly(entryPath);
      await chmod(entryPath, 0o500);
    } else if (metadata.isFile()) {
      if (metadata.nlink !== 1) throw new Error("ChangeRevision contains a hard-linked file");
      await chmod(entryPath, metadata.mode & 0o111 ? 0o500 : 0o400);
    } else {
      throw new Error("ChangeRevision contains an unsupported entry");
    }
  }
  await chmod(root, 0o500);
}

function archivePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0") ||
      value.startsWith("/") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("ChangeRevision archive path is invalid");
  }
  return value;
}

async function materializeArchive(text, staging) {
  if (typeof text !== "string" || text === "" || !text.endsWith("\n")) {
    throw new Error("ChangeRevision archive is empty or partial");
  }
  let count = 0;
  let bytes = 0;
  let previousPath = "";
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const entry = JSON.parse(line);
    if (!Array.isArray(entry) || ![2, 6].includes(entry.length) || !["d", "f"].includes(entry[0])) {
      throw new Error("ChangeRevision archive entry is invalid");
    }
    const relativePath = archivePath(entry[1]);
    if (seen.has(relativePath) || (previousPath && relativePath.localeCompare(previousPath) <= 0)) {
      throw new Error("ChangeRevision archive order or path is ambiguous");
    }
    const relativeParent = dirname(relativePath);
    if (relativeParent !== "." && !seen.has(relativeParent)) {
      throw new Error("ChangeRevision archive omits a parent directory");
    }
    seen.add(relativePath);
    previousPath = relativePath;
    count += 1;
    if (count > 4096) throw new Error("ChangeRevision archive has too many entries");
    const target = resolve(staging, relativePath);
    if (!target.startsWith(`${staging}${sep}`)) throw new Error("ChangeRevision archive escapes staging");
    if (entry[0] === "d") {
      await mkdir(target, { recursive: false, mode: 0o700 });
      continue;
    }
    const [, , executable, size, digest, encoded] = entry;
    if (typeof executable !== "boolean" || !Number.isSafeInteger(size) || size < 0 || !DIGEST.test(digest) ||
        typeof encoded !== "string") {
      throw new Error("ChangeRevision archive file metadata is invalid");
    }
    const content = Buffer.from(encoded, "base64");
    if (content.length !== size || content.toString("base64") !== encoded ||
        createHash("sha256").update(content).digest("hex") !== digest) {
      throw new Error("ChangeRevision archive file digest is invalid");
    }
    bytes += content.length;
    if (bytes > 64 * 1024 * 1024) throw new Error("ChangeRevision archive exceeds its byte bound");
    await writeFile(target, content, { flag: "wx", mode: executable ? 0o700 : 0o600 });
  }
}

function recordFor({ producerTaskId, revision, invocationKey, ref }) {
  const base = {
    kind: "tiangong.runner-change-revision",
    schemaVersion: 1,
    producerTaskId,
    revision,
    invocationKey,
    changeRevisionRef: ref,
  };
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

function validateRecord(value, producerTaskId) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.kind !== "tiangong.runner-change-revision" || value.schemaVersion !== 1 ||
      value.producerTaskId !== producerTaskId || !Number.isInteger(value.revision) || value.revision < 0 ||
      !INVOCATION.test(value.invocationKey) || !isChangeRevisionRef(value.changeRevisionRef)) {
    throw new Error("Runner ChangeRevision record is invalid");
  }
  const { contentDigest, ...base } = value;
  if (!DIGEST.test(contentDigest) || contentDigest !== sha256(canonicalJson(base)) ||
      value.changeRevisionRef.producerTaskId !== producerTaskId ||
      value.changeRevisionRef.revision !== value.revision) {
    throw new Error("Runner ChangeRevision record digest or binding is invalid");
  }
  return value;
}

export class ChangeRevisionStore {
  #root;
  #runDocker;

  constructor({ rootDir, runDocker }) {
    if (typeof rootDir !== "string" || !rootDir.startsWith("/") || typeof runDocker !== "function") {
      throw new TypeError("ChangeRevisionStore requires an absolute root and Docker command runner");
    }
    this.#root = resolve(rootDir);
    this.#runDocker = runDocker;
  }

  #identity(producerTaskId) {
    const task = demand(producerTaskId, ID, "producerTaskId");
    const taskKey = sha256(task);
    return Object.freeze({
      task,
      taskKey,
      recordPath: join(this.#root, "records", `${taskKey}.json`),
      lockPath: join(this.#root, "locks", taskKey),
      stagingRoot: join(this.#root, "staging"),
      objectsRoot: join(this.#root, "objects"),
    });
  }

  async #readRecord(identity) {
    let bytes;
    try {
      const metadata = await lstat(identity.recordPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > 64 * 1024) {
        throw new Error("Runner ChangeRevision record is not a bounded regular file");
      }
      if ((metadata.mode & 0o077) !== 0) await chmod(identity.recordPath, 0o600);
      bytes = await readFile(identity.recordPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    return validateRecord(JSON.parse(bytes), identity.task);
  }

  async lookup(producerTaskId) {
    const identity = this.#identity(producerTaskId);
    return withFileLock(identity.lockPath, async () => {
      const record = await this.#readRecord(identity);
      if (!record) return undefined;
      const directory = resolve(this.#root, record.changeRevisionRef.artifactPath);
      if (!directory.startsWith(`${this.#root}${sep}`)) throw new Error("ChangeRevision artifact path escapes its store");
      const inspected = await inspectRunnerFixture(directory);
      if (inspected.digest !== record.changeRevisionRef.artifactDigest) {
        throw new Error("ChangeRevision artifact digest does not match its immutable record");
      }
      return Object.freeze({ record, directory, ref: record.changeRevisionRef });
    });
  }

  async assertAvailable(producerTaskId, invocationKey) {
    demand(invocationKey, INVOCATION, "invocationKey");
    const existing = await this.lookup(producerTaskId);
    if (existing && existing.record.invocationKey !== invocationKey) {
      throw new Error("A different immutable ChangeRevision is already sealed for this Task");
    }
    return existing;
  }

  async capture({ containerName, producerTaskId, revision, invocationKey }) {
    demand(containerName, ID, "containerName");
    demand(invocationKey, INVOCATION, "invocationKey");
    if (!Number.isInteger(revision) || revision < 0) throw new TypeError("revision must be a non-negative integer");
    const identity = this.#identity(producerTaskId);
    return withFileLock(identity.lockPath, async () => {
      const existing = await this.#readRecord(identity);
      if (existing) {
        if (existing.invocationKey !== invocationKey || existing.revision !== revision) {
          throw new Error("A different immutable ChangeRevision is already sealed for this Task");
        }
        const directory = resolve(this.#root, existing.changeRevisionRef.artifactPath);
        if (!directory.startsWith(`${this.#root}${sep}`)) throw new Error("ChangeRevision artifact path escapes its store");
        const inspected = await inspectRunnerFixture(directory);
        if (inspected.digest !== existing.changeRevisionRef.artifactDigest) {
          throw new Error("ChangeRevision artifact digest does not match its immutable record");
        }
        return existing.changeRevisionRef;
      }

      await mkdir(identity.stagingRoot, { recursive: true, mode: 0o700 });
      await mkdir(identity.objectsRoot, { recursive: true, mode: 0o700 });
      const staging = join(identity.stagingRoot, `${identity.taskKey}-${invocationKey}`);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { mode: 0o700 });
      try {
        const archived = await this.#runDocker(
          [
            "container", "exec", "--user", "65532:65532", "--workdir", CAPTURE_PATH,
            containerName, "/usr/bin/node", "--input-type=module", "-e", ARCHIVE_SCRIPT,
          ],
          { timeoutMs: 30_000, outputLimitBytes: MAX_ARCHIVE_OUTPUT_BYTES },
        );
        if (archived.timedOut || archived.exitCode !== 0 || archived.stdoutTruncated || archived.stderrTruncated ||
            Buffer.byteLength(archived.stdout) > MAX_ARCHIVE_OUTPUT_BYTES) {
          throw new Error("RUNNER_REVISION_ARCHIVE_FAILED");
        }
        await materializeArchive(archived.stdout, staging);
        const inspected = await inspectRunnerFixture(staging);
        const artifactRelative = join("objects", identity.taskKey, inspected.digest);
        const artifactDirectory = join(this.#root, artifactRelative);
        await mkdir(dirname(artifactDirectory), { recursive: true, mode: 0o700 });
        try {
          await rename(staging, artifactDirectory);
        } catch (error) {
          if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
          throw new Error("ChangeRevision artifact destination already exists");
        }
        await makeTreeReadOnly(artifactDirectory);
        const ref = createChangeRevisionRef({
          producerTaskId: identity.task,
          artifactPath: artifactRelative,
          artifactDigest: inspected.digest,
          revision,
        });
        const record = recordFor({ producerTaskId: identity.task, revision, invocationKey, ref });
        await mkdir(dirname(identity.recordPath), { recursive: true, mode: 0o700 });
        const handle = await open(identity.recordPath, "wx", 0o600);
        try {
          await handle.writeFile(`${canonicalJson(record)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(dirname(identity.recordPath));
        return ref;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
}
