import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ARTIFACT_LOCK_TIMEOUT_SECONDS,
  withKernelFileLock,
} from "../persistence/kernel-file-lock.mjs";
import { practiceRunFail } from "./errors.mjs";

const TARGET_LIMIT = 64;
const RUN_LIMIT = 128;

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

async function openLockTarget(path) {
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("invalid-parent");
    if ((parent.mode & 0o7777) !== 0o700) {
      await chmod(directory, 0o700);
      parent = await lstat(directory);
      if ((parent.mode & 0o7777) !== 0o700) throw new Error("invalid-parent-mode");
    }
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    let opened = await handle.stat();
    if (!opened.isFile() || opened.size !== 0) {
      await handle.close();
      throw new Error("invalid-lock-target");
    }
    if ((opened.mode & 0o7777) !== 0o600) {
      await handle.chmod(0o600);
      opened = await handle.stat();
    }
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.size !== 0
        || current.dev !== opened.dev || current.ino !== opened.ino || (current.mode & 0o7777) !== 0o600) {
      await handle.close();
      throw new Error("lock-target-race");
    }
    return handle;
  } catch {
    practiceRunFail("DIRECTORY_INSPECTION_LOCK_FAILED", "Directory inspection lifecycle lock is unavailable");
  }
}

function assertInspectionMetadata(value) {
  if (!exact(value, ["action", "artifact", "resultCount", "selectorDigest", "snapshotIdentity", "targetId", "truncated"])
      || !["list", "search"].includes(value.action) || typeof value.targetId !== "string") {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Directory inspection Evidence metadata is invalid");
  }
}

export class DirectoryInspectionBoundary {
  #evidence;
  #lockPath;

  constructor({ evidence, lockPath }) {
    if (!evidence || typeof lockPath !== "string" || lockPath === "") {
      throw new TypeError("Directory inspection lock dependencies are required");
    }
    this.#evidence = evidence;
    this.#lockPath = lockPath;
  }

  async run({ operation }, callback) {
    const handle = await openLockTarget(this.#lockPath);
    try {
      return await withKernelFileLock(handle, async () => {
        const records = await this.#evidence.readAll();
        let runCount = 0;
        let targetCount = 0;
        for (const record of records) {
          if (record.type !== "tool.execution.completed" || record.status !== "success"
              || record.toolName !== "inspect_directory" || record.practiceRunId !== operation.state.runId) continue;
          const metadata = record.metadata?.reviewDirectoryInspection;
          assertInspectionMetadata(metadata);
          runCount += 1;
          if (metadata.targetId === operation.state.targetId) targetCount += 1;
        }
        if (targetCount >= TARGET_LIMIT || runCount >= RUN_LIMIT) {
          practiceRunFail("DIRECTORY_INSPECTION_LIMIT_EXCEEDED", "Directory inspection budget is exhausted");
        }
        return callback();
      }, { timeoutSeconds: ARTIFACT_LOCK_TIMEOUT_SECONDS });
    } catch (error) {
      if (error?.name === "PracticeRunError") throw error;
      practiceRunFail("DIRECTORY_INSPECTION_LOCK_FAILED", "Directory inspection lifecycle lock failed");
    } finally {
      await handle.close().catch(() => {});
    }
  }
}
