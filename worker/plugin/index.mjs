import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  createWorkerObservability,
  resolveObservabilityConfig,
} from "../observability/tracing.mjs";
import { registerAdmissionHooks } from "../agent/gates/admission-hooks.mjs";
import { createControlAdmissionResolver } from "../agent/gates/admission-context.mjs";
import { createFileAdmissionResolver } from "../agent/gates/admission-context-file.mjs";
import { createCanaryAdmissionResolver } from "../agent/gates/canary-admission.mjs";
import { createToolResultCaptureHook, defaultToolResultCapturePath } from "../agent/gates/tool-result-capture.mjs";
import { assertPluginApi } from "../agent/preflight/openclaw-preflight.mjs";
import { registerMemberCoordinationHooks } from "../agent/team/member-coordination-hooks.mjs";
import { registerNativeRunnerTool } from "../agent/team/native-runner-tool.mjs";
import { isLeaderEnvironment, registerLeaderOpenClawTools } from "../agent/team/leader-openclaw-tools.mjs";
import { registerMemberOpenClawTools } from "../agent/team/member-openclaw-tools.mjs";
import { createTiangongPiHarness } from "./openclaw-adapter.mjs";

export default definePluginEntry({
  id: "tiangong-pi",
  name: "Tiangong pi Harness",
  description: "Runs AgentTeams Worker turns through Tiangong's controlled pi SDK runtime.",
  register(api) {
    assertPluginApi(api);
    const leaderEnvironment = isLeaderEnvironment(process.env);
    if (process.env.TIANGONG_CANARY_REQUIRED === "1") {
      const admissionUrl = process.env.TIANGONG_CONTROL_API_ADMISSION_URL;
      const admissionFile = process.env.TIANGONG_CONTROL_API_ADMISSION_FILE;
      const canaryAdmission = process.env.TIANGONG_CANARY_ADMISSION === "local";
      registerAdmissionHooks(api, {
        required: true,
        resolveContext: canaryAdmission
          ? createCanaryAdmissionResolver({
              configPath: process.env.OPENCLAW_CONFIG_PATH ?? `${process.env.HOME}/openclaw.json`,
            })
          : admissionUrl
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
        filePath: defaultToolResultCapturePath(),
      }), { priority: 100 });
    }
    if (process.env.TIANGONG_MEMBER_COORDINATION_ENABLED === "1" && !leaderEnvironment) {
      registerMemberCoordinationHooks(api, {
        endpoint: process.env.TIANGONG_COORDINATION_CONTROL_ENDPOINT,
        token: process.env.TIANGONG_COORDINATION_CONTROL_TOKEN,
        memberId: process.env.TIANGONG_MEMBER_ID,
      });
      registerNativeRunnerTool(api, { env: process.env });
    }
    if (leaderEnvironment) {
      registerLeaderOpenClawTools(api, { env: process.env });
    } else if (process.env.TIANGONG_MEMBER_COORDINATION_ENABLED === "1") {
      registerMemberOpenClawTools(api, { env: process.env });
    }
    const observability = createWorkerObservability({
      config: resolveObservabilityConfig(api.pluginConfig),
    });
    api.registerAgentHarness(createTiangongPiHarness({ observability }));
  },
});
