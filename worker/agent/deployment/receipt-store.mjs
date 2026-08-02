import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";
import { createDeploymentOutcome } from "./client.mjs";

const GENESIS = "0".repeat(64);
const MAX_RECORDS = 128;

async function load(path) {
  let text;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Deployment receipt journal is not a regular file");
    if ((metadata.mode & 0o077) !== 0) await chmod(path, 0o600);
    text = await readFile(path, "utf8");
  } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (text !== "" && !text.endsWith("\n")) throw new Error("Deployment receipt journal has a partial record");
  const records = text.split("\n").filter(Boolean).map(JSON.parse);
  if (records.length > MAX_RECORDS) throw new Error("Deployment receipt capacity exceeded");
  let previousHash = GENESIS;
  for (let index = 0; index < records.length; index += 1) {
    const { hash, ...unsigned } = records[index];
    if (unsigned.schemaVersion !== 1 || unsigned.sequence !== index + 1 || unsigned.previousHash !== previousHash || hash !== sha256(unsigned) ||
        canonicalJson(createDeploymentOutcome(unsigned.outcome)) !== canonicalJson(unsigned.outcome)) {
      throw new Error("Deployment receipt journal integrity check failed");
    }
    previousHash = hash;
  }
  return records;
}

export class DeploymentReceiptStore {
  #path;
  constructor({ filePath }) { if (typeof filePath !== "string" || filePath === "") throw new TypeError("Deployment receipt filePath is required"); this.#path = filePath; }

  async record(outcomeInput) {
    const outcome = createDeploymentOutcome(outcomeInput);
    return withFileLock(this.#path, async () => {
      const records = await load(this.#path);
      const sameTask = records.filter((record) => record.outcome.taskId === outcome.taskId);
      if (sameTask.length > 0) {
        if (sameTask.length !== 1 || canonicalJson(sameTask[0].outcome) !== canonicalJson(outcome)) throw new Error("Deployment receipt conflicts with an immutable Task outcome");
        return { outcome: structuredClone(sameTask[0].outcome), replayed: true };
      }
      if (records.length >= MAX_RECORDS) throw new Error("Deployment receipt capacity exceeded");
      const unsigned = { schemaVersion: 1, sequence: records.length + 1, previousHash: records.at(-1)?.hash ?? GENESIS, outcome };
      const record = { ...unsigned, hash: sha256(unsigned) };
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const handle = await open(this.#path, "a", 0o600);
      try { await handle.writeFile(`${canonicalJson(record)}\n`); await handle.sync(); } finally { await handle.close(); }
      return { outcome: structuredClone(outcome), replayed: false };
    });
  }

  async completedOutcome(contentDigest) {
    return withFileLock(this.#path, async () => {
      const matches = (await load(this.#path)).filter((record) => record.outcome.contentDigest === contentDigest);
      if (matches.length > 1) throw new Error("Deployment receipt digest is not unique");
      return matches[0] ? structuredClone(matches[0].outcome) : undefined;
    });
  }
}
