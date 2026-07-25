import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { sha256 } from "./canonical-json.mjs";

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
  if (workerName) return `/root/hiclaw-fs/agents/${workerName}/.tiangong/runtime`;
  return join(workspaceDir, ".tiangong", "runtime");
}

export class PersistentSessionStore {
  #stateDirectory;

  constructor({ stateDirectory }) {
    this.#stateDirectory = stateDirectory;
  }

  #directory(sessionId) {
    return join(this.#stateDirectory, "sessions", sha256(sessionId));
  }

  async open({ sessionId, workspaceDir }) {
    const directory = this.#directory(sessionId);
    const piDirectory = join(directory, "pi");
    await mkdir(piDirectory, { recursive: true, mode: 0o700 });
    const sessions = await SessionManager.list(workspaceDir, piDirectory);
    if (sessions.length > 1) throw new Error("Multiple pi session files exist for one Tiangong session");
    const manager = sessions.length === 1
      ? SessionManager.open(sessions[0].path, piDirectory, workspaceDir)
      : SessionManager.create(workspaceDir, piDirectory, { id: sha256(sessionId).slice(0, 32) });
    return { manager, directory };
  }

  async reset(sessionId) {
    await rm(this.#directory(sessionId), { recursive: true, force: true });
  }
}
