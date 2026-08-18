import { admitHumanMatrixEvent } from "../../worker/agent/team/leader-admission.mjs";
import { resumeLeaderMatrixEvent } from "../../worker/agent/team/leader-resume.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const TOKEN = /^[^\s]{16,512}$/u;

function safeCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(code) ? code : "COORDINATION_ADMISSION_FAILED";
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function authorized(request, bearerToken) {
  const value = request.headers.authorization;
  return typeof value === "string" && value === `Bearer ${bearerToken}`;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body exceeds the bounded contract"), { code: "REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw Object.assign(new Error("request body is required"), { code: "REQUEST_BODY_INVALID" });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("request body is not valid JSON"), { code: "REQUEST_BODY_INVALID" });
  }
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`${name} must be an object`), { code: "REQUEST_BODY_INVALID" });
  return value;
}

function memberFor(members, memberId) {
  const member = members.find((candidate) => candidate.memberId === memberId);
  if (!member) throw Object.assign(new Error("Team member is not part of the current binding"), { code: "MEMBER_BINDING_INVALID" });
  return member;
}

function admissionResponse(admission) {
  return {
    replayed: admission.replayed === true,
    work: admission.work,
    wakes: admission.wakes,
    leaderSession: admission.leaderSession,
  };
}

/**
 * A narrow deployment-owned boundary: Workers submit only a Matrix event
 * proof they already re-read through their authenticated channel. Team
 * bindings and the CoordinationStore stay on this side of the boundary.
 */
