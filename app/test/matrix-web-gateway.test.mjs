import assert from "node:assert/strict";
import test from "node:test";

import { createMatrixWebGateway } from "../matrix-web-gateway.mjs";
import { createRuntimeConsoleServer } from "../server.mjs";

const ROOM = "!team-room:example.test";
const HUMAN = "@human:example.test";
const TOKEN = "human-access-token-value-123456";
const BINDING = {
  team: { teamId: "team-web", leaderMemberId: "leader-web" },
  route: { roomId: ROOM },
  leaderMember: { memberId: "leader-web", matrixUserId: "@leader:example.test" },
  members: [],
};

function matrixFixture() {
  const calls = [];
  let revoked = false;
  let encrypted = false;
  let oversized = false;
  let syncDelayMs = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? "GET", pathname: url.pathname, search: url.search, authorization: init.headers?.authorization, body });
    if (url.pathname.endsWith("/login")) return Response.json({ user_id: HUMAN, access_token: TOKEN });
    if (init.headers?.authorization !== `Bearer ${TOKEN}`) return Response.json({ errcode: "M_UNAUTHORIZED" }, { status: 401 });
    if (url.pathname.endsWith("/account/whoami")) return revoked ? Response.json({ errcode: "M_UNKNOWN_TOKEN" }, { status: 401 }) : Response.json({ user_id: HUMAN });
    if (url.pathname.endsWith("/joined_members")) return Response.json({ joined: { [HUMAN]: { display_name: "Human" }, "@leader:example.test": { display_name: "Leader" } } });
    if (url.pathname.includes("/state/m.room.encryption/")) return encrypted ? Response.json({ algorithm: "m.megolm.v1.aes-sha2" }) : Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
    if (url.pathname.endsWith("/joined_rooms")) return Response.json({ joined_rooms: [ROOM] });
    if (url.pathname.includes("/state/m.room.name/")) return Response.json({ name: "Product Team" });
    if (url.pathname.endsWith("/messages") && init.method === "GET" && oversized) return new Response("{}", { headers: { "content-length": "600000", "content-type": "application/json" } });
    if (url.pathname.endsWith("/messages") && init.method === "GET") return Response.json({ start: "start-1", end: "end-1", chunk: [{ event_id: "$message-1", sender: HUMAN, origin_server_ts: 1_776_000_000_000, type: "m.room.message", content: { msgtype: "m.text", body: "Fix the bug https://example.test", formatted_body: "<img src=x onerror=secret>", rawSecret: "must-not-project" } }] });
    if (url.pathname.endsWith("/sync")) { if (syncDelayMs) await new Promise((resolve) => setTimeout(resolve, syncDelayMs)); return Response.json({ next_batch: "sync-2", rooms: { join: { [ROOM]: { timeline: { events: [], limited: false, prev_batch: "prev-1" } } } } }); }
    if (url.pathname.includes("/send/m.room.message/")) return Response.json({ event_id: "$sent-1" });
    if (url.pathname.endsWith("/logout")) return Response.json({});
    return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
  };
  return { calls, fetchImpl, setRevoked(value) { revoked = value; }, setEncrypted(value) { encrypted = value; }, setOversized(value) { oversized = value; }, setSyncDelay(value) { syncDelayMs = value; } };
}

