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
    const wakesPath = url.pathname === "/v1/coordination/wakes";
    if (!admissionPath && !resumePath && !claimPath && !ackPath && !workMatch && !wakesPath) return false;
    if (workMatch || wakesPath) {
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
      if (admissionPath || resumePath) {
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