export function createCoordinationAdmissionHandler({ store, bearerToken, team, route, profile, leaderMember, members = [], leaderSessionId, now } = {}) {
  if (!store || typeof store.createWork !== "function" || typeof store.getWork !== "function" || typeof store.listOutbox !== "function") throw new TypeError("Coordination control API requires a CoordinationStore");
  if (typeof bearerToken !== "string" || !TOKEN.test(bearerToken)) throw new TypeError("Coordination control API bearerToken is invalid");
  if (!team || !route || !profile || !leaderMember) throw new TypeError("Coordination control API requires current Team bindings");
  return async function handleCoordinationRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://coordination.invalid");
    const admissionPath = url.pathname === "/v1/coordination/admit";
    const resumePath = url.pathname === "/v1/coordination/resume";
    const claimPath = url.pathname === "/v1/coordination/wakes/claim";
    const ackPath = url.pathname === "/v1/coordination/wakes/ack";
    const workMatch = url.pathname.match(/^\/v1\/coordination\/works\/([^/]+)$/u);
    const taskMatch = url.pathname.match(/^\/v1\/coordination\/tasks\/([^/]+)$/u);
    const resultMatch = url.pathname.match(/^\/v1\/coordination\/results\/([^/]+)$/u);
    const decisionMatch = url.pathname.match(/^\/v1\/coordination\/decisions\/([^/]+)$/u);
    const workCloseMatch = url.pathname.match(/^\/v1\/coordination\/works\/([^/]+)\/close$/u);
    const taskCreatePath = url.pathname === "/v1/coordination/tasks";
    const resultSubmitPath = url.pathname === "/v1/coordination/results";
    const decisionCreatePath = url.pathname === "/v1/coordination/decisions";
    const wakesPath = url.pathname === "/v1/coordination/wakes";
    if (!admissionPath && !resumePath && !claimPath && !ackPath && !workMatch && !workCloseMatch && !taskMatch && !resultMatch && !decisionMatch && !taskCreatePath && !resultSubmitPath && !decisionCreatePath && !wakesPath) return false;
    if (workMatch || taskMatch || resultMatch || decisionMatch || wakesPath) {
      if (request.method !== "GET") {
        json(response, 405, { error: "method_not_allowed" });
        return true;
      }
      if (!authorized(request, bearerToken)) {
        json(response, 401, { error: "unauthorized" });
        return true;
      }
      try {
        if (workMatch) {
          const work = await store.getWork(decodeURIComponent(workMatch[1]));
          if (!work) json(response, 404, { error: "work_not_found" });
          else json(response, 200, { work });
        } else if (taskMatch) {
          if (typeof store.getTask !== "function") throw Object.assign(new Error("Task gateway is unavailable"), { code: "TASK_GATEWAY_UNAVAILABLE" });
          const task = await store.getTask(decodeURIComponent(taskMatch[1]));
          if (!task) json(response, 404, { error: "task_not_found" });
          else json(response, 200, { task });
        } else if (resultMatch) {
          if (typeof store.getResult !== "function") throw Object.assign(new Error("Result gateway is unavailable"), { code: "RESULT_GATEWAY_UNAVAILABLE" });
          const result = await store.getResult(decodeURIComponent(resultMatch[1]));
          if (!result) json(response, 404, { error: "result_not_found" });
          else json(response, 200, { result });
        } else if (decisionMatch) {
          if (typeof store.getDecision !== "function") throw Object.assign(new Error("Decision gateway is unavailable"), { code: "DECISION_GATEWAY_UNAVAILABLE" });
          const decision = await store.getDecision(decodeURIComponent(decisionMatch[1]));
          if (!decision) json(response, 404, { error: "decision_not_found" });
          else json(response, 200, { decision });
        } else {
          const status = url.searchParams.get("status") ?? undefined;
          json(response, 200, { wakes: await store.listOutbox({ status }) });
        }
      } catch (error) {
        json(response, 422, { error: safeCode(error) });
      }
      return true;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!authorized(request, bearerToken)) {
      json(response, 401, { error: "unauthorized" });
      return true;
    }
    try {
      const body = object(await readBody(request), "request");
      if (taskCreatePath) {
        if (Object.keys(body).some((key) => !["task", "actorId", "expectedEpoch", "requestId"].includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" });
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("Only the bound Leader may create a Task"), { code: "TASK_ACTOR_NOT_LEADER" });
        const task = object(body.task, "task");
        const assignee = memberFor(members, task.assigneeMemberId);
        const created = await store.createTask({
          task,
          team,
          member: assignee,
          profile,
          actorId: body.actorId,
          expectedEpoch: body.expectedEpoch,
          requestId: body.requestId,
          wake: { kind: "task-assignment", targetMemberId: assignee.memberId },
        });
        json(response, 200, created);
      } else if (resultSubmitPath) {
        if (Object.keys(body).some((key) => !["result", "actorId", "expectedEpoch", "requestId"].includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" });
        const result = object(body.result, "result");
        const producer = memberFor(members, result.producerMemberId);
        if (body.actorId !== producer.memberId) throw Object.assign(new Error("Result actor must match the bound producer"), { code: "RESULT_ACTOR_MISMATCH" });
        const submitted = await store.submitResult({
          result,
          team,
          member: producer,
          profile,
          actorId: body.actorId,
          expectedEpoch: body.expectedEpoch,
          requestId: body.requestId,
        });
        const wake = await store.enqueueWake({
          workId: result.workId,
          taskId: result.taskId,
          targetMemberId: team.leaderMemberId,
          kind: "result-notification",
          requestId: `result-notification-${body.requestId}`,
          at: result.createdAt,
        });
        json(response, 200, { ...submitted, wake: wake.wake, wakeReplayed: wake.replayed === true });
      } else if (decisionCreatePath) {
        if (Object.keys(body).some((key) => !["taskId", "decision", "resultDigest", "reason", "actorId", "expectedEpoch", "requestId"].includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" });
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("Only the bound Leader may decide a Task"), { code: "TASK_DECISION_ACTOR_NOT_LEADER" });
        if (typeof store.decideTask !== "function") throw Object.assign(new Error("Decision gateway is unavailable"), { code: "DECISION_GATEWAY_UNAVAILABLE" });
        json(response, 200, await store.decideTask({
          taskId: body.taskId,
          team,
          profile,
          actorId: body.actorId,
          decision: body.decision,
          resultDigest: body.resultDigest,
          reason: body.reason,
          expectedEpoch: body.expectedEpoch,
          requestId: body.requestId,
        }));
      } else if (workCloseMatch) {
        if (Object.keys(body).some((key) => !["decision", "reason", "actorId", "expectedEpoch", "requestId"].includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" });
        if (body.actorId !== leaderMember.memberId) throw Object.assign(new Error("Only the bound Leader may close a Work"), { code: "WORK_CLOSE_ACTOR_NOT_LEADER" });
        if (typeof store.closeWork !== "function") throw Object.assign(new Error("Work closure gateway is unavailable"), { code: "WORK_CLOSE_GATEWAY_UNAVAILABLE" });
        json(response, 200, await store.closeWork({
          workId: decodeURIComponent(workCloseMatch[1]),
          team,
          profile,
          actorId: body.actorId,
          decision: body.decision,
          reason: body.reason,
          expectedEpoch: body.expectedEpoch,
          requestId: body.requestId,
        }));
      } else if (admissionPath || resumePath) {
        if (Object.keys(body).some((key) => !["source", "event"].includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" });
        if (resumePath) {
          if (typeof store.getWake !== "function") throw Object.assign(new Error("Leader resume requires wake reads"), { code: "LEADER_RESUME_STORE_UNAVAILABLE" });
          const resumed = await resumeLeaderMatrixEvent({
            store,
            source: object(body.source, "source"),
            event: object(body.event, "event"),
            team,
            route,
            leaderMember,
          });
          json(response, 200, resumed);
        } else {
          const admission = await admitHumanMatrixEvent({
            store,
            source: object(body.source, "source"),
            event: object(body.event, "event"),
            team,
            route,
            profile,
            leaderMember,
            members,
            leaderSessionId,
            now,
          });
          json(response, 200, admissionResponse(admission));
        }
      } else if (claimPath) {
        if (Object.keys(body).some((key) => !["wakeId", "consumerId", "requestId"].includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" });
        json(response, 200, await store.claimWake(body));
      } else {
        if (Object.keys(body).some((key) => !["wakeId", "consumerId", "receiptId", "requestId"].includes(key))) throw Object.assign(new Error("request contains unknown fields"), { code: "REQUEST_BODY_INVALID" });
        json(response, 200, await store.ackWake(body));
      }
    } catch (error) {
      const code = safeCode(error);
      const status = code === "COMMAND_REQUEST_CONFLICT" || code.endsWith("_CONFLICT") || code.endsWith("_EXISTS") ? 409
        : code === "COORDINATION_ADMISSION_FAILED" ? 500
          : 422;
      json(response, status, { error: code });
    }
    return true;
  };
}
