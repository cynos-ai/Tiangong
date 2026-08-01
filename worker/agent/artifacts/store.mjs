import { randomUUID as defaultRandomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import {
  ARTIFACT_LOCK_TIMEOUT_SECONDS,
  withKernelFileLock,
} from "../persistence/kernel-file-lock.mjs";
import { statePathsForSession } from "../persistence/state-paths.mjs";
import { artifactError, isCapturedArtifactError } from "./errors.mjs";
import { enforceArtifactQuota } from "./quota.mjs";
import {
  artifactProducerDefinition,
  validateArtifactProducerBytes,
} from "./producer-registry.mjs";
import {
  ARTIFACT_ID_PATTERN,
  ARTIFACT_REF_PATTERN,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS_PER_SESSION,
  MAX_ENVELOPE_BYTES,
  MAX_TEMP_BYTES_PER_SESSION,
  SHA256_PATTERN,
  contentIdentityEquals,
  contentIdentityFromEnvelope,
  decodeReviewText,
  deriveArtifactKey,
  deriveArtifactRefDigest,
  deriveEnvelopeDigest,
  receiptFromEnvelope,
  validateArtifactBinding,
  validateEnvelope,
  validateExpectedContentIdentity,
  validatePutInput,
} from "./schema.mjs";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEMP_DIRECTORY_PATTERN = /^tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SESSION_ENTRIES = Object.freeze(["objects", "store-lock-target", "tmp"]);
const OBJECT_ENTRIES = Object.freeze(["content", "envelope.json"]);
const JOURNAL_READ_KEYS = Object.freeze([
  "artifactKey",
  "artifactRef",
  "artifactRefDigest",
  "expectedBinding",
  "expectedContentIdentity",
]);
const EVIDENCE_READ_KEYS = Object.freeze([
  "artifactKey",
  "artifactRefDigest",
  "expectedBinding",
  "expectedContentIdentity",
]);
const sessionQueues = new Map();

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function modeOf(stat) {
  return stat.mode & 0o7777;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function throwMapped(error, code) {
  if (isCapturedArtifactError(error)) throw error;
  throw artifactError(code);
}

async function queued(key, callback) {
  const previous = sessionQueues.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => turn, () => turn);
  sessionQueues.set(key, tail);
  let timer;
  try {
    await Promise.race([
      previous.catch(() => {}),
      new Promise((resolvePromise, rejectPromise) => {
        timer = setTimeout(
          () => rejectPromise(artifactError("ARTIFACT_LOCK_FAILED")),
          ARTIFACT_LOCK_TIMEOUT_SECONDS * 1000,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    release();
    if (sessionQueues.get(key) === tail) sessionQueues.delete(key);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try {
    return await callback();
  } finally {
    release();
    if (sessionQueues.get(key) === tail) sessionQueues.delete(key);
  }
}

async function statOrNull(path, ioErrorCode) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throwMapped(error, ioErrorCode);
  }
}

async function openDirectory(path, ioErrorCode) {
  try {
    return await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR" || isMissing(error)) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    throwMapped(error, ioErrorCode);
  }
}

async function openBootstrapNode(path, { directory, flags }) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await open(path, flags, FILE_MODE);
    } catch (error) {
      if (error?.code !== "EACCES" && error?.code !== "EPERM") {
        if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
          throw artifactError("ARTIFACT_STORE_CORRUPTED");
        }
        throwMapped(error, "ARTIFACT_WRITE_FAILED");
      }
      const stat = await statOrNull(path, "ARTIFACT_READ_FAILED");
      if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
        throw artifactError("ARTIFACT_STORE_CORRUPTED");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw artifactError("ARTIFACT_WRITE_FAILED");
}

async function syncDirectory(path, ioErrorCode) {
  const handle = await openDirectory(path, ioErrorCode);
  try {
    await handle.sync();
  } catch (error) {
    throwMapped(error, ioErrorCode);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function bootstrapDirectory(path, parentPath) {
  let created = false;
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throwMapped(error, "ARTIFACT_WRITE_FAILED");
  }
  const stat = await statOrNull(path, "ARTIFACT_READ_FAILED");
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  if (created) {
    try {
      await chmod(path, DIRECTORY_MODE);
    } catch (error) {
      throwMapped(error, "ARTIFACT_WRITE_FAILED");
    }
  }
  const handle = await openBootstrapNode(path, {
    directory: true,
    flags: fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  });
  try {
    await handle.sync();
  } catch (error) {
    throwMapped(error, "ARTIFACT_WRITE_FAILED");
  } finally {
    await handle.close().catch(() => {});
  }
  await syncDirectory(parentPath, "ARTIFACT_WRITE_FAILED");
}

async function bootstrapLockFile(path, parentPath) {
  const before = await statOrNull(path, "ARTIFACT_READ_FAILED");
  if (before && (!before.isFile() || before.isSymbolicLink())) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  const handle = await openBootstrapNode(path, {
    directory: false,
    flags: fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
  });
  let stat;
  try {
    stat = await handle.stat();
  } catch (error) {
    await handle.close().catch(() => {});
    throwMapped(error, "ARTIFACT_READ_FAILED");
  }
  if (!stat.isFile() || stat.size !== 0) {
    await handle.close().catch(() => {});
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  try {
    if (!before) await handle.chmod(FILE_MODE);
    await handle.sync();
    await syncDirectory(parentPath, "ARTIFACT_WRITE_FAILED");
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throwMapped(error, "ARTIFACT_WRITE_FAILED");
  }
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function repairNode(path, { directory, parentPath, ioErrorCode }) {
  let stat = await statOrNull(path, ioErrorCode);
  if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  const expectedMode = directory ? DIRECTORY_MODE : FILE_MODE;
  let repaired = false;
  if (modeOf(stat) !== expectedMode) {
    const original = stat;
    try {
      await chmod(path, expectedMode);
      stat = await lstat(path);
    } catch (error) {
      throwMapped(error, "ARTIFACT_STORE_CORRUPTED");
    }
    if (
      stat.isSymbolicLink()
      || (directory ? !stat.isDirectory() : !stat.isFile())
      || !sameNode(original, stat)
      || modeOf(stat) !== expectedMode
    ) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    repaired = true;
  }
  const handle = directory
    ? await openDirectory(path, ioErrorCode)
    : await openRegularFile(path, ioErrorCode);
  try {
    let openedStat;
    try {
      openedStat = await handle.stat();
    } catch (error) {
      throwMapped(error, ioErrorCode);
    }
    if (
      (directory ? !openedStat.isDirectory() : !openedStat.isFile())
      || !sameNode(stat, openedStat)
      || modeOf(openedStat) !== expectedMode
    ) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    if (repaired) {
      try {
        await handle.sync();
        await syncDirectory(parentPath, "ARTIFACT_STORE_CORRUPTED");
        const verified = await handle.stat();
        if (modeOf(verified) !== expectedMode || !sameNode(openedStat, verified)) {
          throw artifactError("ARTIFACT_STORE_CORRUPTED");
        }
      } catch (error) {
        throwMapped(error, "ARTIFACT_STORE_CORRUPTED");
      }
    }
    return openedStat;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function verifyOpenLockIdentity(handle, path) {
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !opened.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || opened.size !== 0
      || current.size !== 0
      || modeOf(opened) !== FILE_MODE
      || modeOf(current) !== FILE_MODE
      || !sameNode(opened, current)
    ) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
  } catch (error) {
    throwMapped(error, "ARTIFACT_STORE_CORRUPTED");
  }
}

async function repairOpenLockHandle(handle, path, parentPath) {
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== 0) throw artifactError("ARTIFACT_STORE_CORRUPTED");
    if (modeOf(stat) !== FILE_MODE) {
      await handle.chmod(FILE_MODE);
      await handle.sync();
      await syncDirectory(parentPath, "ARTIFACT_STORE_CORRUPTED");
    }
    await verifyOpenLockIdentity(handle, path);
  } catch (error) {
    throwMapped(error, "ARTIFACT_STORE_CORRUPTED");
  }
}

async function createLockedDirectory(path, parentPath, ioErrorCode) {
  const existing = await statOrNull(path, ioErrorCode);
  if (!existing) {
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
      await chmod(path, DIRECTORY_MODE);
    } catch (error) {
      throwMapped(error, "ARTIFACT_WRITE_FAILED");
    }
    await syncDirectory(path, "ARTIFACT_WRITE_FAILED");
    await syncDirectory(parentPath, "ARTIFACT_WRITE_FAILED");
  }
  await repairNode(path, { directory: true, parentPath, ioErrorCode });
}

async function openRegularFile(path, ioErrorCode) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw artifactError("ARTIFACT_STORE_CORRUPTED");
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "ELOOP" || error?.code === "EISDIR" || isMissing(error)) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    throwMapped(error, ioErrorCode);
  }
}

