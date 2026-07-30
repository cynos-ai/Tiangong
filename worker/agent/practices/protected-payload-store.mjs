import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { practiceRunFail } from "./errors.mjs";

const SCHEMA_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const KINDS = Object.freeze({
  request: Object.freeze({ directory: "requests", maxBytes: 256 * 1024 }),
  spec: Object.freeze({ directory: "specs", maxBytes: 256 * 1024 }),
  claim: Object.freeze({ directory: "claims", maxBytes: 256 * 1024 }),
  note: Object.freeze({ directory: "notes", maxBytes: 16 * 1024 }),
});

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function kindDefinition(kind) {
  const definition = KINDS[kind];
  if (!definition) throw new TypeError("Unsupported protected payload kind");
  return definition;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    practiceRunFail("STATE_CORRUPTED", "Protected payload directory is invalid");
  }
  if ((entry.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
    entry = await lstat(path);
    if ((entry.mode & 0o077) !== 0) {
      practiceRunFail("STATE_CORRUPTED", "Protected payload directory permissions cannot be restricted");
    }
  }
}

function validateEnvelope(envelope, kind, digest) {
  const keys = envelope && typeof envelope === "object" && !Array.isArray(envelope)
    ? Object.keys(envelope).sort().join(",")
    : "";
  if (keys !== "kind,payload,payloadDigest,schemaVersion" || envelope.schemaVersion !== SCHEMA_VERSION ||
      envelope.kind !== kind || envelope.payloadDigest !== digest || sha256(envelope.payload) !== digest) {
    practiceRunFail("STATE_CORRUPTED", "Protected payload envelope integrity check failed");
  }
  return envelope;
}

export class ProtectedPayloadStore {
  #root;

  constructor({ directory }) {
    if (typeof directory !== "string" || directory === "") throw new TypeError("directory is required");
    this.#root = directory;
  }

  #path(kind, digest) {
    const definition = kindDefinition(kind);
    if (!DIGEST_PATTERN.test(digest)) throw new TypeError("payload digest must be lowercase SHA-256");
    return join(this.#root, definition.directory, `${digest}.json`);
  }

  async #readFile(kind, digest) {
    const definition = kindDefinition(kind);
    const path = this.#path(kind, digest);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === "ENOENT") practiceRunFail("STATE_CORRUPTED", "Referenced protected payload is missing");
      if (error?.code === "ELOOP") practiceRunFail("STATE_CORRUPTED", "Protected payload cannot be a symbolic link");
      throw error;
    }
    let text;
    try {
      let entry = await handle.stat();
      if (!entry.isFile()) practiceRunFail("STATE_CORRUPTED", "Protected payload is not a regular file");
      if ((entry.mode & 0o077) !== 0) {
        await handle.chmod(0o600);
        entry = await handle.stat();
        if ((entry.mode & 0o077) !== 0) {
          practiceRunFail("STATE_CORRUPTED", "Protected payload permissions cannot be restricted");
        }
      }
      if (entry.size === 0 || entry.size > definition.maxBytes + 4096) {
        practiceRunFail("STATE_CORRUPTED", "Protected payload envelope size is invalid");
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      practiceRunFail("STATE_CORRUPTED", "Protected payload envelope is invalid JSON");
    }
    return validateEnvelope(envelope, kind, digest);
  }

  async put(kind, payload) {
    const definition = kindDefinition(kind);
    const payloadText = canonicalJson(payload);
    const payloadBytes = Buffer.byteLength(payloadText);
    if (payloadBytes === 0 || payloadBytes > definition.maxBytes) {
      practiceRunFail("PAYLOAD_LIMIT_EXCEEDED", "Protected payload exceeds its fixed size limit");
    }
    const digest = sha256(payload);
    const path = this.#path(kind, digest);
    const directory = dirname(path);
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(directory);
    try {
      const existing = await this.#readFile(kind, digest);
      if (canonicalJson(existing.payload) !== payloadText) {
        practiceRunFail("STATE_CORRUPTED", "Protected payload digest collision");
      }
      return Object.freeze({
        digest,
        ref: `${definition.directory}/${digest}.json`,
        bytes: payloadBytes,
      });
    } catch (error) {
      if (error?.code !== "STATE_CORRUPTED" || !/missing/u.test(error.message)) throw error;
    }

    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      kind,
      payloadDigest: digest,
      payload,
    };
    const temporary = join(directory, `.tmp-${process.pid}-${crypto.randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(envelope)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    const stored = await this.#readFile(kind, digest);
    if (canonicalJson(stored.payload) !== payloadText) {
      practiceRunFail("STATE_CORRUPTED", "Protected payload write verification failed");
    }
    return Object.freeze({
      digest,
      ref: `${definition.directory}/${digest}.json`,
      bytes: payloadBytes,
    });
  }

  async read(kind, reference) {
    const definition = kindDefinition(kind);
    const match = new RegExp(`^${definition.directory}/([a-f0-9]{64})\\.json$`, "u").exec(reference);
    if (!match) practiceRunFail("STATE_CORRUPTED", "Protected payload reference is invalid");
    const envelope = await this.#readFile(kind, match[1]);
    return structuredClone(envelope.payload);
  }
}
