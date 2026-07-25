import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const GENESIS_HASH = "0".repeat(64);
const DEFAULT_MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

function verifyRecord(record, expectedSequence, previousHash) {
  if (record.version !== 1 || record.sequence !== expectedSequence || record.previousHash !== previousHash) {
    throw new Error(`Invalid evidence chain at sequence ${expectedSequence}`);
  }
  const { hash, ...unsigned } = record;
  if (hash !== sha256(unsigned)) throw new Error(`Evidence hash mismatch at sequence ${expectedSequence}`);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function segmentName(fileName, firstSequence, lastSequence, terminalHash) {
  return `${fileName}.segment-${String(firstSequence).padStart(12, "0")}-${String(lastSequence).padStart(12, "0")}-${terminalHash}`;
}

function parseSegmentName(fileName, candidate) {
  const prefix = `${fileName}.segment-`;
  if (!candidate.startsWith(prefix)) return undefined;
  const match = /^(\d{12})-(\d{12})-([a-f0-9]{64})$/u.exec(candidate.slice(prefix.length));
  if (!match) throw new Error(`Invalid Evidence segment name: ${candidate}`);
  return { name: candidate, first: Number(match[1]), last: Number(match[2]), terminalHash: match[3] };
}

export class EvidenceRecorder {
  #filePath;
  #clock;
  #maxSegmentBytes;
  #sequence = 0;
  #previousHash = GENESIS_HASH;
  #activeFirstSequence = 1;
  #activeRecordCount = 0;
  #activeBytes = 0;
  #queue = Promise.resolve();

  constructor({ filePath, clock = () => new Date(), maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES }) {
    if (!filePath) throw new TypeError("filePath is required");
    if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes <= 0) {
      throw new TypeError("maxSegmentBytes must be a positive integer");
    }
    this.#filePath = filePath;
    this.#clock = clock;
    this.#maxSegmentBytes = maxSegmentBytes;
  }

  get filePath() {
    return this.#filePath;
  }

  async #reload() {
    const directory = dirname(this.#filePath);
    const fileName = basename(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const segments = (await readdir(directory))
      .map((name) => parseSegmentName(fileName, name))
      .filter(Boolean)
      .sort((left, right) => left.first - right.first);

    const records = [];
    let previousHash = GENESIS_HASH;
    let expectedSequence = 1;
    for (const segment of segments) {
      const text = await readFile(join(directory, segment.name), "utf8");
      const segmentRecords = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (segmentRecords.length === 0 || segment.first !== expectedSequence ||
          segment.last !== segmentRecords.at(-1).sequence) {
        throw new Error(`Invalid Evidence segment range: ${segment.name}`);
      }
      for (const record of segmentRecords) {
        verifyRecord(record, expectedSequence, previousHash);
        previousHash = record.hash;
        expectedSequence += 1;
      }
      if (previousHash !== segment.terminalHash) {
        throw new Error(`Invalid Evidence segment terminal hash: ${segment.name}`);
      }
      records.push(...segmentRecords);
    }

    let activeText = "";
    try {
      activeText = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const activeRecords = activeText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const activeFirstSequence = expectedSequence;
    for (const record of activeRecords) {
      verifyRecord(record, expectedSequence, previousHash);
      previousHash = record.hash;
      expectedSequence += 1;
    }
    records.push(...activeRecords);

    this.#sequence = expectedSequence - 1;
    this.#previousHash = previousHash;
    this.#activeFirstSequence = activeFirstSequence;
    this.#activeRecordCount = activeRecords.length;
    this.#activeBytes = Buffer.byteLength(activeText);
    return records;
  }

  async #rotate(nextRecordBytes) {
    if (this.#activeRecordCount === 0 || this.#activeBytes + nextRecordBytes <= this.#maxSegmentBytes) return;
    const directory = dirname(this.#filePath);
    const archivePath = join(directory, segmentName(
      basename(this.#filePath),
      this.#activeFirstSequence,
      this.#sequence,
      this.#previousHash,
    ));
    await rename(this.#filePath, archivePath);
    await syncDirectory(directory);
    this.#activeFirstSequence = this.#sequence + 1;
    this.#activeRecordCount = 0;
    this.#activeBytes = 0;
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
      const line = `${canonicalJson(record)}\n`;
      await this.#rotate(Buffer.byteLength(line));
      const handle = await open(this.#filePath, "a", 0o600);
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#sequence = record.sequence;
      this.#previousHash = record.hash;
      this.#activeRecordCount += 1;
      this.#activeBytes += Buffer.byteLength(line);
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