async function request(base, path, { method = "GET", cookie, csrf, body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { "x-tiangong-csrf": csrf } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  return { response, value };
}

async function login(base) {
  const value = await request(base, "/api/chat/login", { method: "POST", body: { userId: HUMAN, password: "test-password-not-logged" } });
  const cookie = value.response.headers.get("set-cookie").split(";", 1)[0];
  return { ...value, cookie, csrf: value.value.csrfToken };
}

function start(fixture, options = {}) {
  const gateway = createMatrixWebGateway({ matrixUrl: "https://matrix.example.test", binding: BINDING, fetchImpl: fixture.fetchImpl, secureCookies: false, ...options });
  const server = createRuntimeConsoleServer({ matrixWebGateway: gateway, sseIntervalMs: 100 }).listen(0);
  return { server, gateway, base: `http://127.0.0.1:${server.address().port}` };
}

test("Matrix Web gateway keeps Human identity, token, Room route, CSRF, and message projection bounded", async (t) => {
  const fixture = matrixFixture(); const runtime = start(fixture); t.after(() => runtime.server.close());
  const signedIn = await login(runtime.base);
  assert.equal(signedIn.response.status, 200); assert.equal(signedIn.value.actorId, HUMAN);
  assert.equal(JSON.stringify(signedIn.value).includes(TOKEN), false); assert.equal(signedIn.response.headers.get("set-cookie").includes(TOKEN), false);

  const rooms = await request(runtime.base, "/api/chat/rooms", { cookie: signedIn.cookie });
  assert.equal(rooms.value.rooms[0].roomId, ROOM); assert.equal(rooms.value.rooms[0].members[0].userId, HUMAN);
  const history = await request(runtime.base, `/api/chat/rooms/${encodeURIComponent(ROOM)}/messages?limit=50`, { cookie: signedIn.cookie });
  assert.equal(history.value.events[0].body, "Fix the bug https://example.test");
  assert.equal(JSON.stringify(history.value).includes("rawSecret"), false); assert.equal(JSON.stringify(history.value).includes("onerror"), false);

  const beforeDenied = fixture.calls.length;
  const denied = await request(runtime.base, `/api/chat/rooms/${encodeURIComponent(ROOM)}/messages`, { method: "POST", cookie: signedIn.cookie, body: { body: "ordinary Human text", clientTransactionId: "web-transaction-1" } });
  assert.equal(denied.response.status, 403); assert.equal(denied.value.error, "CSRF_INVALID"); assert.equal(fixture.calls.length, beforeDenied + 3, "identity, membership and encryption rechecks occur before CSRF denial");

  const sent = await request(runtime.base, `/api/chat/rooms/${encodeURIComponent(ROOM)}/messages`, { method: "POST", cookie: signedIn.cookie, csrf: signedIn.csrf, body: { body: "ordinary Human text", clientTransactionId: "web-transaction-1" } });
  assert.deepEqual(sent.value, { eventId: "$sent-1", clientTransactionId: "web-transaction-1", sender: HUMAN });
  const matrixSend = fixture.calls.findLast((call) => call.pathname.includes("/send/m.room.message/"));
  assert.equal(matrixSend.authorization, `Bearer ${TOKEN}`); assert.deepEqual(matrixSend.body, { msgtype: "m.text", body: "ordinary Human text" }); assert.equal(JSON.stringify(matrixSend.body).includes("workId"), false);

  const weakRouting = await request(runtime.base, `/api/chat/rooms/${encodeURIComponent(ROOM)}/messages`, { method: "POST", cookie: signedIn.cookie, csrf: signedIn.csrf, body: { body: "text", clientTransactionId: "web-transaction-2", workId: "work-selected-in-ui" } });
  assert.equal(weakRouting.response.status, 422); assert.equal(weakRouting.value.error, "REQUEST_BODY_INVALID");
  const wrongRoom = await request(runtime.base, `/api/chat/rooms/${encodeURIComponent("!other:example.test")}/messages`, { cookie: signedIn.cookie });
  assert.equal(wrongRoom.response.status, 403); assert.equal(wrongRoom.value.error, "ROOM_ROUTE_NOT_BOUND");
});

test("Matrix Web gateway cancels oversized upstream responses before projection", async (t) => {
  const fixture = matrixFixture(); const runtime = start(fixture); t.after(() => runtime.server.close());
  const signedIn = await login(runtime.base); fixture.setOversized(true);
  const result = await request(runtime.base, `/api/chat/rooms/${encodeURIComponent(ROOM)}/messages`, { cookie: signedIn.cookie });
  assert.equal(result.response.status, 502); assert.equal(result.value.error, "MATRIX_RESPONSE_TOO_LARGE");
});

test("Matrix Web session revocation denies runtime facts and clears the app session", async (t) => {
  const fixture = matrixFixture(); const runtime = start(fixture); t.after(() => runtime.server.close());
  const signedIn = await login(runtime.base);
  assert.equal((await request(runtime.base, "/api/runtime", { cookie: signedIn.cookie })).response.status, 200);
  fixture.setRevoked(true);
  const denied = await request(runtime.base, "/api/runtime", { cookie: signedIn.cookie });
  assert.equal(denied.response.status, 401); assert.equal(denied.value.error, "WEB_SESSION_REQUIRED");
  const session = await request(runtime.base, "/api/chat/session", { cookie: signedIn.cookie });
  assert.deepEqual(session.value, { authenticated: false }); assert.equal(runtime.gateway.sessionCount(), 0);
});

test("Matrix Web session allows only one active long-poll sync", async (t) => {
  const fixture = matrixFixture(); fixture.setSyncDelay(50); const runtime = start(fixture); t.after(() => runtime.server.close());
  const signedIn = await login(runtime.base);
  const [first, second] = await Promise.all([request(runtime.base, "/api/chat/sync?since=sync-1", { cookie: signedIn.cookie }), request(runtime.base, "/api/chat/sync?since=sync-1", { cookie: signedIn.cookie })]);
  assert.deepEqual([first.response.status, second.response.status].sort(), [200, 409]);
  assert.equal([first.value.error, second.value.error].filter(Boolean)[0], "MATRIX_SYNC_ALREADY_ACTIVE");
});

test("runtime SSE emits revoked and closes after Matrix authorization is withdrawn", async (t) => {
  const fixture = matrixFixture(); const runtime = start(fixture); t.after(() => runtime.server.close());
  const signedIn = await login(runtime.base);
  const response = await fetch(`${runtime.base}/api/runtime/events`, { headers: { cookie: signedIn.cookie } });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let seen = "";
  while (!seen.includes("event: runtime")) { const chunk = await reader.read(); assert.equal(chunk.done, false); seen += decoder.decode(chunk.value); }
  fixture.setRevoked(true);
  while (!seen.includes("event: revoked")) { const chunk = await reader.read(); if (chunk.done) break; seen += decoder.decode(chunk.value); }
  assert.match(seen, /event: revoked/u); assert.match(seen, /web_session_revoked/u); await reader.cancel();
});

test("Matrix Web session capacity rejects before creating another Matrix token", async (t) => {
  const fixture = matrixFixture(); const runtime = start(fixture, { maxSessions: 1 }); t.after(() => runtime.server.close());
  await login(runtime.base); const loginCalls = fixture.calls.filter((call) => call.pathname.endsWith("/login")).length;
  const denied = await request(runtime.base, "/api/chat/login", { method: "POST", body: { userId: HUMAN, password: "another-test-password" } });
  assert.equal(denied.response.status, 503); assert.equal(denied.value.error, "WEB_SESSION_CAPACITY_EXCEEDED");
  assert.equal(fixture.calls.filter((call) => call.pathname.endsWith("/login")).length, loginCalls);
});

test("HTTPS Matrix Web session cookie is HttpOnly, SameSite, and Secure", async (t) => {
  const fixture = matrixFixture(); const runtime = start(fixture, { secureCookies: true }); t.after(() => runtime.server.close());
  const signedIn = await login(runtime.base); const header = signedIn.response.headers.get("set-cookie");
  assert.match(header, /HttpOnly/u); assert.match(header, /SameSite=Strict/u); assert.match(header, /Secure/u); assert.equal(header.includes(TOKEN), false);
});

test("encrypted Team Room login fails closed and creates no Web session", async (t) => {
  const fixture = matrixFixture(); fixture.setEncrypted(true); const runtime = start(fixture); t.after(() => runtime.server.close());
  const result = await request(runtime.base, "/api/chat/login", { method: "POST", body: { userId: HUMAN, password: "test-password" } });
  assert.equal(result.response.status, 409); assert.equal(result.value.error, "MATRIX_ENCRYPTED_ROOM_UNSUPPORTED"); assert.equal(runtime.gateway.sessionCount(), 0); assert.equal(fixture.calls.some((call) => call.pathname.endsWith("/logout")), true);
});

test("clean Matrix Web gateway shutdown revokes active Matrix sessions", async (t) => {
  const fixture = matrixFixture(); const runtime = start(fixture); t.after(() => runtime.server.close());
  await login(runtime.base); await runtime.gateway.close();
  assert.equal(runtime.gateway.sessionCount(), 0); assert.equal(fixture.calls.at(-1).pathname.endsWith("/logout"), true);
});

test("expired Web session fails closed before Matrix or runtime reads", async (t) => {
  let clock = Date.now(); const fixture = matrixFixture(); const runtime = start(fixture, { now: () => clock, sessionTtlMs: 60_000 }); t.after(() => runtime.server.close());
  const signedIn = await login(runtime.base); const before = fixture.calls.length; clock += 60_001;
  const result = await request(runtime.base, "/api/runtime", { cookie: signedIn.cookie });
  assert.equal(result.response.status, 401); assert.equal(fixture.calls.length, before + 1); assert.equal(fixture.calls.at(-1).pathname.endsWith("/logout"), true); assert.equal(runtime.gateway.sessionCount(), 0);
});