async function readDirectoryEntries(path, ioErrorCode) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    throwMapped(error, ioErrorCode);
  }
}

async function requireExactEntries(path, expected, ioErrorCode) {
  const entries = await readDirectoryEntries(path, ioErrorCode);
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== expected.length || !names.every((name, index) => name === expected[index])) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  return entries;
}

async function readEnvelopeWire(path, ioErrorCode) {
  const handle = await openRegularFile(path, ioErrorCode);
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_ENVELOPE_BYTES) throw artifactError("ARTIFACT_STORE_CORRUPTED");
    const wireBytes = await handle.readFile();
    if (wireBytes.byteLength > MAX_ENVELOPE_BYTES || wireBytes.byteLength !== stat.size) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(wireBytes);
    } catch {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    return { envelope, wireBytes };
  } catch (error) {
    throwMapped(error, ioErrorCode);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectObject(objectPath, artifactKey, sessionHash, ioErrorCode) {
  await repairNode(objectPath, {
    directory: true,
    parentPath: dirname(objectPath),
    ioErrorCode,
  });
  await requireExactEntries(objectPath, OBJECT_ENTRIES, ioErrorCode);
  const contentPath = join(objectPath, "content");
  const envelopePath = join(objectPath, "envelope.json");
  await repairNode(contentPath, { directory: false, parentPath: objectPath, ioErrorCode });
  await repairNode(envelopePath, { directory: false, parentPath: objectPath, ioErrorCode });
  const contentStat = await statOrNull(contentPath, ioErrorCode);
  if (!contentStat?.isFile() || contentStat.size > MAX_ARTIFACT_BYTES) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  const { envelope, wireBytes } = await readEnvelopeWire(envelopePath, ioErrorCode);
  const validated = validateEnvelope(envelope, {
    sessionHash,
    artifactKey,
    wireBytes,
    contentStatSize: contentStat.size,
  });
  return Object.freeze({
    objectPath,
    contentPath,
    envelopePath,
    envelope: validated,
  });
}

function quotaKey(parts) {
  return canonicalJson(parts);
}

function addQuota(map, key, contentBytes) {
  const value = map.get(key) ?? { count: 0, contentBytes: 0 };
  value.count += 1;
  value.contentBytes += contentBytes;
  map.set(key, value);
}

async function scanObjects(paths, ioErrorCode) {
  const entries = await readDirectoryEntries(paths.capturedArtifactObjectsDirectory, ioErrorCode);
  if (entries.length > MAX_ARTIFACTS_PER_SESSION) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  const objects = new Map();
  const usedArtifactIds = new Set();
  const quota = {
    session: { count: 0, contentBytes: 0 },
    runs: new Map(),
    targets: new Map(),
    operations: new Map(),
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SHA256_PATTERN.test(entry.name)) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    const inspected = await inspectObject(
      join(paths.capturedArtifactObjectsDirectory, entry.name),
      entry.name,
      paths.sessionHash,
      ioErrorCode,
    );
    if (usedArtifactIds.has(inspected.envelope.artifactId)) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    usedArtifactIds.add(inspected.envelope.artifactId);
    objects.set(entry.name, inspected);
    const { binding, contentBytes } = inspected.envelope;
    quota.session.count += 1;
    quota.session.contentBytes += contentBytes;
    addQuota(quota.runs, quotaKey([
      binding.sessionHash,
      binding.actorId,
      binding.practiceRunId,
    ]), contentBytes);
    addQuota(quota.targets, quotaKey([
      binding.sessionHash,
      binding.actorId,
      binding.practiceRunId,
      binding.targetId,
    ]), contentBytes);
    addQuota(quota.operations, quotaKey([
      binding.sessionHash,
      binding.actorId,
      binding.practiceRunId,
      binding.targetId,
      binding.invocationIdentity,
      binding.sourceOperationDigest,
    ]), contentBytes);
  }
  return Object.freeze({ objects, usedArtifactIds, quota });
}

