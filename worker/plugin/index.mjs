import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { createTiangongPiHarness } from "./openclaw-adapter.mjs";

export default definePluginEntry({
  id: "tiangong-pi",
  name: "Tiangong pi Harness",
  description: "Runs AgentTeams Worker turns through Tiangong's controlled pi SDK runtime.",
  register(api) {
    api.registerAgentHarness(createTiangongPiHarness());
  },
});
