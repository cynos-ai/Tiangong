import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { statePathsForSession } from "./persistence/state-paths.mjs";

const MAX_SESSION_ENTRIES = 10_000;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;

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

export class PersistentSessionStore {
  #stateDirectory;

  constructor({ stateDirectory }) {
    this.#stateDirectory = stateDirectory;
  }

  async open({ sessionId, workspaceDir }) {
    const paths = statePathsForSession({ stateDirectory: this.#stateDirectory, sessionId });
    await mkdir(paths.piDirectory, { recursive: true, mode: 0o700 });
    const sessions = await SessionManager.list(workspaceDir, paths.piDirectory);
    if (sessions.length > 1) throw new Error("Multiple pi session files exist for one Tiangong session");
    const manager = sessions.length === 1
      ? SessionManager.open(sessions[0].path, paths.piDirectory, workspaceDir)
      : SessionManager.create(workspaceDir, paths.piDirectory, { id: paths.sessionHash.slice(0, 32) });
    return { manager, paths };
  }

  async reset(sessionId) {
    const paths = statePathsForSession({ stateDirectory: this.#stateDirectory, sessionId });
    await rm(paths.piDirectory, { recursive: true, force: true });
  }
}