async function removeOwnedTemp(tempPath, ioErrorCode) {
  const entries = await readDirectoryEntries(tempPath, ioErrorCode);
  const names = entries.map((entry) => entry.name).sort();
  const allowed = names.length === 0
    || (names.length === 1 && names[0] === "content")
    || (names.length === 2 && names[0] === "content" && names[1] === "envelope.json");
  if (!allowed) throw artifactError("ARTIFACT_STORE_CORRUPTED");
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw artifactError("ARTIFACT_STORE_CORRUPTED");
    const path = join(tempPath, entry.name);
    const stat = await statOrNull(path, ioErrorCode);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw artifactError("ARTIFACT_STORE_CORRUPTED");
    const maximum = entry.name === "content" ? MAX_ARTIFACT_BYTES + 1 : MAX_ENVELOPE_BYTES + 1;
    if (stat.size > maximum) throw artifactError("ARTIFACT_STORE_CORRUPTED");
    totalBytes += stat.size;
  }
  if (totalBytes > MAX_TEMP_BYTES_PER_SESSION) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  try {
    for (const name of names) await unlink(join(tempPath, name));
    await rmdir(tempPath);
  } catch (error) {
    throwMapped(error, ioErrorCode);
  }
}

async function cleanupTemporary(paths, ioErrorCode) {
  const entries = await readDirectoryEntries(paths.capturedArtifactTemporaryDirectory, ioErrorCode);
  if (entries.length > 1) throw artifactError("ARTIFACT_STORE_CORRUPTED");
  if (entries.length === 1) {
    const [entry] = entries;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !TEMP_DIRECTORY_PATTERN.test(entry.name)) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    await removeOwnedTemp(join(paths.capturedArtifactTemporaryDirectory, entry.name), ioErrorCode);
  }
  await syncDirectory(paths.capturedArtifactTemporaryDirectory, ioErrorCode);
}

