import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const GENESIS_HASH = "0".repeat(64);

function verifyRecord(record, expectedSequence, previousHash) {
  if (record.version !== 1 || record.sequence !== expectedSequence || record.previousHash !== previousHash) {
    throw new Error(`Invalid evidence chain at sequence ${expectedSequence}`);
  }
  const { hash, ...unsigned } = record;
  if (hash !== sha256(unsigned)) throw new Error(`Evidence hash mismatch at sequence ${expectedSequence}`);
}

export class EvidenceRecorder {
  #filePath;
  #clock;
  #sequence = 0;
  #previousHash = GENESIS_HASH;
  #queue = Promise.resolve();

  constructor({ filePath, clock = () => new Date() }) {
    if (!filePath) throw new TypeError("filePath is required");
    this.#filePath = filePath;
    this.#clock = clock;
  }

  get filePath() {
    return this.#filePath;
  }

  async #reload() {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    let text = "";
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let previousHash = GENESIS_HASH;
    for (const [index, record] of records.entries()) {
      verifyRecord(record, index + 1, previousHash);
      previousHash = record.hash;
    }
    this.#sequence = records.length;
    this.#previousHash = previousHash;
    return records;
  }

  async initialize() {
    await this.#queue;
    await withFileLock(this.#filePath, () => this.#reload());
  }

  async append(event) {
    for (const field of ["version", "sequence", "timestamp", "previousHash", "hash"]) {
      if (Object.hasOwn(event, field)) throw new Error(`Evidence event cannot set reserved field: ${field}`);
    }
    if (typeof event.type !== "string" || event.type === "") throw new TypeError("Evidence event type is required");
    const operation = this.#queue.then(() => withFileLock(this.#filePath, async () => {
      await this.#reload();
      const unsigned = {
        ...event,
        version: 1,
        sequence: this.#sequence + 1,
        timestamp: this.#clock().toISOString(),
        previousHash: this.#previousHash,
      };
      const record = { ...unsigned, hash: sha256(unsigned) };
      const handle = await open(this.#filePath, "a", 0o600);
      try {
        await handle.writeFile(`${canonicalJson(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#sequence = record.sequence;
      this.#previousHash = record.hash;
      return record;
    }));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async readAll() {
    await this.#queue;
    return withFileLock(this.#filePath, () => this.#reload());
  }
}
