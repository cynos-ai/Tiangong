import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { stateRootPaths } from "../persistence/state-paths.mjs";
import { sha256 } from "../canonical-json.mjs";
import { WorkRunStore } from "./work-run-store.mjs";
import { classifyWorkRunRecovery } from "./work-run-recovery.mjs";

const ACTOR_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/u;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{1,63}$/u;

function usage() {
  return `Usage:
  tiangong-work-run inspect <run-id>
  tiangong-work-run reconcile <run-id> --action <resume|abandon> --actor <id> --reason-code <CODE>

inspect is read-only. reconcile is an operator/recovery-controller path and
requires TIANGONG_WORK_RUN_RECOVERY_MODE=operator plus an actor present in
TIANGONG_WORK_RUN_RECOVERY_ACTORS (comma-separated). It is never a model tool.`;
}

export function parseWorkRunRecoveryArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, runId, ...rest] = argv;
  if (!["inspect", "reconcile"].includes(command) || !runId || !/^[A-Za-z0-9._:-]{1,128}$/u.test(runId)) {
    throw new Error(usage());
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined || Object.hasOwn(options, name)) throw new Error(usage());
    options[name] = value;
  }
  const allowed = command === "reconcile"
    ? new Set(["--action", "--actor", "--reason-code"])
    : new Set();
  for (const name of Object.keys(options)) if (!allowed.has(name)) throw new Error(`Unsupported option: ${name}`);
  if (command === "reconcile" && (!options["--action"] || !options["--actor"] || !options["--reason-code"])) {
    throw new Error("reconcile requires --action, --actor, and --reason-code");
  }
  if (options["--action"] && !["resume", "abandon"].includes(options["--action"])) {
    throw new Error("--action must be resume or abandon");
  }
  if (options["--actor"] && !ACTOR_PATTERN.test(options["--actor"])) throw new Error("--actor is invalid");
  if (options["--reason-code"] && !REASON_CODE_PATTERN.test(options["--reason-code"])) {
    throw new Error("--reason-code is invalid");
  }
  return Object.freeze({
    command,
    runId,
    action: options["--action"],
    actor: options["--actor"],
    reasonCode: options["--reason-code"],
  });
}

export function workRunDirectoryFromEnvironment(env = process.env) {
  if (typeof env.TIANGONG_WORK_RUN_DIR === "string" && env.TIANGONG_WORK_RUN_DIR !== "") {
    return resolve(env.TIANGONG_WORK_RUN_DIR);
  }
  const workerName = env.AGENTTEAMS_WORKER_NAME;
  if (workerName && !/^[A-Za-z0-9._-]+$/u.test(workerName)) throw new Error("Invalid Worker name");
  const workspaceDir = env.TIANGONG_WORKSPACE_DIR ??
    (workerName ? `/root/agentteams-fs/agents/${workerName}` : undefined);
  const stateDirectory = env.TIANGONG_STATE_DIR ??
    (workspaceDir ? join(workspaceDir, ".tiangong", "runtime") : undefined);
  if (!stateDirectory) throw new Error("AGENTTEAMS_WORKER_NAME or TIANGONG_STATE_DIR is required");
  const normalizedState = resolve(stateDirectory);
  if (!env.TIANGONG_WORKSPACE_DIR && workspaceDir) {
    const relativeState = relative(resolve(workspaceDir), normalizedState);
    if (relativeState === "" || relativeState === ".." || relativeState.startsWith(`..${sep}`) || isAbsolute(relativeState)) {
      throw new Error("Tiangong state root is not beneath the Worker workspace");
    }
  }
  return stateRootPaths(normalizedState).workRunsRoot;
}

function recoveryActors(env) {
  if (env.TIANGONG_WORK_RUN_RECOVERY_MODE !== "operator") {
    const error = new Error("WorkRun recovery requires operator mode");
    error.code = "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED";
    throw error;
  }
  const actors = String(env.TIANGONG_WORK_RUN_RECOVERY_ACTORS ?? "")
    .split(",")
    .map((actor) => actor.trim())
    .filter(Boolean);
  if (actors.length === 0 || actors.some((actor) => !ACTOR_PATTERN.test(actor))) {
    const error = new Error("WorkRun recovery actor allowlist is unavailable");
    error.code = "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED";
    throw error;
  }
  return new Set(actors);
}

export function authorizeWorkRunRecovery({ env = process.env, actor, reasonCode } = {}) {
  if (!ACTOR_PATTERN.test(actor ?? "") || !REASON_CODE_PATTERN.test(reasonCode ?? "")) {
    const error = new Error("WorkRun recovery actor or reason code is invalid");
    error.code = "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED";
    throw error;
  }
  if (!recoveryActors(env).has(actor)) {
    const error = new Error("WorkRun recovery actor is not authorized");
    error.code = "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED";
    throw error;
  }
  return Object.freeze({ actor, reasonCode });
}

export async function runWorkRunRecoveryCommand(argv, { env = process.env, stdout = process.stdout } = {}) {
  const parsed = parseWorkRunRecoveryArguments(argv);
  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return;
  }
  const directory = workRunDirectoryFromEnvironment(env);
  if (parsed.command === "inspect") {
    const store = new WorkRunStore({ directory });
    const inspection = await store.inspect(parsed.runId);
    stdout.write(`${JSON.stringify({
      runId: parsed.runId,
      state: inspection.state,
      recovery: classifyWorkRunRecovery(inspection.state, { ownerPresent: inspection.ownerPresent }),
      ownerPresent: inspection.ownerPresent,
    })}\n`);
    return;
  }
  const authorization = authorizeWorkRunRecovery({ env, actor: parsed.actor, reasonCode: parsed.reasonCode });
  const ownerId = env.TIANGONG_WORK_RUN_RECOVERY_OWNER_ID ?? `recovery-${sha256(authorization.actor).slice(0, 24)}`;
  const store = new WorkRunStore({
    directory,
    ownerId,
    authorizeRecovery: async ({ runId, action }) => {
      if (runId !== parsed.runId || action !== parsed.action) {
        const error = new Error("WorkRun recovery authorization does not match the requested action");
        error.code = "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED";
        throw error;
      }
      return authorization;
    },
  });
  const state = await store.reconcile(parsed.runId, {
    action: parsed.action,
    reason: parsed.reasonCode,
  });
  stdout.write(`${JSON.stringify({
    runId: parsed.runId,
    action: parsed.action,
    actor: authorization.actor,
    reasonCode: authorization.reasonCode,
    phase: state.phase,
    terminal: state.terminal,
    ownerId,
  })}\n`);
}
