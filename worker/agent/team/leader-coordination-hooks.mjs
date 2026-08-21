import { sha256 } from "../canonical-json.mjs";
import { createTeamChannel } from "./channel-adapter.mjs";
import { createRemoteCoordinationStore, createRemoteOpenClawLeaderAdmissionHook } from "./coordination-control-client.mjs";
import { registerAgentLoopCorrelation } from "../../observability/correlation.mjs";

const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;
function first(...values) { return values.find((value) => typeof value === "string" && value.length > 0); }
function required(value, name, pattern) { if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is unavailable`); return value; }
function eventContext(event = {}, ctx = {}) {
  const eventId = required(first(event.eventId, event.messageId, event.currentMessageId, ctx.eventId, ctx.messageId, ctx.currentMessageId), "Matrix event ID", MATRIX_EVENT_ID);
  const roomId = required(first(event.roomId, event.room_id, ctx.roomId, ctx.room_id), "Matrix room ID", MATRIX_ROOM_ID);
  const actorId = required(first(event.sender, event.senderId, ctx.requesterSenderId, ctx.senderId), "Matrix actor ID", MATRIX_USER_ID);
  return { eventId, roomId, actorId, sessionKey: first(ctx.sessionKey, ctx.sessionId, ctx.runId) ?? eventId };
}

/** Register room-level durable ingress before the Leader model and observe un-routed turns. */
export function registerLeaderCoordinationHooks(api, { env = process.env, fetchImpl = globalThis.fetch, channel: suppliedChannel, coordinationStore, admissionHook } = {}) {
  if (typeof api?.on !== "function") throw new Error("OpenClaw Leader coordination hook API is unavailable");
  const endpoint = first(env.TIANGONG_COORDINATION_CONTROL_ENDPOINT); const token = first(env.TIANGONG_COORDINATION_CONTROL_TOKEN); const memberId = first(env.TIANGONG_MEMBER_ID, env.AGENTTEAMS_WORKER_NAME);
  if (!endpoint || !token || !memberId) throw new Error("Leader coordination endpoint, token, and member are required");
  required(env.AGENTTEAMS_WORKER_NAME, "Worker name", /^[A-Za-z0-9._-]{1,128}$/u);
  const channel = suppliedChannel ?? createTeamChannel({ env, fetchImpl });
  const admission = admissionHook ?? createRemoteOpenClawLeaderAdmissionHook({ channel, endpoint, token, fetchImpl });
  const store = coordinationStore ?? createRemoteCoordinationStore({ endpoint, token, fetchImpl, memberId });
  const turns = new Map();

  async function beforePromptBuild(event, ctx) {
    const current = eventContext(event, ctx); const source = { channel: "matrix", authenticated: true, actorId: current.actorId, messageId: current.eventId, route: "team-room" };
    const result = await admission({ roomId: current.roomId, eventId: current.eventId, source });
    registerAgentLoopCorrelation(ctx, { memberId, turnId: current.eventId, workId: result.binding?.workId });
    if (result.resumed === true) return undefined;
    if (result.admission?.status !== "pending" && !result.binding) throw new Error("Leader message admission did not produce a durable reference");
    turns.set(current.sessionKey, current);
    return { prependContext: `Tiangong routing reference (not message authority): room=${current.roomId} event=${current.eventId}. Before Work action, call tiangong_route_message or tiangong_correct_message_association. Web selection is irrelevant.` };
  }

  async function agentEnd(event = {}, ctx = {}) {
    const key = first(ctx.sessionKey, ctx.sessionId, ctx.runId); const current = key ? turns.get(key) : undefined; if (!current) return undefined; turns.delete(key);
    const pending = await store.listMessageAdmissions({ status: "pending" });
    if (!pending.admissions?.some((entry) => entry.eventId === current.eventId)) return undefined;
    const errorCode = event.success === false ? "LEADER_ROUTING_TURN_FAILED" : "LEADER_MESSAGE_NOT_ROUTED";
    return store.recordAdmissionFailure({ eventId: current.eventId, errorCode, requestId: `route-failure-${sha256(current.eventId).slice(0, 48)}` });
  }

  api.on("before_prompt_build", beforePromptBuild, { priority: 200 });
  api.on("agent_end", agentEnd, { priority: 200 });
  return { enabled: true, hooks: ["before_prompt_build", "agent_end"] };
}
