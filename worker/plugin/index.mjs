import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  createWorkerObservability,
  resolveObservabilityConfig,
} from "../observability/tracing.mjs";
import { registerAdmissionHooks } from "../agent/gates/admission-hooks.mjs";
import { assertPluginApi } from "../agent/preflight/openclaw-preflight.mjs";
import { createTiangongPiHarness } from "./openclaw-adapter.mjs";

export default definePluginEntry({
  id: "tiangong-pi",
  name: "Tiangong pi Harness",
  description: "Runs AgentTeams Worker turns through Tiangong's controlled pi SDK runtime.",
  register(api) {
    assertPluginApi(api);
    if (process.env.TIANGONG_CANARY_REQUIRED === "1") {
      registerAdmissionHooks(api, {
        required: true,
        resolveContext: () => {
          throw new Error("Tiangong admission binding resolver is not configured");
        },
      });
    }
    const observability = createWorkerObservability({
      config: resolveObservabilityConfig(api.pluginConfig),
    });
    api.registerAgentHarness(createTiangongPiHarness({ observability }));
  },
});
