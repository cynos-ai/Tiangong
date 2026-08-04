import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { withFileLock } from "./persistence/file-lock.mjs";
import { statePathsForSession } from "./persistence/state-paths.mjs";

const MAX_SESSION_ENTRIES = 10_000;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const SESSION_LOCK_PREFIX = ".session-store-";

export function assertSessionCapacity(entries, incomingPrompt, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError("session entries must be an array");
  if (typeof incomingPrompt !== "string") throw new TypeError("incoming prompt must be a string");
  const maxEntries = options.maxEntries ?? MAX_SESSION_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_SESSION_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("session capacity limits must be positive integers");
  }
  if (entries.length >= maxEntries) throw new Error("Tiangong session entry capacity reached; reset the session");
  const bytes = Buffer.byteLength(JSON.stringify(entries)) + Buffer.byteLength(incomingPrompt);
  if (bytes > maxBytes) throw new Error("Tiangong session byte capacity reached; reset the session");
  return { entries: entries.length, bytes };
}

export function defaultStateDirectory(workspaceDir) {
  if (process.env.TIANGONG_STATE_DIR) return process.env.TIANGONG_STATE_DIR;
  const workerName = process.env.AGENTTEAMS_WORKER_NAME;
  if (workerName) return `/root/agentteams-fs/agents/${workerName}/.tiangong/runtime`;
  return join(workspaceDir, ".tiangong", "runtime");
}

async function ensureRealDirectory(directory, label) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  if ((entry.mode & 0o077) !== 0) await chmod(directory, 0o700);
}

async function assertExistingRealDirectory(directory, label) {
  let entry;
  try {
    entry = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return true;
}

async function listSessionFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const filePath = join(directory, entry.name);
    const file = await lstat(filePath);
    if (file.isSymbolicLink() || !file.isFile()) {
      throw new Error("Pi session files must be regular files");
    }
    if ((file.mode & 0o077) !== 0) await chmod(filePath, 0o600);
    files.push(filePath);
  }
  return files.sort();
}

async function readSessionHeader(filePath) {
  const raw = await readFile(filePath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("Pi session file is not valid UTF-8");
  }

  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("Pi session file contains invalid JSONL");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string") {
      throw new Error("Pi session file contains an invalid entry");
    }
    entries.push(entry);
  }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    throw new Error("Pi session file is not a valid pi session");
  }
  if (entries.filter((entry) => entry.type === "session").length !== 1) {
    throw new Error("Pi session file contains multiple session headers");
  }
  return header;
}

function assertSessionHeader(header, { workspaceDir, expectedSessionId }) {
  if (header.id !== expectedSessionId) {
    throw new Error("Pi session id does not match the Tiangong session binding");
  }
  if (typeof header.cwd !== "string" || header.cwd === "" || resolve(header.cwd) !== workspaceDir) {
    throw new Error("Pi session workspace does not match the Tiangong session binding");
  }
}

async function createPersistedSession(workspaceDir, paths) {
  const created = SessionManager.create(workspaceDir, paths.piDirectory, {
    id: paths.sessionHash.slice(0, 32),
  });
  const sessionFile = created.getSessionFile();
  if (typeof sessionFile !== "string" || resolve(dirname(sessionFile)) !== resolve(paths.piDirectory)) {
    throw new Error("Pi session file escaped its Tiangong directory");
  }
  const temporaryFile = join(paths.piDirectory, `.session-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, `${JSON.stringify(created.getHeader())}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryFile, sessionFile);
  } finally {
    await rm(temporaryFile, { force: true });
  }
  return SessionManager.open(sessionFile, paths.piDirectory, workspaceDir);
}

export class PersistentSessionStore {
  #stateDirectory;
  #managers = new Map();

  constructor({ stateDirectory }) {
    this.#stateDirectory = stateDirectory;
  }

  async open({ sessionId, workspaceDir }) {
    if (typeof workspaceDir !== "string" || workspaceDir === "") {
      throw new TypeError("workspaceDir is required");
    }
    const normalizedWorkspace = resolve(workspaceDir);
    const paths = statePathsForSession({ stateDirectory: this.#stateDirectory, sessionId });
    await ensureRealDirectory(paths.stateDirectory, "Tiangong state directory");
    await ensureRealDirectory(paths.sessionsRoot, "Tiangong session root");

    const lockPath = join(paths.sessionsRoot, `${SESSION_LOCK_PREFIX}${paths.sessionHash}.lock`);
    return withFileLock(lockPath, async () => {
      await ensureRealDirectory(paths.sessionDirectory, "Tiangong session directory");
      await ensureRealDirectory(paths.piDirectory, "Tiangong pi session directory");
      const sessionFiles = await listSessionFiles(paths.piDirectory);
      if (sessionFiles.length > 1) {
        throw new Error("Multiple pi session files exist for one Tiangong session");
      }

      const cached = this.#managers.get(paths.sessionHash);
      if (sessionFiles.length === 0) {
        // A transcript reset may remove the whole pi directory. Never reuse a
        // manager whose file disappeared; start a fresh, durable transcript.
        this.#managers.delete(paths.sessionHash);
        const manager = await createPersistedSession(normalizedWorkspace, paths);
        this.#managers.set(paths.sessionHash, { manager, workspaceDir: normalizedWorkspace });
        return { manager, paths };
      }

      const header = await readSessionHeader(sessionFiles[0]);
      assertSessionHeader(header, {
        workspaceDir: normalizedWorkspace,
        expectedSessionId: paths.sessionHash.slice(0, 32),
      });
      if (cached) {
        if (cached.workspaceDir !== normalizedWorkspace ||
            resolve(cached.manager.getSessionFile()) !== resolve(sessionFiles[0])) {
          throw new Error("Cached pi session binding changed");
        }
        return { manager: cached.manager, paths };
      }

      const manager = SessionManager.open(sessionFiles[0], paths.piDirectory, normalizedWorkspace);
      this.#managers.set(paths.sessionHash, { manager, workspaceDir: normalizedWorkspace });
      return { manager, paths };
    });
  }

  async reset(sessionId) {
    const paths = statePathsForSession({ stateDirectory: this.#stateDirectory, sessionId });
    await ensureRealDirectory(paths.stateDirectory, "Tiangong state directory");
    await ensureRealDirectory(paths.sessionsRoot, "Tiangong session root");
    const lockPath = join(paths.sessionsRoot, `${SESSION_LOCK_PREFIX}${paths.sessionHash}.lock`);
    await withFileLock(lockPath, async () => {
      this.#managers.delete(paths.sessionHash);
      if (!await assertExistingRealDirectory(paths.sessionDirectory, "Tiangong session directory")) return;
      if (!await assertExistingRealDirectory(paths.piDirectory, "Tiangong pi session directory")) return;
      await rm(paths.piDirectory, { recursive: true, force: true });
    });
  }
}
