import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  createWorkerObservability,
  parseObservabilityConfig,
} from "../observability/tracing.mjs";
import { createTiangongPiHarness } from "./openclaw-adapter.mjs";

export default definePluginEntry({
  id: "tiangong-pi",
  name: "Tiangong pi Harness",
  description: "Runs AgentTeams Worker turns through Tiangong's controlled pi SDK runtime.",
  register(api) {
    const observability = createWorkerObservability({
      config: parseObservabilityConfig(api.pluginConfig?.observability),
    });
    api.registerAgentHarness(createTiangongPiHarness({ observability }));
  },
});