async function readContent(inspected, ioErrorCode) {
  const handle = await openRegularFile(inspected.contentPath, ioErrorCode);
  try {
    const stat = await handle.stat();
    if (stat.size !== inspected.envelope.contentBytes || stat.size > MAX_ARTIFACT_BYTES) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength !== stat.size
      || sha256(bytes) !== inspected.envelope.contentDigest
    ) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    let decoded;
    try {
      decoded = decodeReviewText(bytes);
    } catch {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    const producer = artifactProducerDefinition(inspected.envelope.producerId);
    if (decoded.contentLines !== inspected.envelope.contentLines ||
        !producer || !validateArtifactProducerBytes(producer, bytes, inspected.envelope)) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    return Buffer.from(bytes);
  } catch (error) {
    throwMapped(error, ioErrorCode);
  } finally {
    await handle.close().catch(() => {});
  }
}

function enforceQuota(scan, binding, contentBytes) {
  const run = scan.quota.runs.get(quotaKey([
    binding.sessionHash,
    binding.actorId,
    binding.practiceRunId,
  ])) ?? { count: 0, contentBytes: 0 };
  const target = scan.quota.targets.get(quotaKey([
    binding.sessionHash,
    binding.actorId,
    binding.practiceRunId,
    binding.targetId,
  ])) ?? { count: 0, contentBytes: 0 };
  const operation = scan.quota.operations.get(quotaKey([
    binding.sessionHash,
    binding.actorId,
    binding.practiceRunId,
    binding.targetId,
    binding.invocationIdentity,
    binding.sourceOperationDigest,
  ])) ?? { count: 0, contentBytes: 0 };
  enforceArtifactQuota({
    session: scan.quota.session,
    run,
    target,
    operation,
  }, contentBytes);
}

function chooseArtifactId(randomUUID, usedArtifactIds) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const uuid = randomUUID();
    const artifactId = `artifact-${uuid}`;
    if (UUID_PATTERN.test(uuid) && ARTIFACT_ID_PATTERN.test(artifactId) && !usedArtifactIds.has(artifactId)) {
      return artifactId;
    }
  }
  throw artifactError("ARTIFACT_ID_GENERATION_FAILED");
}

