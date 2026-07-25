#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { EvidenceRecorder } from "../evidence/recorder.mjs";
import { IdempotencyStore } from "../idempotency/store.mjs";
import { createAgentTeamsPendingStorage } from "../pending-operation/agentteams-storage.mjs";
import { PendingOperationStore } from "../pending-operation/store.mjs";
import { WriteReconciler } from "./write-reconciler.mjs";

function usage() {
  return `Usage:
  tiangong-reconcile inspect <approval-id-or-idempotency-key>
  tiangong-reconcile resolve <approval-id-or-idempotency-key> --actor <id> --reason-code <CODE> [--minimum-age-seconds <n>]

The command reads only the fixed Tiangong Worker state root. resolve never
blindly retries: desired content becomes completed, the exact precondition
becomes approved for explicit replay, and any other observation remains
fail-closed as a conflict.`;
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, identifier, ...rest] = argv;
  if (!["inspect", "resolve"].includes(command) || !identifier) throw new Error(usage());
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(usage());
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${name}`);
    options[name] = value;
  }
  const allowed = command === "resolve"
    ? new Set(["--actor", "--reason-code", "--minimum-age-seconds"])
    : new Set();
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new Error(`Unsupported option: ${name}`);
  }
  if (command === "resolve" && (!options["--actor"] || !options["--reason-code"])) {
    throw new Error("resolve requires --actor and --reason-code");
  }
  const secondsText = options["--minimum-age-seconds"] ?? "300";
  if (!/^\d+$/u.test(secondsText)) throw new Error("--minimum-age-seconds must be a non-negative integer");
  const minimumAgeMilliseconds = Number(secondsText) * 1000;
  if (!Number.isSafeInteger(minimumAgeMilliseconds)) throw new Error("minimum age is too large");
  return {
    command,
    identifier,
    actor: options["--actor"],
    reasonCode: options["--reason-code"],
    minimumAgeMilliseconds,
  };
}

function workerPaths() {
  const workerName = process.env.AGENTTEAMS_WORKER_NAME;
  if (workerName && !/^[A-Za-z0-9._-]+$/u.test(workerName)) throw new Error("Invalid Worker name");
  const workspaceDir = process.env.TIANGONG_WORKSPACE_DIR ??
    (workerName ? `/root/hiclaw-fs/agents/${workerName}` : undefined);
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

async function locateSession(stateDirectory, identifier) {
  const sessionsDirectory = join(stateDirectory, "sessions");
  const matches = [];
  const isApprovalId = /^approval-[0-9a-f]{24}$/u.test(identifier);
  for (const entry of await readdir(sessionsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(sessionsDirectory, entry.name);
    const idempotencyStore = new IdempotencyStore({ filePath: join(directory, "idempotency.jsonl") });
    const match = isApprovalId
      ? await idempotencyStore.findApproval(identifier)
      : await idempotencyStore.get(identifier);
    if (match) {
      matches.push({
        directory,
        idempotencyStore,
        key: isApprovalId ? match.key : identifier,
      });
    }
  }
  if (matches.length === 0) throw new Error("Operation not found in Tiangong sessions");
  if (matches.length > 1) throw new Error("Operation identifier is not unique across Tiangong sessions");
  return matches[0];
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const paths = workerPaths();
  const session = await locateSession(paths.stateDirectory, parsed.identifier);
  const reconciler = new WriteReconciler({
    workspaceDir: paths.workspaceDir,
    rollbackDir: join(session.directory, "rollback"),
    idempotencyStore: session.idempotencyStore,
    pendingOperationStore: new PendingOperationStore({
      directory: join(session.directory, "pending-operations"),
      remoteStorage: createAgentTeamsPendingStorage({ workspaceDir: paths.workspaceDir }),
    }),
    evidence: new EvidenceRecorder({
      filePath: join(session.directory, "evidence", "events.jsonl"),
    }),
  });

  if (parsed.command === "inspect") {
    process.stdout.write(`${JSON.stringify(await reconciler.inspect(session.key))}\n`);
    return;
  }
  const result = await reconciler.resolve(session.key, {
    reconciledBy: parsed.actor,
    reasonCode: parsed.reasonCode,
    minimumAgeMilliseconds: parsed.minimumAgeMilliseconds,
  });
  process.stdout.write(`${JSON.stringify({
    idempotencyKey: session.key,
    resolution: result.inspection.resolution,
    status: result.entry.status,
  })}\n`);
  if (result.inspection.resolution === "conflict") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`tiangong-reconcile: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
