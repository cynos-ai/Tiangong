import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  createWorkerObservability,
  resolveObservabilityConfig,
} from "../observability/tracing.mjs";
import { assertPluginApi } from "../agent/preflight/openclaw-preflight.mjs";
import { createTiangongPiHarness } from "./openclaw-adapter.mjs";

export default definePluginEntry({
  id: "tiangong-pi",
  name: "Tiangong pi Harness",
  description: "Runs AgentTeams Worker turns through Tiangong's controlled pi SDK runtime.",
  register(api) {
    assertPluginApi(api);
    const observability = createWorkerObservability({
      config: resolveObservabilityConfig(api.pluginConfig),
    });
    api.registerAgentHarness(createTiangongPiHarness({ observability }));
  },
});
