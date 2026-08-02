import { exec } from "node:child_process";

const PULL_COMMAND = "agentteams-sync";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

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

function boundedIds(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new TypeError(`${name} must be a bounded array`);
  const ids = value.map((id) => {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`${name} contains an invalid id`);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicates`);
  return ids;
}

function pushCommand(kind, id) {
  return ". /opt/agentteams/scripts/lib/agentteams-env.sh && " +
    `mc mirror "/root/agentteams-fs/shared/${kind}/${id}/" ` +
    `"\${AGENTTEAMS_STORAGE_PREFIX}/shared/${kind}/${id}/" --overwrite`;
}

export function createTeamSync({ run = defaultRun, now } = {}) {
  const stamp = () => (typeof now === "function" ? now() : new Date().toISOString());
  return {
    async beforeRead() {
      await run(PULL_COMMAND);
      return stamp();
    },
    async afterWrite(scope) {
      const projectIds = boundedIds(scope?.projectIds, "projectIds");
      const taskIds = boundedIds(scope?.taskIds, "taskIds");
      if (projectIds.length + taskIds.length === 0) {
        throw new Error("Team sync push requires an exact Project/Task scope");
      }
      for (const projectId of projectIds) await run(pushCommand("projects", projectId));
      for (const taskId of taskIds) await run(pushCommand("tasks", taskId));
      return stamp();
    },
  };
}