function nextTempName(randomUUID) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const uuid = randomUUID();
    if (UUID_PATTERN.test(uuid)) return `tmp-${uuid}`;
  }
  throw artifactError("ARTIFACT_WRITE_FAILED");
}

function timestamp(clock) {
  try {
    const value = clock();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new TypeError();
    const iso = value.toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(iso)) throw new TypeError();
    return iso;
  } catch {
    throw artifactError("ARTIFACT_WRITE_FAILED");
  }
}

function createEnvelope(validated, artifactKey, artifactId, createdAt) {
  const artifactRef = `artifact-v1/${artifactId}`;
  const envelopeWithoutDigest = {
    schemaVersion: 1,
    artifactId,
    artifactRef,
    artifactRefDigest: deriveArtifactRefDigest({
      sessionHash: validated.binding.sessionHash,
      artifactRef,
    }),
    artifactKey,
    binding: validated.binding,
    purpose: validated.purpose,
    ordinal: validated.ordinal,
    contentDigest: validated.contentDigest,
    contentBytes: validated.contentBytes,
    contentLines: validated.contentLines,
    mediaType: validated.mediaType,
    encoding: validated.encoding,
    truncated: validated.truncated,
    producerId: validated.producerId,
    producerVersion: validated.producerVersion,
    transformVersion: validated.transformVersion,
    createdAt,
  };
  const envelope = {
    ...envelopeWithoutDigest,
    envelopeDigest: deriveEnvelopeDigest(envelopeWithoutDigest),
  };
  const wireBytes = Buffer.from(canonicalJson(envelope), "utf8");
  if (wireBytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw artifactError("ARTIFACT_LIMIT_EXCEEDED");
  }
  return Object.freeze({ envelope: Object.freeze(envelope), wireBytes });
}

