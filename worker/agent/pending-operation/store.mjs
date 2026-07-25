import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  idempotencyKey,
  operationDigest,
  operationRequestDigest,
  sha256,
} from "../canonical-json.mjs";

const SCHEMA_VERSION = 1;
const CONTENT_FILE = "write-content";
const ENVELOPE_FILE = "envelope.json";
const TERMINAL_FILE = "terminal.json";
const KEY_PATTERN = /^[a-f0-9]{64}$/u;

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  return value;
}

function validateKey(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new TypeError("idempotencyKey must be a lowercase SHA-256 digest");
  }
  return key;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(path, content) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertDigestBindings(value) {
  if (operationDigest(value.operation) !== value.operationDigest) {
    throw new Error("Pending operation digest mismatch");
  }
  if (operationRequestDigest(value.operation) !== value.requestDigest) {
    throw new Error("Pending operation request digest mismatch");
  }
  const expectedKey = idempotencyKey({
    sessionId: value.sessionId,
    turnId: value.turnId,
    toolCallId: value.toolCallId,
    operationDigest: value.operationDigest,
  });
  if (expectedKey !== value.idempotencyKey) throw new Error("Pending operation idempotency key mismatch");
}

function createEnvelope(checkpoint, params, createdAt) {
  const operationKey = validateKey(checkpoint?.idempotencyKey);
  const operation = checkpoint?.operation;
  if (operation?.toolName !== "write" || checkpoint?.toolName !== "write") {
    throw new Error("PendingOperationStore supports only constrained write operations");
  }
  if (typeof params?.content !== "string") throw new TypeError("write content must be a string");
  const contentDigest = sha256(params.content);
  const contentBytes = Buffer.byteLength(params.content);
  if (operation.input?.contentDigest !== contentDigest || operation.input?.contentBytes !== contentBytes) {
    throw new Error("Pending write payload does not match the approved operation");
  }

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    idempotencyKey: operationKey,
    sessionId: requiredString(checkpoint.sessionId, "sessionId"),
    turnId: requiredString(checkpoint.turnId, "turnId"),
    toolCallId: requiredString(checkpoint.toolCallId, "toolCallId"),
    toolName: "write",
    requestDigest: requiredString(checkpoint.requestDigest, "requestDigest"),
    operationDigest: requiredString(checkpoint.operationDigest, "operationDigest"),
    approvalId: requiredString(checkpoint.approvalId, "approvalId"),
    requestedBy: requiredString(checkpoint.requestedBy, "requestedBy"),
    operation: structuredClone(operation),
    payload: {
      kind: "write-content-v1",
      file: CONTENT_FILE,
      contentDigest,
      contentBytes,
    },
    createdAt: createdAt.toISOString(),
  };
  assertDigestBindings(envelope);
  return envelope;
}

function validateEnvelope(envelope, key) {
  if (envelope?.schemaVersion !== SCHEMA_VERSION || envelope.idempotencyKey !== key) {
    throw new Error("Unsupported pending operation envelope");
  }
  if (envelope.toolName !== "write" || envelope.operation?.toolName !== "write") {
    throw new Error("Unsupported pending operation tool");
  }
  if (envelope.payload?.kind !== "write-content-v1" || envelope.payload.file !== CONTENT_FILE) {
    throw new Error("Unsupported pending operation payload");
  }
  for (const field of [
    "sessionId",
    "turnId",
    "toolCallId",
    "requestDigest",
    "operationDigest",
    "approvalId",
    "requestedBy",
    "createdAt",
  ]) requiredString(envelope[field], field);
  requiredString(envelope.payload.contentDigest, "payload.contentDigest");
  if (!Number.isSafeInteger(envelope.payload.contentBytes) || envelope.payload.contentBytes < 0) {
    throw new Error("Invalid pending operation payload size");
  }
  if (envelope.operation.input?.contentDigest !== envelope.payload.contentDigest ||
      envelope.operation.input?.contentBytes !== envelope.payload.contentBytes) {
    throw new Error("Pending operation envelope payload metadata mismatch");
  }
  assertDigestBindings(envelope);
  return envelope;
}

function assertExpected(envelope, expected) {
  for (const field of [
    "idempotencyKey",
    "sessionId",
    "turnId",
    "toolCallId",
    "toolName",
    "requestDigest",
    "operationDigest",
    "approvalId",
    "requestedBy",
  ]) {
    if (expected?.[field] !== envelope[field]) {
      throw new Error(`Pending operation ${field} mismatch`);
    }
  }
  if (canonicalJson(expected.operation) !== canonicalJson(envelope.operation)) {
    throw new Error("Pending operation metadata mismatch");
  }
}

export class PendingOperationStore {
  #directory;
  #clock;
  #remoteStorage;

  constructor({ directory, clock = () => new Date(), remoteStorage }) {
    if (!directory) throw new TypeError("directory is required");
    this.#directory = directory;
    this.#clock = clock;
    this.#remoteStorage = remoteStorage;
  }

  #operationDirectory(key) {
    return join(this.#directory, validateKey(key));
  }

