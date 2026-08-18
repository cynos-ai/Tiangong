import { join } from "node:path";

export function defaultStateDirectory(workspaceDir) {
  if (process.env.TIANGONG_STATE_DIR) return process.env.TIANGONG_STATE_DIR;
  const workerName = process.env.AGENTTEAMS_WORKER_NAME;
  if (workerName) return `/root/agentteams-fs/agents/${workerName}/.tiangong/runtime`;
  return join(workspaceDir, ".tiangong", "runtime");
}