async function writeNewFile(path, bytes) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      FILE_MODE,
    );
    await handle.chmod(FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    throwMapped(error, "ARTIFACT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function replayMatches(inspected, validated, bytes) {
  const expectedIdentity = {
    purpose: validated.purpose,
    ordinal: validated.ordinal,
    contentDigest: validated.contentDigest,
    contentBytes: validated.contentBytes,
    contentLines: validated.contentLines,
    mediaType: validated.mediaType,
    encoding: validated.encoding,
    truncated: validated.truncated,
    producerId: validated.producerId,
    producerVersion: validated.producerVersion,
    transformVersion: validated.transformVersion,
  };
  return canonicalJson(inspected.envelope.binding) === canonicalJson(validated.binding)
    && contentIdentityEquals(contentIdentityFromEnvelope(inspected.envelope), expectedIdentity)
    && bytes.equals(validated.canonicalBytes);
}

async function verifyReplay(inspected, validated, ioErrorCode) {
  const bytes = await readContent(inspected, ioErrorCode);
  if (!replayMatches(inspected, validated, bytes)) {
    throw artifactError("ARTIFACT_KEY_CONFLICT");
  }
  return receiptFromEnvelope(inspected.envelope, true);
}

function validateReadRequest(input, paths, journal) {
  const keys = journal ? JOURNAL_READ_KEYS : EVIDENCE_READ_KEYS;
  if (!exactKeys(input, keys)) throw artifactError("ARTIFACT_STORE_CORRUPTED");
  const binding = validateArtifactBinding(input.expectedBinding, paths.sessionHash);
  const identity = validateExpectedContentIdentity(input.expectedContentIdentity);
  if (
    typeof input.artifactKey !== "string"
    || !SHA256_PATTERN.test(input.artifactKey)
    || typeof input.artifactRefDigest !== "string"
    || !SHA256_PATTERN.test(input.artifactRefDigest)
    || deriveArtifactKey({
      binding,
      purpose: identity.purpose,
      ordinal: identity.ordinal,
    }) !== input.artifactKey
  ) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
  let artifactRef = null;
  if (journal) {
    if (typeof input.artifactRef !== "string" || !ARTIFACT_REF_PATTERN.test(input.artifactRef)) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
    artifactRef = input.artifactRef;
    if (deriveArtifactRefDigest({ sessionHash: paths.sessionHash, artifactRef }) !== input.artifactRefDigest) {
      throw artifactError("ARTIFACT_STORE_CORRUPTED");
    }
  }
  return Object.freeze({
    artifactKey: input.artifactKey,
    artifactRef,
    artifactRefDigest: input.artifactRefDigest,
    binding,
    identity,
  });
}

function verifyReadJoin(inspected, request) {
  if (
    inspected.envelope.artifactRefDigest !== request.artifactRefDigest
    || (request.artifactRef !== null && inspected.envelope.artifactRef !== request.artifactRef)
    || canonicalJson(inspected.envelope.binding) !== canonicalJson(request.binding)
    || !contentIdentityEquals(contentIdentityFromEnvelope(inspected.envelope), request.identity)
  ) {
    throw artifactError("ARTIFACT_STORE_CORRUPTED");
  }
}

export class CapturedArtifactStore {
  #paths;
  #clock;
  #randomUUID;

  constructor({ stateDirectory, sessionId, clock = () => new Date(), randomUUID = defaultRandomUUID }) {
    if (typeof clock !== "function" || typeof randomUUID !== "function") {
      throw new TypeError("clock and randomUUID must be functions");
    }
    this.#paths = statePathsForSession({ stateDirectory, sessionId });
    this.#clock = clock;
    this.#randomUUID = randomUUID;
  }

  get sessionHash() {
    return this.#paths.sessionHash;
  }

  async #bootstrapAndLock(callback) {
    return queued(this.#paths.capturedArtifactDirectory, async () => {
      await bootstrapDirectory(
        this.#paths.capturedArtifactsRoot,
        this.#paths.stateDirectory,
      );
      await bootstrapDirectory(
        this.#paths.capturedArtifactDirectory,
        this.#paths.capturedArtifactsRoot,
      );
      const lockHandle = await bootstrapLockFile(
        this.#paths.capturedArtifactLockPath,
        this.#paths.capturedArtifactDirectory,
      );
      let operationError = null;
      try {
        return await withKernelFileLock(
          lockHandle,
          async () => {
            await repairNode(this.#paths.capturedArtifactsRoot, {
              directory: true,
              parentPath: this.#paths.stateDirectory,
              ioErrorCode: "ARTIFACT_READ_FAILED",
            });
            await repairNode(this.#paths.capturedArtifactDirectory, {
              directory: true,
              parentPath: this.#paths.capturedArtifactsRoot,
              ioErrorCode: "ARTIFACT_READ_FAILED",
            });
            await repairOpenLockHandle(
              lockHandle,
              this.#paths.capturedArtifactLockPath,
              this.#paths.capturedArtifactDirectory,
            );
            await createLockedDirectory(
              this.#paths.capturedArtifactObjectsDirectory,
              this.#paths.capturedArtifactDirectory,
              "ARTIFACT_READ_FAILED",
            );
            await createLockedDirectory(
              this.#paths.capturedArtifactTemporaryDirectory,
              this.#paths.capturedArtifactDirectory,
              "ARTIFACT_READ_FAILED",
            );
            await requireExactEntries(
              this.#paths.capturedArtifactDirectory,
              SESSION_ENTRIES,
              "ARTIFACT_READ_FAILED",
            );
            await verifyOpenLockIdentity(lockHandle, this.#paths.capturedArtifactLockPath);
            const result = await callback();
            await verifyOpenLockIdentity(lockHandle, this.#paths.capturedArtifactLockPath);
            return result;
          },
          { timeoutSeconds: ARTIFACT_LOCK_TIMEOUT_SECONDS },
        );
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try {
          await lockHandle.close();
        } catch {
          if (operationError === null) throw artifactError("ARTIFACT_LOCK_FAILED");
        }
      }
    });
  }

  async put(input) {
    const validated = validatePutInput(input, this.#paths.sessionHash);
    const artifactKey = deriveArtifactKey(validated);
    return this.#bootstrapAndLock(async () => {
      await cleanupTemporary(this.#paths, "ARTIFACT_WRITE_FAILED");
      const scan = await scanObjects(this.#paths, "ARTIFACT_WRITE_FAILED");
      const existing = scan.objects.get(artifactKey);
      if (existing) return verifyReplay(existing, validated, "ARTIFACT_WRITE_FAILED");
      enforceQuota(scan, validated.binding, validated.contentBytes);
      const artifactId = chooseArtifactId(this.#randomUUID, scan.usedArtifactIds);
      const { envelope, wireBytes } = createEnvelope(
        validated,
        artifactKey,
        artifactId,
        timestamp(this.#clock),
      );
      const tempName = nextTempName(this.#randomUUID);
      const tempPath = join(this.#paths.capturedArtifactTemporaryDirectory, tempName);
      try {
        await mkdir(tempPath, { mode: DIRECTORY_MODE });
        await chmod(tempPath, DIRECTORY_MODE);
        await repairNode(tempPath, {
          directory: true,
          parentPath: this.#paths.capturedArtifactTemporaryDirectory,
          ioErrorCode: "ARTIFACT_WRITE_FAILED",
        });
      } catch (error) {
        throwMapped(error, "ARTIFACT_WRITE_FAILED");
      }
      await writeNewFile(join(tempPath, "content"), validated.canonicalBytes);
      await writeNewFile(join(tempPath, "envelope.json"), wireBytes);
      await syncDirectory(tempPath, "ARTIFACT_WRITE_FAILED");
      const objectPath = join(this.#paths.capturedArtifactObjectsDirectory, artifactKey);
      const destination = await statOrNull(objectPath, "ARTIFACT_WRITE_FAILED");
      if (destination !== null) {
        const collision = await inspectObject(
          objectPath,
          artifactKey,
          this.#paths.sessionHash,
          "ARTIFACT_WRITE_FAILED",
        );
        const replay = await verifyReplay(collision, validated, "ARTIFACT_WRITE_FAILED");
        await removeOwnedTemp(tempPath, "ARTIFACT_WRITE_FAILED");
        await syncDirectory(this.#paths.capturedArtifactTemporaryDirectory, "ARTIFACT_WRITE_FAILED");
        return replay;
      }
      try {
        await rename(tempPath, objectPath);
      } catch (error) {
        if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
          await removeOwnedTemp(tempPath, "ARTIFACT_WRITE_FAILED");
          await syncDirectory(this.#paths.capturedArtifactTemporaryDirectory, "ARTIFACT_WRITE_FAILED");
          const collision = await inspectObject(
            objectPath,
            artifactKey,
            this.#paths.sessionHash,
            "ARTIFACT_WRITE_FAILED",
          );
          return verifyReplay(collision, validated, "ARTIFACT_WRITE_FAILED");
        }
        throwMapped(error, "ARTIFACT_WRITE_FAILED");
      }
      await syncDirectory(this.#paths.capturedArtifactTemporaryDirectory, "ARTIFACT_WRITE_FAILED");
      await syncDirectory(this.#paths.capturedArtifactObjectsDirectory, "ARTIFACT_WRITE_FAILED");
      const written = await inspectObject(
        objectPath,
        artifactKey,
        this.#paths.sessionHash,
        "ARTIFACT_WRITE_FAILED",
      );
      const bytes = await readContent(written, "ARTIFACT_WRITE_FAILED");
      if (
        !replayMatches(written, validated, bytes)
        || canonicalJson(written.envelope) !== canonicalJson(envelope)
      ) {
        throw artifactError("ARTIFACT_STORE_CORRUPTED");
      }
      return receiptFromEnvelope(written.envelope, false);
    });
  }

  async readFromJournal(input) {
    return this.#read(input, true);
  }

  async readFromEvidence(input) {
    return this.#read(input, false);
  }

  async #read(input, journal) {
    const request = validateReadRequest(input, this.#paths, journal);
    return this.#bootstrapAndLock(async () => {
      await cleanupTemporary(this.#paths, "ARTIFACT_READ_FAILED");
      const scan = await scanObjects(this.#paths, "ARTIFACT_READ_FAILED");
      const inspected = scan.objects.get(request.artifactKey);
      if (!inspected) throw artifactError("ARTIFACT_STORE_CORRUPTED");
      verifyReadJoin(inspected, request);
      const bytes = await readContent(inspected, "ARTIFACT_READ_FAILED");
      return Object.freeze({
        envelope: Object.freeze({
          ...inspected.envelope,
          binding: Object.freeze({ ...inspected.envelope.binding }),
        }),
        bytes,
      });
    });
  }
}
