import { admitHumanMatrixEvent } from "../../worker/agent/team/leader-admission.mjs";
import { resumeLeaderMatrixEvent } from "../../worker/agent/team/leader-resume.mjs";

const MAX_BODY_BYTES = 32 * 1024;
const TOKEN = /^[^\s]{16,512}$/u;

function safeCode(error) {
  const code = error?.code ?? error?.message;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(code) ? code : "COORDINATION_REQUEST_FAILED";
}
function json(response, status, body) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }
function authorized(request, token) { return request.headers.authorization === `Bearer ${token}`; }
async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { code: "REQUEST_TOO_LARGE" }); chunks.push(chunk); }
  if (!chunks.length) throw Object.assign(new Error("request body required"), { code: "REQUEST_BODY_INVALID" });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { code: "REQUEST_BODY_INVALID" }); }
}
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`${name} must be an object`), { code: "REQUEST_BODY_INVALID" }); return value; }
function exact(value, allowed) { if (Object.keys(value).some((key) => !allowed.includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" }); }
function memberFor(members, memberId) { const member = members.find((candidate) => candidate.memberId === memberId); if (!member) throw Object.assign(new Error("member is not currently bound"), { code: "MEMBER_BINDING_INVALID" }); return member; }
function statusFor(code) { return code === "COMMAND_REQUEST_CONFLICT" || code.endsWith("_CONFLICT") || code.endsWith("_EXISTS") || code.endsWith("_BOUND") ? 409 : code === "COORDINATION_REQUEST_FAILED" ? 500 : 422; }

/** Deployment-owned authenticated gateway. Team, route, profile and member authority stay server-side. */
export function createCoordinationAdmissionHandler({ store, bearerToken, team, route, profile, leaderMember, members = [], now } = {}) {
  if (!store || typeof store.enqueueMessageAdmission !== "function" || typeof store.getWork !== "function") throw new TypeError("Coordination control API requires the current CoordinationStore");
  if (typeof bearerToken !== "string" || !TOKEN.test(bearerToken)) throw new TypeError("Coordination control API bearerToken is invalid");
  if (!team || !route || !profile || !leaderMember) throw new TypeError("Coordination control API requires current Team bindings");

  return async function handleCoordinationRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://coordination.invalid");
    const workMatch = url.pathname.match(/^\/v1\/coordination\/works\/([^/]+)$/u);
    const workChangeMatch = url.pathname.match(/^\/v1\/coordination\/works\/([^/]+)\/(title|spec|plan|close)$/u);
    const taskMatch = url.pathname.match(/^\/v1\/coordination\/tasks\/([^/]+)$/u);
    const taskCancelMatch = url.pathname.match(/^\/v1\/coordination\/tasks\/([^/]+)\/cancel$/u);
    const resultMatch = url.pathname.match(/^\/v1\/coordination\/tasks\/([^/]+)\/result$/u);
    const known = url.pathname === "/v1/coordination/admit" || url.pathname === "/v1/coordination/resume" ||
      url.pathname === "/v1/coordination/admissions" || url.pathname === "/v1/coordination/admissions/route" ||
      url.pathname === "/v1/coordination/admissions/correct" || url.pathname === "/v1/coordination/admissions/failure" ||
      url.pathname === "/v1/coordination/works" || workMatch || workChangeMatch || url.pathname === "/v1/coordination/tasks" ||
      taskMatch || taskCancelMatch || resultMatch || url.pathname === "/v1/coordination/results" ||
      url.pathname === "/v1/coordination/wakes" || url.pathname === "/v1/coordination/wakes/claim" || url.pathname === "/v1/coordination/wakes/ack";
    if (!known) return false;
    if (!authorized(request, bearerToken)) { json(response, 401, { error: "unauthorized" }); return true; }

    try {
      if (request.method === "GET") {
        if (url.pathname === "/v1/coordination/works") {
          json(response, 200, { works: await store.listWorks({ teamId: team.teamId, roomId: route.roomId, status: url.searchParams.get("status") ?? undefined }) });
        } else if (workMatch) {
          const work = await store.getWork(decodeURIComponent(workMatch[1])); if (!work) json(response, 404, { error: "work_not_found" }); else json(response, 200, { work });
        } else if (taskMatch) {
          const task = await store.getTask(decodeURIComponent(taskMatch[1])); if (!task) json(response, 404, { error: "task_not_found" }); else json(response, 200, { task });
        } else if (resultMatch) {
          const result = await store.getResult(decodeURIComponent(resultMatch[1])); if (!result) json(response, 404, { error: "result_not_found" }); else json(response, 200, { result });
        } else if (url.pathname === "/v1/coordination/admissions") {
          const status = url.searchParams.get("status") ?? undefined;
          const admissions = await store.listMessageAdmissions({ roomId: route.roomId, status });
          json(response, 200, { admissions, metrics: await store.admissionMetrics({ roomId: route.roomId }) });
        } else if (url.pathname === "/v1/coordination/wakes") {
          json(response, 200, { wakes: await store.listOutbox({ status: url.searchParams.get("status") ?? undefined }) });
        } else {
          json(response, 405, { error: "method_not_allowed" });
        }
        return true;
      }
      if (request.method !== "POST") { json(response, 405, { error: "method_not_allowed" }); return true; }
      const body = object(await readBody(request), "request");

      if (url.pathname === "/v1/coordination/admit" || url.pathname === "/v1/coordination/resume") {
        exact(body, ["source", "event"]);
        if (url.pathname.endsWith("/resume")) {
          const resumed = await resumeLeaderMatrixEvent({ store, source: object(body.source, "source"), event: object(body.event, "event"), team, route, leaderMember });
          json(response, 200, resumed);
        } else {
          const admitted = await admitHumanMatrixEvent({ store, source: object(body.source, "source"), event: object(body.event, "event"), team, route, profile, leaderMember, members, now });
          json(response, 200, { replayed: admitted.replayed, admission: admitted.admission, binding: admitted.binding });
        }
      } else if (url.pathname === "/v1/coordination/admissions/route") {
        exact(body, ["eventId", "targetWorkId", "title", "expectedEpoch", "actorId", "requestId"]);
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("only Leader routes messages"), { code: "MESSAGE_ROUTE_ACTOR_NOT_LEADER" });
        json(response, 200, await store.routeMessage({ roomId: route.roomId, eventId: body.eventId, team, route, profile, actorId: body.actorId, expectedEpoch: body.expectedEpoch, requestId: body.requestId, targetWorkId: body.targetWorkId, title: body.title }));
      } else if (url.pathname === "/v1/coordination/admissions/correct") {
        exact(body, ["eventId", "correctionEventId", "targetWorkId", "title", "stopSourceIfEmpty", "expectedSourceEpoch", "expectedTargetEpoch", "actorId", "requestId"]);
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("only Leader corrects associations"), { code: "MESSAGE_CORRECTION_ACTOR_NOT_LEADER" });
        json(response, 200, await store.correctMessageAssociation({ roomId: route.roomId, eventId: body.eventId, correctionEventId: body.correctionEventId, team, route, profile, actorId: body.actorId, expectedSourceEpoch: body.expectedSourceEpoch, expectedTargetEpoch: body.expectedTargetEpoch, requestId: body.requestId, targetWorkId: body.targetWorkId, title: body.title, stopSourceIfEmpty: body.stopSourceIfEmpty === true }));
      } else if (url.pathname === "/v1/coordination/admissions/failure") {
        exact(body, ["eventId", "errorCode", "actorId", "requestId"]);
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("only Leader records routing failure"), { code: "MESSAGE_ROUTE_ACTOR_NOT_LEADER" });
        json(response, 200, await store.recordAdmissionFailure({ roomId: route.roomId, eventId: body.eventId, errorCode: body.errorCode, requestId: body.requestId }));
      } else if (workChangeMatch) {
        const workId = decodeURIComponent(workChangeMatch[1]); const operation = workChangeMatch[2];
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("only Leader changes Work"), { code: "WORK_ACTOR_NOT_LEADER" });
        if (operation === "title") { exact(body, ["title", "actorId", "expectedEpoch", "requestId"]); json(response, 200, await store.changeWorkTitle({ workId, title: body.title, profile, actorId: body.actorId, expectedEpoch: body.expectedEpoch, requestId: body.requestId })); }
        else if (operation === "spec") { exact(body, ["spec", "actorId", "expectedEpoch", "requestId"]); json(response, 200, await store.changeWorkSpec({ workId, spec: object(body.spec, "spec"), profile, actorId: body.actorId, expectedEpoch: body.expectedEpoch, requestId: body.requestId })); }
        else if (operation === "plan") { exact(body, ["planRef", "reason", "actorId", "expectedEpoch", "requestId"]); json(response, 200, await store.changeWorkPlan({ workId, planRef: object(body.planRef, "planRef"), reason: body.reason, profile, actorId: body.actorId, expectedEpoch: body.expectedEpoch, requestId: body.requestId })); }
        else { exact(body, ["action", "reason", "actorId", "expectedEpoch", "requestId"]); json(response, 200, await store.closeWork({ workId, team, profile, actorId: body.actorId, action: body.action, reason: body.reason, expectedEpoch: body.expectedEpoch, requestId: body.requestId })); }
      } else if (url.pathname === "/v1/coordination/tasks") {
        exact(body, ["task", "actorId", "expectedEpoch", "requestId"]);
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("only Leader creates Task"), { code: "TASK_ACTOR_NOT_LEADER" });
        const task = object(body.task, "task"); const assignee = memberFor(members, task.assigneeMemberId);
        json(response, 200, await store.createTask({ task, team, member: assignee, profile, actorId: body.actorId, expectedEpoch: body.expectedEpoch, requestId: body.requestId, wake: { kind: "task-assignment", targetMemberId: assignee.memberId } }));
      } else if (taskCancelMatch) {
        exact(body, ["workId", "reason", "actorId", "expectedEpoch", "requestId"]);
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("only Leader cancels Task"), { code: "TASK_CANCEL_ACTOR_NOT_LEADER" });
        json(response, 200, await store.cancelTask({ workId: body.workId, taskId: decodeURIComponent(taskCancelMatch[1]), team, profile, actorId: body.actorId, reason: body.reason, expectedEpoch: body.expectedEpoch, requestId: body.requestId }));
      } else if (url.pathname === "/v1/coordination/results") {
        exact(body, ["result", "actorId", "expectedEpoch", "requestId"]); const result = object(body.result, "result"); const producer = memberFor(members, result.submittedBy);
        if (body.actorId !== producer.memberId) throw Object.assign(new Error("Result actor mismatch"), { code: "RESULT_ACTOR_MISMATCH" });
        const submitted = await store.submitResult({ result, team, member: producer, profile, actorId: body.actorId, expectedEpoch: body.expectedEpoch, requestId: body.requestId });
        const wake = await store.enqueueWake({ workId: result.workId, taskId: result.taskId, targetMemberId: team.leaderMemberId, kind: "result-notification", requestId: `result-notification-${body.requestId}`, at: result.createdAt });
        json(response, 200, { ...submitted, wake: wake.wake, wakeReplayed: wake.replayed === true });
      } else if (url.pathname === "/v1/coordination/wakes/claim") {
        exact(body, ["wakeId", "consumerId", "requestId"]); json(response, 200, await store.claimWake(body));
      } else if (url.pathname === "/v1/coordination/wakes/ack") {
        exact(body, ["wakeId", "consumerId", "receiptId", "requestId"]); json(response, 200, await store.ackWake(body));
      } else {
        json(response, 405, { error: "method_not_allowed" });
      }
    } catch (error) {
      const code = safeCode(error); json(response, statusFor(code), { error: code });
    }
    return true;
  };
}
