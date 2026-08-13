#!/usr/bin/env node

import { runOpenClawPreflightFromFile } from "../agent/preflight/openclaw-preflight.mjs";

try {
  const result = await runOpenClawPreflightFromFile();
  process.stdout.write(`tiangong_preflight=pass plugin=${result.pluginId} control_api=${result.controlApi}\n`);
} catch (error) {
  const code = typeof error?.code === "string" ? error.code : "preflight-failed";
  process.stderr.write(`[tiangong-worker] ERROR: preflight=${code}\n`);
  process.exitCode = 1;
}
