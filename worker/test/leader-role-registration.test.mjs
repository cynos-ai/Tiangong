import assert from "node:assert/strict";
import test from "node:test";

import {
  isLeaderEnvironment,
  registerLeaderOpenClawTools,
} from "../agent/team/leader-openclaw-tools.mjs";

const BASE_ENV = Object.freeze({
  AGENTTEAMS_WORKER_NAME: "team-leader",
  AGENTTEAMS_WORKER_ROLE: "team_leader",
  AGENTTEAMS_MATRIX_DOMAIN: "matrix.example.test",
  TIANGONG_COORDINATION_CONTROL_ENDPOINT: "http://coordination-runtime:8780/v1/coordination/admit",
  TIANGONG_COORDINATION_CONTROL_TOKEN: "test-control-token-123456",
});

test("AgentTeams team_leader identity enables the closed Leader tool surface", () => {
  const registrations = [];
  const api = {
    registerTool(factory, options) {
      registrations.push({ factory, options });
    },
  };

  assert.equal(isLeaderEnvironment(BASE_ENV), true);
  const result = registerLeaderOpenClawTools(api, { env: BASE_ENV });

  assert.equal(result.enabled, true);
  assert.equal(result.runtime, "openclaw-built-in");
  assert.deepEqual(result.tools, [
    "team_create_project",
    "team_dispatch_task",
    "team_check_result",
    "team_decide_task",
    "team_report",
    "team_read_coordination_work",
  ]);
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].options.names, result.tools);
});

test("a non-Leader Worker cannot inherit Leader tools from the generic Worker role", () => {
  const env = { ...BASE_ENV, AGENTTEAMS_WORKER_ROLE: "worker", TIANGONG_ROLE_ID: "implementor" };
  assert.equal(isLeaderEnvironment(env), false);
  assert.deepEqual(registerLeaderOpenClawTools({ registerTool() {} }, { env }), { enabled: false });
});
