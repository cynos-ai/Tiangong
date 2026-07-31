import { spawn } from "node:child_process";

import { artifactError } from "../artifacts/errors.mjs";

export const KERNEL_LOCK_EXECUTABLE = "/usr/bin/flock";
export const ARTIFACT_LOCK_TIMEOUT_SECONDS = 35;

function runFlock(fileHandle, { args, timeoutSeconds }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(
        KERNEL_LOCK_EXECUTABLE,
        args,
        {
          env: {},
          stdio: ["ignore", "ignore", "ignore", fileHandle.fd],
          windowsHide: true,
        },
      );
    } catch {
      reject(artifactError("ARTIFACT_LOCK_FAILED"));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(artifactError("ARTIFACT_LOCK_FAILED"));
    }, Math.ceil((timeoutSeconds + 1) * 1000));
    timer.unref?.();

    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(artifactError("ARTIFACT_LOCK_FAILED"));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal === null && code === 0) resolve();
      else reject(artifactError("ARTIFACT_LOCK_FAILED"));
    });
  });
}

export async function withKernelFileLock(
  fileHandle,
  callback,
  { timeoutSeconds = ARTIFACT_LOCK_TIMEOUT_SECONDS } = {},
) {
  if (!fileHandle || !Number.isInteger(fileHandle.fd) || typeof callback !== "function") {
    throw new TypeError("A file handle and callback are required");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new TypeError("timeoutSeconds must be non-negative");
  }
  await runFlock(fileHandle, {
    args: ["--exclusive", "--timeout", String(timeoutSeconds), "3"],
    timeoutSeconds,
  });
  let callbackError = null;
  try {
    return await callback();
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await runFlock(fileHandle, {
        args: ["--unlock", "3"],
        timeoutSeconds: 1,
      });
    } catch (error) {
      if (callbackError === null) throw error;
    }
  }
}
