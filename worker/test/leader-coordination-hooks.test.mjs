import assert from "node:assert/strict";
import test from "node:test";
import { registerLeaderCoordinationHooks } from "../agent/team/leader-coordination-hooks.mjs";

const ENV = { AGENTTEAMS_WORKER_NAME: "leader", TIANGONG_MEMBER_ID: "leader", TIANGONG_COORDINATION_CONTROL_ENDPOINT: "http://coordination:8780/v1/coordination/admit", TIANGONG_COORDINATION_CONTROL_TOKEN: "test-control-token-123456" };

test("Leader hook durably admits ordinary Room messages before model routing", async () => {
  const registrations = new Map(); const api = { on(name, handler) { registrations.set(name, handler); } }; const failures = [];
  const result = registerLeaderCoordinationHooks(api, {
    env: ENV, channel: {},
    admissionHook: async ({ roomId, eventId, source }) => ({ admission: { roomId, eventId, actorId: source.actorId, status: "pending" }, binding: null }),
    coordinationStore: {
      async listMessageAdmissions() { return { admissions: [{ eventId: "$event", status: "pending" }], metrics: { pendingCount: 1 } }; },
      async recordAdmissionFailure(value) { failures.push(value); return value; },
    },
  });
  assert.deepEqual(result.hooks, ["before_prompt_build", "agent_end"]);
  const context = await registrations.get("before_prompt_build")({ eventId: "$event", roomId: "!room:example.test", sender: "@human:example.test" }, { sessionKey: "session" });
  assert.match(context.prependContext, /event=\$event/u); assert.doesNotMatch(context.prependContext, /Human message/u);
  await registrations.get("agent_end")({ success: true }, { sessionKey: "session" }); assert.equal(failures[0].errorCode, "LEADER_MESSAGE_NOT_ROUTED");
});

test("Leader hook does not mark a message failed after routing completed", async () => {
  const registrations = new Map(); const api = { on(name, handler) { registrations.set(name, handler); } }; let failed = false;
  registerLeaderCoordinationHooks(api, { env: ENV, channel: {}, admissionHook: async () => ({ admission: { status: "pending" }, binding: null }), coordinationStore: { async listMessageAdmissions() { return { admissions: [], metrics: { pendingCount: 0 } }; }, async recordAdmissionFailure() { failed = true; } } });
  await registrations.get("before_prompt_build")({ eventId: "$event", roomId: "!room:example.test", sender: "@human:example.test" }, { sessionKey: "session" }); await registrations.get("agent_end")({ success: true }, { sessionKey: "session" }); assert.equal(failed, false);
});
