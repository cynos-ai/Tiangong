#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONTAINER_NAME="agentteams-worker-tiangong-openclaw-canary"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'docker is required.'
docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1 || fail "${CONTAINER_NAME} does not exist."
[[ "$(docker inspect "${CONTAINER_NAME}" --format '{{.State.Running}}')" == true ]] ||
  fail "${CONTAINER_NAME} is not running."

info="$(docker exec "${CONTAINER_NAME}" openclaw plugins info tiangong-pi 2>/dev/null)" ||
  fail 'OpenClaw could not inspect the required Tiangong plugin.'
grep -Fqx 'Status: loaded' <<<"${info}" || fail 'Tiangong plugin is not loaded.'
grep -Fqx 'before_dispatch (priority 100)' <<<"${info}" ||
  fail 'The pinned OpenClaw before_dispatch admission hook is not registered.'
grep -Fqx 'before_tool_call (priority 100)' <<<"${info}" ||
  fail 'The pinned OpenClaw before_tool_call admission hook is not registered.'
grep -Fqx 'tool_result_persist (priority 100)' <<<"${info}" ||
  fail 'The pinned OpenClaw tool_result_persist capture hook is not registered.'

capture_probe="$(docker exec -i "${CONTAINER_NAME}" env AGENTTEAMS_WORKER_NAME=tiangong-openclaw-canary \
  node --input-type=module - <<'NODE'
import { readFile, rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createToolResultCaptureHook, defaultToolResultCapturePath } from "/opt/tiangong-worker/agent/gates/tool-result-capture.mjs";

const filePath = defaultToolResultCapturePath({ AGENTTEAMS_WORKER_NAME: process.env.AGENTTEAMS_WORKER_NAME });
const hook = createToolResultCaptureHook({ filePath, now: () => new Date("2026-08-13T00:00:00.000Z") });
hook({ toolName: "read", toolCallId: "gate-a-capture-probe", message: { role: "toolResult", content: [{ type: "text", text: "probe-secret-must-not-persist" }] } }, { agentId: "tiangong-openclaw-canary", sessionKey: "gate-a-probe" });
const record = JSON.parse((await readFile(filePath, "utf8")).trim().split("\n").at(-1));
if (record.source !== "openclaw.tool_result_persist" || record.toolCallId !== "gate-a-capture-probe" ||
    record.agentId !== "tiangong-openclaw-canary" || record.sessionKey !== "gate-a-probe" ||
    record.content?.[0]?.textLength !== 29 || JSON.stringify(record).includes("probe-secret")) {
  throw new Error("bounded ToolResult capture probe failed");
}
console.log(`capture_path=${filePath}`);
console.log(`capture_id=${record.captureId}`);
await rm(filePath, { force: true });
await rmdir(dirname(filePath));
NODE
)" || fail 'The canary bounded ToolResult capture probe failed.'
grep -Fq 'capture_path=/root/agentteams-fs/agents/tiangong-openclaw-canary/.tiangong/runtime/tool-results/openclaw.jsonl' <<<"${capture_probe}" ||
  fail 'The canary ToolResult capture path is not Worker-owned state.'
grep -Eq '^capture_id=[0-9a-f]{64}$' <<<"${capture_probe}" || fail 'The canary ToolResult capture id is not stable metadata.'

printf 'OpenClaw Gate A live hook contract passed.\n'
