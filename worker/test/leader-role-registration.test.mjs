import assert from "node:assert/strict";
import test from "node:test";
import { isLeaderEnvironment, registerLeaderOpenClawTools } from "../agent/team/leader-openclaw-tools.mjs";

const ENV = { AGENTTEAMS_WORKER_NAME: "leader", AGENTTEAMS_WORKER_ROLE: "team_leader", TIANGONG_MEMBER_ID: "leader", TIANGONG_COORDINATION_CONTROL_ENDPOINT: "http://coordination-runtime:8780/v1/coordination/admit", TIANGONG_COORDINATION_CONTROL_TOKEN: "test-control-token-123456" };
const EXPECTED = ["tiangong_list_pending_messages", "tiangong_route_message", "tiangong_correct_message_association", "tiangong_read_work", "tiangong_rename_work", "tiangong_set_work_spec", "tiangong_publish_plan", "tiangong_create_task", "tiangong_cancel_task", "tiangong_complete_work", "tiangong_stop_work"];

test("AgentTeams Leader receives the Work/Plan/Task surface without legacy Project or Decision tools", () => {
  const registrations = []; const api = { registerTool(factory, options) { registrations.push({ factory, options }); } };
  const result = registerLeaderOpenClawTools(api, { env: ENV }); assert.equal(result.enabled, true); assert.deepEqual(result.tools, EXPECTED); assert.deepEqual(registrations[0].options.names, EXPECTED);
  assert.equal(EXPECTED.some((name) => name.includes("project") || name.includes("decide")), false);
});

test("generic non-Leader members cannot inherit Leader tools", () => {
  const env = { ...ENV, AGENTTEAMS_WORKER_ROLE: "worker", TIANGONG_MEMBER_RESPONSIBILITY: "developer" };
  assert.equal(isLeaderEnvironment(env), false); assert.deepEqual(registerLeaderOpenClawTools({ registerTool() {} }, { env }), { enabled: false });
});
