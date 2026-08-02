// Team storage-sync adapter: cross-worker sharing on the AgentTeams v1.2.0
// shared filesystem.
//
// Each Worker's /root/agentteams-fs/shared is local-only; cross-worker sharing
// goes through MinIO shared/ via explicit push/pull:
//   - beforeRead pulls (agentteams-sync mirrors MinIO shared/ -> local).
//   - afterWrite pushes (mc mirror local shared/ -> MinIO shared/).
// A Worker therefore pulls before it reads another Worker's state and pushes
// after it writes its own, so the immutable Tiangong manifests become visible
// across the Team. The command runner is injected so the contract is testable.

import { exec } from "node:child_process";

const PULL_COMMAND = "agentteams-sync";
const PUSH_COMMAND =
  ". /opt/agentteams/scripts/lib/agentteams-env.sh && " +
  'mc mirror /root/agentteams-fs/shared/ "${AGENTTEAMS_STORAGE_PREFIX}/shared/" --overwrite';

function defaultRun(command, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function createTeamSync({ run = defaultRun, now } = {}) {
  const stamp = () => (typeof now === "function" ? now() : new Date().toISOString());
  return {
    async beforeRead() {
      await run(PULL_COMMAND);
      return stamp();
    },
    async afterWrite() {
      await run(PUSH_COMMAND);
      return stamp();
    },
  };
}
