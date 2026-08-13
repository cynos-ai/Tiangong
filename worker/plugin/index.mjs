import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  createWorkerObservability,
  resolveObservabilityConfig,
} from "../observability/tracing.mjs";
import { registerAdmissionHooks } from "../agent/gates/admission-hooks.mjs";
import { createControlAdmissionResolver } from "../agent/gates/admission-context.mjs";
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
      registerAdmissionHooks(api, {
        required: true,
        resolveContext: admissionUrl
          ? createControlAdmissionResolver({
              url: admissionUrl,
              timeoutMs: Number(process.env.TIANGONG_CONTROL_API_TIMEOUT_MS || 1500),
            })
          : async () => {
              throw new Error("Tiangong admission Control API is not configured");
            },
      });
    }
    const observability = createWorkerObservability({
      config: resolveObservabilityConfig(api.pluginConfig),
    });
    api.registerAgentHarness(createTiangongPiHarness({ observability }));
  },
});
