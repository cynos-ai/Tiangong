import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  createWorkerObservability,
  resolveObservabilityConfig,
} from "../observability/tracing.mjs";
import { registerAdmissionHooks } from "../agent/gates/admission-hooks.mjs";
import { createControlAdmissionResolver } from "../agent/gates/admission-context.mjs";
import { createFileAdmissionResolver } from "../agent/gates/admission-context-file.mjs";
import { createToolResultCaptureHook } from "../agent/gates/tool-result-capture.mjs";
import { assertPluginApi } from "../agent/preflight/openclaw-preflight.mjs";
import { createTiangongPiHarness } from "./openclaw-adapter.mjs";

export default definePluginEntry({
  id: "tiangong-pi",
  name: "Tiangong pi Harness",
  description: "Runs AgentTeams Worker turns through Tiangong's controlled pi SDK runtime.",
  register(api) {
    assertPluginApi(api);
    if (process.env.TIANGONG_CANARY_REQUIRED === "1") {
      const admissionUrl = process.env.TIANGONG_CONTROL_API_ADMISSION_URL;
      const admissionFile = process.env.TIANGONG_CONTROL_API_ADMISSION_FILE;
      registerAdmissionHooks(api, {
        required: true,
        resolveContext: admissionUrl
          ? createControlAdmissionResolver({
              url: admissionUrl,
              timeoutMs: Number(process.env.TIANGONG_CONTROL_API_TIMEOUT_MS || 1500),
            })
          : admissionFile
            ? createFileAdmissionResolver({ filePath: admissionFile })
          : async () => {
              throw new Error("Tiangong admission Control API is not configured");
            },
      });
      api.on("tool_result_persist", createToolResultCaptureHook({
        filePath: process.env.TIANGONG_TOOL_RESULT_CAPTURE_FILE || "/tmp/tiangong-tool-results.jsonl",
      }), { priority: 100 });
    }
    const observability = createWorkerObservability({
      config: resolveObservabilityConfig(api.pluginConfig),
    });
    api.registerAgentHarness(createTiangongPiHarness({ observability }));
  },
});