  async #hasTerminalMarker(key) {
    const terminalPath = join(this.#operationDirectory(key), TERMINAL_FILE);
    let terminalEntry;
    try {
      terminalEntry = await lstat(terminalPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!terminalEntry.isFile()) throw new Error("Invalid pending operation terminal marker type");
    if ((terminalEntry.mode & 0o077) !== 0) {
      await chmod(terminalPath, 0o600);
      terminalEntry = await lstat(terminalPath);
      if ((terminalEntry.mode & 0o077) !== 0) {
        throw new Error("Pending operation terminal marker permissions cannot be restricted");
      }
    }
    const terminal = JSON.parse(await readFile(terminalPath, "utf8"));
    if (terminal?.schemaVersion !== SCHEMA_VERSION || terminal.state !== "payload-erased" ||
        terminal.idempotencyKey !== key) {
      throw new Error("Invalid pending operation terminal marker");
    }
    return true;
  }

  async #read(key) {
    const directory = this.#operationDirectory(key);
    if (await this.#hasTerminalMarker(key)) throw new Error("Pending operation payload has been erased");
    const envelopePath = join(directory, ENVELOPE_FILE);
    const contentPath = join(directory, CONTENT_FILE);
    let [directoryEntry, envelopeEntry, contentEntry] = await Promise.all([
      lstat(directory),
      lstat(envelopePath),
      lstat(contentPath),
    ]);
    if (!directoryEntry.isDirectory() || !envelopeEntry.isFile() || !contentEntry.isFile()) {
      throw new Error("Pending operation storage contains an unexpected file type");
    }
    let permissionsRepaired = false;
    if ([directoryEntry, envelopeEntry, contentEntry].some((entry) => (entry.mode & 0o077) !== 0)) {
      await Promise.all([
        chmod(directory, 0o700),
        chmod(envelopePath, 0o600),
        chmod(contentPath, 0o600),
      ]);
      [directoryEntry, envelopeEntry, contentEntry] = await Promise.all([
        lstat(directory),
        lstat(envelopePath),
        lstat(contentPath),
      ]);
      if ((directoryEntry.mode & 0o077) !== 0 ||
          (envelopeEntry.mode & 0o077) !== 0 ||
          (contentEntry.mode & 0o077) !== 0) {
        throw new Error("Pending operation storage permissions cannot be restricted");
      }
      permissionsRepaired = true;
    }
    const envelope = validateEnvelope(
      JSON.parse(await readFile(envelopePath, "utf8")),
      key,
    );
    const content = await readFile(contentPath, "utf8");
    if (sha256(content) !== envelope.payload.contentDigest ||
        Buffer.byteLength(content) !== envelope.payload.contentBytes) {
      throw new Error("Pending operation payload integrity check failed");
    }
    return { envelope, content, permissionsRepaired };
  }

  async put(checkpoint, params) {
    const envelope = createEnvelope(checkpoint, params, this.#clock());
    const key = envelope.idempotencyKey;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });

    try {
      const existing = await this.#read(key);
      assertExpected(existing.envelope, envelope);
      if (existing.content !== params.content) throw new Error("Pending operation payload collision");
      return structuredClone(existing.envelope);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const temporary = join(this.#directory, `.tmp-${process.pid}-${crypto.randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await writeDurableFile(join(temporary, CONTENT_FILE), params.content);
      await writeDurableFile(join(temporary, ENVELOPE_FILE), `${canonicalJson(envelope)}\n`);
      await syncDirectory(temporary);
      await rename(temporary, this.#operationDirectory(key));
      await syncDirectory(this.#directory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      const existing = await this.#read(key);
      assertExpected(existing.envelope, envelope);
      if (existing.content !== params.content) throw new Error("Pending operation payload collision");
      return structuredClone(existing.envelope);
    }
    return structuredClone(envelope);
  }

  async #eraseLocal(operationKey) {
    const directory = this.#operationDirectory(operationKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await rm(join(directory, CONTENT_FILE), { force: true });
    await writeDurableFile(join(directory, CONTENT_FILE), "");
    await rm(join(directory, ENVELOPE_FILE), { force: true });
    const terminalPath = join(directory, TERMINAL_FILE);
    await rm(terminalPath, { force: true });
    await writeDurableFile(terminalPath, `${canonicalJson({
      schemaVersion: SCHEMA_VERSION,
      state: "payload-erased",
      idempotencyKey: operationKey,
      erasedAt: this.#clock().toISOString(),
    })}\n`);
    await syncDirectory(directory);
    await syncDirectory(this.#directory);
  }

  async remove(key) {
    const operationKey = validateKey(key);
    await this.#eraseLocal(operationKey);
    if (this.#remoteStorage) {
      await this.#remoteStorage.publishErasure({
        operationDirectory: this.#operationDirectory(operationKey),
      });
      await this.#eraseLocal(operationKey);
    }
  }

  async purge(key) {
    const operationKey = validateKey(key);
    if (!await this.#hasTerminalMarker(operationKey)) {
      throw new Error("Pending operation payload is not terminal");
    }
    const operationDirectory = this.#operationDirectory(operationKey);
    await this.#remoteStorage?.purge({ operationDirectory });
    await rm(operationDirectory, { recursive: true, force: true });
    try {
      await syncDirectory(this.#directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async load(key, expected) {
    const { envelope, content, permissionsRepaired } = await this.#read(validateKey(key));
    assertExpected(envelope, expected);
    return {
      envelope: structuredClone(envelope),
      permissionsRepaired,
      arguments: {
        path: envelope.operation.target,
        content,
      },
    };
  }
}
