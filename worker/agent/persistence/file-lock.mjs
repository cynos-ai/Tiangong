import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_STALE_MILLISECONDS = 30_000;
const LOCK_WAIT_MILLISECONDS = 35_000;
const LOCK_RETRY_MILLISECONDS = 25;

export async function withFileLock(filePath, callback, options = {}) {
  if (!filePath || typeof callback !== "function") throw new TypeError("filePath and callback are required");
  const staleMilliseconds = options.staleMilliseconds ?? LOCK_STALE_MILLISECONDS;
  const waitMilliseconds = options.waitMilliseconds ?? LOCK_WAIT_MILLISECONDS;
  const retryMilliseconds = options.retryMilliseconds ?? LOCK_RETRY_MILLISECONDS;
  for (const [name, value] of Object.entries({ staleMilliseconds, waitMilliseconds, retryMilliseconds })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  }
  if (waitMilliseconds < staleMilliseconds) {
    throw new TypeError("waitMilliseconds must cover staleMilliseconds");
  }
  const directory = dirname(filePath);
  const lockPath = `${filePath}.lock`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMilliseconds;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs >= staleMilliseconds) {
          const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (caught) {
        if (!["ENOENT", "EEXIST"].includes(caught?.code)) throw caught;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for persistent state lock");
      await delay(retryMilliseconds);
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
