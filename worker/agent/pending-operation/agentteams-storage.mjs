import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";

const WORKER_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ENV_SCRIPT = "/opt/agentteams/scripts/lib/agentteams-env.sh";

function runStorageCommand(script, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", script, "tiangong-storage", ...args], {
      stdio: "ignore",
      env: process.env,
    });
    child.once("error", () => reject(new Error("AgentTeams storage command could not start")));
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error("AgentTeams storage command failed"));
    });
  });
}

function storageRelativePath(workspaceDir, operationDirectory) {
  const workspace = resolve(workspaceDir);
  const operation = resolve(operationDirectory);
  const path = relative(workspace, operation);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep)) {
    throw new Error("Pending operation storage path escapes the Worker workspace");
  }
  return path.split(sep).join("/");
}

export function createAgentTeamsPendingStorage({
  workspaceDir,
  workerName = process.env.AGENTTEAMS_WORKER_NAME,
  runCommand = runStorageCommand,
}) {
  if (!workspaceDir) throw new TypeError("workspaceDir is required");
  if (workerName === undefined || workerName === "") return undefined;
  if (!WORKER_PATTERN.test(workerName)) throw new Error("Invalid AgentTeams Worker identity");

  return {
    async publishErasure({ operationDirectory }) {
      const path = storageRelativePath(workspaceDir, operationDirectory);
      await runCommand(`
        set -eu
        . "${ENV_SCRIPT}"
        ensure_mc_credentials >/dev/null 2>&1 || true
        remote="\${AGENTTEAMS_STORAGE_PREFIX}/agents/$1/$2"
        for payload in write-content arguments.json; do
          if [ -f "$3/$payload" ]; then mc cp "$3/$payload" "\${remote}/$payload" >/dev/null 2>&1; fi
        done
        mc cp "$3/terminal.json" "\${remote}/terminal.json" >/dev/null 2>&1
        mc rm --force "\${remote}/envelope.json" >/dev/null 2>&1 || true
      `, [workerName, path, operationDirectory]);
    },

    async purge({ operationDirectory }) {
      const path = storageRelativePath(workspaceDir, operationDirectory);
      await runCommand(`
        set -eu
        . "${ENV_SCRIPT}"
        ensure_mc_credentials >/dev/null 2>&1 || true
        mc rm --recursive --force "\${AGENTTEAMS_STORAGE_PREFIX}/agents/$1/$2" >/dev/null 2>&1
      `, [workerName, path]);
    },
  };
}
