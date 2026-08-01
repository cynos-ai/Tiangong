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
    throw new Error("review-inspection-lock-unavailable");
  }
}

function inspectionMetadata(record) {
  if (record.toolName === "inspect_directory") {
    const value = record.metadata?.reviewDirectoryInspection;
    if (!exact(value, ["action", "artifact", "resultCount", "selectorDigest", "snapshotIdentity", "targetId", "truncated"])
        || !["list", "search"].includes(value.action) || typeof value.targetId !== "string") {
      practiceRunFail("EVIDENCE_RESULT_INVALID", "Directory inspection Evidence metadata is invalid");
    }
    return value;
  }
  const value = record.metadata?.reviewRepositoryInspection;
  if (!exact(value, ["action", "artifact", "resultCount", "selectorDigest", "snapshotIdentity", "targetId", "truncated"])
      || value.action !== "list_commit" || typeof value.targetId !== "string") {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Repository inspection Evidence metadata is invalid");
  }
  return value;
}

export class ReviewInspectionBoundary {
  #evidence;
  #lockPath;

  constructor({ evidence, lockPath }) {
    if (!evidence || typeof lockPath !== "string" || lockPath === "") {
      throw new TypeError("Review inspection lock dependencies are required");
    }
    this.#evidence = evidence;
    this.#lockPath = lockPath;
  }

  async run({ operation }, callback) {
    let handle;
    try {
      handle = await openLockTarget(this.#lockPath);
      return await withKernelFileLock(handle, async () => {
        const records = await this.#evidence.readAll();
        let runCount = 0;
        let targetCount = 0;
        for (const record of records) {
          if (record.type !== "tool.execution.completed" || record.status !== "success"
              || !["inspect_directory", "inspect_repository"].includes(record.toolName)
              || record.practiceRunId !== operation.state.runId) continue;
          const metadata = inspectionMetadata(record);
          runCount += 1;
          if (metadata.targetId === operation.state.targetId) targetCount += 1;
        }
        if (targetCount >= TARGET_LIMIT || runCount >= RUN_LIMIT) {
          const repository = operation.toolName === "inspect_repository";
          practiceRunFail(
            repository ? "GIT_INSPECTION_LIMIT_EXCEEDED" : "DIRECTORY_INSPECTION_LIMIT_EXCEEDED",
            repository ? "Repository inspection budget is exhausted" : "Directory inspection budget is exhausted",
          );
        }
        return callback();
      }, { timeoutSeconds: ARTIFACT_LOCK_TIMEOUT_SECONDS });
    } catch (error) {
      if (error?.name === "PracticeRunError") throw error;
      const repository = operation.toolName === "inspect_repository";
      practiceRunFail(
        repository ? "GIT_EXECUTION_LOCK_FAILED" : "DIRECTORY_INSPECTION_LOCK_FAILED",
        repository ? "Repository inspection lifecycle lock failed" : "Directory inspection lifecycle lock failed",
      );
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
