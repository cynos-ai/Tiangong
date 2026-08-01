#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { EvidenceRecorder } from "../evidence/recorder.mjs";
import { IdempotencyStore } from "../idempotency/store.mjs";
import { createAgentTeamsPendingStorage } from "../pending-operation/agentteams-storage.mjs";
import { PendingOperationStore } from "../pending-operation/store.mjs";
import { statePathsForSessionHash, stateRootPaths } from "../persistence/state-paths.mjs";

const REPLAY_WINDOW_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;
const CONFIRMATION = "expire-90-day-replay-window";
const OPERATOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;

function usage() {
  return `Usage:
  tiangong-retain report
  tiangong-retain compact --actor <operator-id> --confirm ${CONFIRMATION}

Terminal completed/rejected idempotency records older than 90 days are
eligible. compact removes any remaining protected payload, appends a summary
Evidence event, and then removes the active idempotency record. This ends
exactly-once replay for the expired invocation; Evidence is never deleted.`;
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...rest] = argv;
  if (!["report", "compact"].includes(command)) throw new Error(usage());
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(usage());
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${name}`);
    options[name] = value;
  }
  const allowed = command === "compact" ? new Set(["--actor", "--confirm"]) : new Set();
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unsupported option: ${name}`);
  }
  if (command === "compact") {
    if (!OPERATOR_ID_PATTERN.test(options["--actor"] ?? "")) {
      throw new Error("--actor must be a bounded operator identifier");
    }
    if (options["--confirm"] !== CONFIRMATION) throw new Error(`--confirm must equal ${CONFIRMATION}`);
  }
  return { command, actor: options["--actor"] };
}

function workerPaths() {
  const workerName = process.env.AGENTTEAMS_WORKER_NAME;
  if (workerName && !/^[A-Za-z0-9._-]+$/u.test(workerName)) throw new Error("Invalid Worker name");
  const workspaceDir = process.env.TIANGONG_WORKSPACE_DIR ??
    (workerName ? `/root/agentteams-fs/agents/${workerName}` : undefined);
  const stateDirectory = process.env.TIANGONG_STATE_DIR ??
    (workspaceDir ? join(workspaceDir, ".tiangong", "runtime") : undefined);
  if (!workspaceDir || !stateDirectory) {
    throw new Error("AGENTTEAMS_WORKER_NAME or both TIANGONG_WORKSPACE_DIR and TIANGONG_STATE_DIR are required");
  }
  const normalizedState = resolve(stateDirectory);
  const normalizedWorkspace = resolve(workspaceDir);
  if (!process.env.TIANGONG_WORKSPACE_DIR && dirname(dirname(normalizedState)) !== normalizedWorkspace) {
    throw new Error("Tiangong state root is not beneath the Worker workspace");
  }
  return { workspaceDir: normalizedWorkspace, stateDirectory: normalizedState };
}

async function operationSessions(stateDirectory, workspaceDir) {
  const roots = stateRootPaths(stateDirectory);
  let entries;
  try {
    entries = await readdir(roots.idempotencyRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name)).map((entry) => {
    if (!entry.isDirectory()) throw new Error("Unexpected entry in Tiangong idempotency state root");
    const paths = statePathsForSessionHash({ stateDirectory, sessionHash: entry.name });
    return {
      idempotencyStore: new IdempotencyStore({ filePath: paths.idempotencyFilePath }),
      pendingOperationStore: new PendingOperationStore({
        directory: paths.pendingOperationDirectory,
        remoteStorage: createAgentTeamsPendingStorage({ workspaceDir }),
      }),
      evidence: new EvidenceRecorder({ filePath: paths.evidenceFilePath }),
    };
  });
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const paths = workerPaths();
  const before = new Date(Date.now() - REPLAY_WINDOW_MILLISECONDS).toISOString();
  const candidateGroups = [];
  for (const session of await operationSessions(paths.stateDirectory, paths.workspaceDir)) {
    candidateGroups.push({
      session,
      candidates: await session.idempotencyStore.listTerminalBefore(before),
    });
  }
  const eligible = candidateGroups.reduce((total, group) => total + group.candidates.length, 0);
  if (parsed.command === "report") {
    process.stdout.write(`${JSON.stringify({ replayWindowDays: 90, before, eligible })}\n`);
    return;
  }

  let compacted = 0;
  for (const { session, candidates } of candidateGroups) {
    for (const candidate of candidates) {
      await session.pendingOperationStore.purge(candidate.key);
      await session.evidence.append({
        type: "retention.idempotency.expired",
        actorId: parsed.actor,
        idempotencyKey: candidate.key,
        operationDigest: candidate.entry.operationDigest,
        approvalId: candidate.entry.approvalId,
        status: candidate.entry.status,
        terminalAt: candidate.terminalAt,
        replayWindowDays: 90,
      });
    }
    await session.idempotencyStore.removeTerminalsBefore(
      candidates.map((candidate) => candidate.key),
      before,
    );
    compacted += candidates.length;
  }
  process.stdout.write(`${JSON.stringify({ replayWindowDays: 90, before, compacted })}\n`);
}

main().catch((error) => {
  process.stderr.write(`tiangong-retain: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
