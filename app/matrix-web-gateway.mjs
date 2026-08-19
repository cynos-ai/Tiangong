import { randomBytes } from "node:crypto";

const MATRIX_USER_ID = /^@[A-Za-z0-9._=+\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_TOKEN = /^[^\s]{16,4096}$/u;
const TRANSACTION_ID = /^[A-Za-z0-9._~-]{8,128}$/u;
const PAGINATION_TOKEN = /^[^\s]{1,1024}$/u;
const SESSION_COOKIE = "tiangong_web_session";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_MATRIX_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TIMELINE_EVENTS = 100;
const MAX_MEMBERS = 128;

function failure(code, status = 422) {
  return Object.assign(new Error(code), { code, status });
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw failure("REQUEST_BODY_INVALID");
  return value;
}

function required(value, name, limit = 4096) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /[\u0000\r]/u.test(value)) throw failure(`${name.toUpperCase()}_INVALID`);
  return value;
}

function serviceBaseUrl(value) {
  const parsed = new URL(required(value, "matrix_url"));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError("matrixUrl must be a credential-free HTTP(S) URL");
  return parsed.href.replace(/\/$/u, "");
}

function cookies(request) {
  const result = new Map();
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key && value) result.set(key, value);
  }
  return result;
}

function cookieHeader(sessionId, { secureCookies, maxAgeSeconds }) {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureCookies ? "; Secure" : ""}`;
}

function clearCookieHeader({ secureCookies }) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? "; Secure" : ""}`;
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BYTES) throw failure("REQUEST_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw failure("REQUEST_BODY_INVALID");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("REQUEST_BODY_INVALID"); }
}

function boundedText(value, limit = MAX_BODY_BYTES) {
  return typeof value === "string" && Buffer.byteLength(value) <= limit ? value : null;
}

function boundedMxc(value) {
  if (typeof value !== "string" || value.length > 1024 || !/^mxc:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9_-]+$/u.test(value)) return null;
  return value;
}

function projectEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || !MATRIX_EVENT_ID.test(event.event_id ?? "") || !MATRIX_USER_ID.test(event.sender ?? "") || !Number.isSafeInteger(event.origin_server_ts)) return null;
  const content = event.content && typeof event.content === "object" && !Array.isArray(event.content) ? event.content : {};
  if (event.type === "m.room.encrypted") {
    return { eventId: event.event_id, sender: event.sender, originServerTs: event.origin_server_ts, type: event.type, kind: "encrypted-unsupported" };
  }
  if (event.type !== "m.room.message") return null;
  const msgtype = typeof content.msgtype === "string" ? content.msgtype.slice(0, 64) : "unknown";
  const relation = content["m.relates_to"] && typeof content["m.relates_to"] === "object" && MATRIX_EVENT_ID.test(content["m.relates_to"].event_id ?? "")
    ? { eventId: content["m.relates_to"].event_id, relationType: boundedText(content["m.relates_to"].rel_type, 64) }
    : null;
  if (["m.text", "m.notice", "m.emote"].includes(msgtype)) {
    const body = boundedText(content.body);
    if (body === null) return null;
    return { eventId: event.event_id, sender: event.sender, originServerTs: event.origin_server_ts, type: event.type, kind: "text", msgtype, body, relation };
  }
  if (["m.file", "m.image", "m.video", "m.audio"].includes(msgtype)) {
    const body = boundedText(content.body, 1024) ?? "Attachment";
    const info = content.info && typeof content.info === "object" && !Array.isArray(content.info) ? content.info : {};
    const size = Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= 100 * 1024 * 1024 ? info.size : null;
    const mimeType = typeof info.mimetype === "string" && info.mimetype.length <= 128 ? info.mimetype : null;
    return { eventId: event.event_id, sender: event.sender, originServerTs: event.origin_server_ts, type: event.type, kind: "attachment", msgtype, body, mxcUri: boundedMxc(content.url), size, mimeType, relation };
  }
  return { eventId: event.event_id, sender: event.sender, originServerTs: event.origin_server_ts, type: event.type, kind: "unsupported-message", msgtype };
}

function projectEvents(events) {
  if (!Array.isArray(events) || events.length > MAX_TIMELINE_EVENTS) throw failure("MATRIX_TIMELINE_INVALID", 502);
  return events.map(projectEvent).filter(Boolean);
}

function projectRoster(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.joined || typeof value.joined !== "object" || Array.isArray(value.joined)) throw failure("MATRIX_ROSTER_INVALID", 502);
  const entries = Object.entries(value.joined);
  if (entries.length > MAX_MEMBERS || entries.some(([id]) => !MATRIX_USER_ID.test(id))) throw failure("MATRIX_ROSTER_INVALID", 502);
  return entries.map(([userId, member]) => ({
    userId,
    displayName: typeof member?.display_name === "string" ? member.display_name.slice(0, 160) : null,
  }));
}

function queryToken(value, name) {
  if (value === null || value === undefined || value === "") return null;
  if (!PAGINATION_TOKEN.test(value)) throw failure(`${name.toUpperCase()}_INVALID`);
  return value;
}

async function readBoundedResponse(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MATRIX_BYTES) {
    await response.body?.cancel();
    throw failure("MATRIX_RESPONSE_TOO_LARGE", 502);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_MATRIX_BYTES) {
        await reader.cancel();
        throw failure("MATRIX_RESPONSE_TOO_LARGE", 502);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function createMatrixWebGateway({
  matrixUrl,
  binding,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sessionTtlMs = 8 * 60 * 60_000,
  maxSessions = 128,
  secureCookies = process.env.TIANGONG_WEB_SECURE_COOKIES !== "0",
} = {}) {
  const baseUrl = serviceBaseUrl(matrixUrl);
  if (!binding?.team || !binding.route || !binding.leaderMember || !Array.isArray(binding.members)) throw new TypeError("Matrix Web gateway requires the current runtime binding");
  const roomId = required(binding.route.roomId, "room_id", 256);
  if (!MATRIX_ROOM_ID.test(roomId)) throw new TypeError("Matrix Web gateway room binding is invalid");
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 24 * 60 * 60_000) throw new TypeError("Matrix Web gateway session TTL is invalid");
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) throw new TypeError("Matrix Web gateway maxSessions is invalid");
  if (typeof fetchImpl !== "function") throw new TypeError("Matrix Web gateway requires fetch");
  const sessions = new Map();

  function cleanExpired() {
    const time = now();
    for (const session of sessions.values()) if (session.expiresAt <= time) void discardSession(session, { revoke: true });
  }

  async function matrixRequest({ token, path, method = "GET", body, allowNotFound = false, login = false }) {
    const headers = body === undefined ? {} : { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(login ? 15_000 : 30_000),
      });
    } catch { throw failure("MATRIX_UNAVAILABLE", 502); }
    if (allowNotFound && response.status === 404) { await response.body?.cancel(); return null; }
    const bytes = await readBoundedResponse(response);
    let value = {};
    if (bytes.byteLength > 0) {
      try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw failure("MATRIX_RESPONSE_INVALID", 502); }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw failure("MATRIX_SESSION_REVOKED", 401);
      throw failure(`MATRIX_HTTP_${response.status}`, 502);
    }
    return value;
  }

  async function discardSession(session, { revoke = false } = {}) {
    sessions.delete(session.id);
    if (revoke) {
      try { await matrixRequest({ token: session.accessToken, method: "POST", path: "/_matrix/client/v3/logout", body: {} }); } catch { /* local session removal remains authoritative */ }
    }
  }

  async function validateSession(session) {
    const who = await matrixRequest({ token: session.accessToken, path: "/_matrix/client/v3/account/whoami" });
    if (who?.user_id !== session.userId) throw failure("MATRIX_IDENTITY_MISMATCH", 401);
    const roster = projectRoster(await matrixRequest({ token: session.accessToken, path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members` }));
    if (!roster.some((member) => member.userId === session.userId)) throw failure("MATRIX_ROOM_MEMBERSHIP_REVOKED", 403);
    const encryption = await matrixRequest({ token: session.accessToken, path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`, allowNotFound: true });
    if (encryption !== null) throw failure("MATRIX_ENCRYPTED_ROOM_UNSUPPORTED", 409);
    return { who, roster };
  }

  function localSession(request) {
    cleanExpired();
    const id = cookies(request).get(SESSION_COOKIE);
    const session = id ? sessions.get(id) : null;
    if (!session || session.expiresAt <= now()) {
      if (id) sessions.delete(id);
      throw failure("WEB_SESSION_REQUIRED", 401);
    }
    return session;
  }

  async function authenticated(request) {
    const session = localSession(request);
    try {
      const validated = await validateSession(session);
      return { session, ...validated };
    } catch (error) {
      if (["MATRIX_SESSION_REVOKED", "MATRIX_IDENTITY_MISMATCH", "MATRIX_ROOM_MEMBERSHIP_REVOKED"].includes(error?.code)) await discardSession(session, { revoke: true });
      throw error;
    }
  }

  function verifyCsrf(request, session) {
    if (request.headers["x-tiangong-csrf"] !== session.csrfToken) throw failure("CSRF_INVALID", 403);
  }

  async function login(request, response) {
    cleanExpired();
    if (sessions.size >= maxSessions) throw failure("WEB_SESSION_CAPACITY_EXCEEDED", 503);
    const body = exactObject(await readJson(request), ["userId", "password"]);
    const userId = required(body.userId, "user_id", 256);
    if (!MATRIX_USER_ID.test(userId)) throw failure("USER_ID_INVALID");
    const password = required(body.password, "password", 4096);
    const value = await matrixRequest({
      method: "POST",
      path: "/_matrix/client/v3/login",
      login: true,
      body: { type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password },
    });
    if (value?.user_id !== userId || !MATRIX_TOKEN.test(value?.access_token ?? "")) throw failure("MATRIX_LOGIN_RESPONSE_INVALID", 502);
    const id = randomBytes(32).toString("base64url");
    const session = { id, userId, accessToken: value.access_token, csrfToken: randomBytes(24).toString("base64url"), expiresAt: now() + sessionTtlMs, syncActive: false };
    try {
      await validateSession(session);
      cleanExpired();
      if (sessions.size >= maxSessions) throw failure("WEB_SESSION_CAPACITY_EXCEEDED", 503);
    } catch (error) {
      try { await matrixRequest({ token: session.accessToken, method: "POST", path: "/_matrix/client/v3/logout", body: {} }); } catch { /* the failed login remains denied */ }
      throw error;
    }
    const oldId = cookies(request).get(SESSION_COOKIE);
    const oldSession = oldId ? sessions.get(oldId) : null;
    if (oldSession) await discardSession(oldSession, { revoke: true });
    sessions.set(id, session);
    json(response, 200, { authenticated: true, actorId: userId, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() }, { "set-cookie": cookieHeader(id, { secureCookies, maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }) });
  }

  function assertBoundRoom(candidate) {
    if (candidate !== roomId) throw failure("ROOM_ROUTE_NOT_BOUND", 403);
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://tiangong.invalid");
    const roomMessages = url.pathname.match(/^\/api\/chat\/rooms\/([^/]+)\/messages$/u);
    const known = url.pathname === "/api/chat/session" || url.pathname === "/api/chat/login" || url.pathname === "/api/chat/logout" || url.pathname === "/api/chat/rooms" || url.pathname === "/api/chat/sync" || roomMessages;
    if (!known) return false;
    try {
      if (url.pathname === "/api/chat/session") {
        if (request.method !== "GET") throw failure("METHOD_NOT_ALLOWED", 405);
        try {
          const { session } = await authenticated(request);
          json(response, 200, { authenticated: true, actorId: session.userId, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
        } catch (error) {
          if (["WEB_SESSION_REQUIRED", "MATRIX_SESSION_REVOKED", "MATRIX_IDENTITY_MISMATCH", "MATRIX_ROOM_MEMBERSHIP_REVOKED"].includes(error?.code)) json(response, 200, { authenticated: false }, { "set-cookie": clearCookieHeader({ secureCookies }) });
          else throw error;
        }
        return true;
      }
      if (url.pathname === "/api/chat/login") {
        if (request.method !== "POST") throw failure("METHOD_NOT_ALLOWED", 405);
        await login(request, response);
        return true;
      }
      const current = await authenticated(request);
      if (url.pathname === "/api/chat/logout") {
        if (request.method !== "POST") throw failure("METHOD_NOT_ALLOWED", 405);
        verifyCsrf(request, current.session);
        try { await matrixRequest({ token: current.session.accessToken, method: "POST", path: "/_matrix/client/v3/logout", body: {} }); } catch { /* local revocation remains authoritative */ }
        sessions.delete(current.session.id);
        json(response, 200, { authenticated: false }, { "set-cookie": clearCookieHeader({ secureCookies }) });
        return true;
      }
      if (url.pathname === "/api/chat/rooms") {
        if (request.method !== "GET") throw failure("METHOD_NOT_ALLOWED", 405);
        const joined = await matrixRequest({ token: current.session.accessToken, path: "/_matrix/client/v3/joined_rooms" });
        if (!Array.isArray(joined?.joined_rooms) || joined.joined_rooms.length > 256 || joined.joined_rooms.some((id) => !MATRIX_ROOM_ID.test(id))) throw failure("MATRIX_JOINED_ROOMS_INVALID", 502);
        if (!joined.joined_rooms.includes(roomId)) throw failure("MATRIX_ROOM_MEMBERSHIP_REVOKED", 403);
        const name = await matrixRequest({ token: current.session.accessToken, path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, allowNotFound: true });
        json(response, 200, {
          team: { teamId: binding.team.teamId, leaderMemberId: binding.team.leaderMemberId },
          rooms: [{ roomId, name: typeof name?.name === "string" ? name.name.slice(0, 160) : null, bound: true, members: current.roster }],
        });
        return true;
      }
      if (url.pathname === "/api/chat/sync") {
        if (request.method !== "GET") throw failure("METHOD_NOT_ALLOWED", 405);
        const since = queryToken(url.searchParams.get("since"), "since");
        const timeout = since ? 25_000 : 0;
        const filter = JSON.stringify({ room: { rooms: [roomId], timeline: { limit: 50 }, state: { lazy_load_members: true } } });
        if (current.session.syncActive) throw failure("MATRIX_SYNC_ALREADY_ACTIVE", 409);
        current.session.syncActive = true;
        try {
          const value = await matrixRequest({ token: current.session.accessToken, path: `/_matrix/client/v3/sync?timeout=${timeout}${since ? `&since=${encodeURIComponent(since)}` : ""}&filter=${encodeURIComponent(filter)}` });
          const nextBatch = queryToken(value?.next_batch, "next_batch");
          if (!nextBatch) throw failure("MATRIX_SYNC_INVALID", 502);
          const timeline = value?.rooms?.join?.[roomId]?.timeline;
          const events = timeline === undefined ? [] : projectEvents(timeline?.events);
          json(response, 200, { nextBatch, roomId, events, limited: timeline?.limited === true, prevBatch: queryToken(timeline?.prev_batch, "prev_batch") });
        } finally { current.session.syncActive = false; }
        return true;
      }
      if (roomMessages) {
        const requestedRoom = decodeURIComponent(roomMessages[1]);
        assertBoundRoom(requestedRoom);
        if (request.method === "GET") {
          const from = queryToken(url.searchParams.get("from"), "from");
          const limitValue = Number(url.searchParams.get("limit") ?? 50);
          if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) throw failure("LIMIT_INVALID");
          const value = await matrixRequest({ token: current.session.accessToken, path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limitValue}${from ? `&from=${encodeURIComponent(from)}` : ""}` });
          json(response, 200, { roomId, events: projectEvents(value?.chunk), start: queryToken(value?.start, "start"), end: queryToken(value?.end, "end") });
          return true;
        }
        if (request.method === "POST") {
          verifyCsrf(request, current.session);
          const body = exactObject(await readJson(request), ["body", "clientTransactionId"]);
          const text = required(body.body, "message_body", MAX_BODY_BYTES);
          const transactionId = required(body.clientTransactionId, "client_transaction_id", 128);
          if (!TRANSACTION_ID.test(transactionId)) throw failure("CLIENT_TRANSACTION_ID_INVALID");
          const sent = await matrixRequest({ token: current.session.accessToken, method: "PUT", path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`, body: { msgtype: "m.text", body: text } });
          if (!MATRIX_EVENT_ID.test(sent?.event_id ?? "")) throw failure("MATRIX_SEND_RESPONSE_INVALID", 502);
          json(response, 200, { eventId: sent.event_id, clientTransactionId: transactionId, sender: current.session.userId });
          return true;
        }
        throw failure("METHOD_NOT_ALLOWED", 405);
      }
      throw failure("METHOD_NOT_ALLOWED", 405);
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(error.code) ? error.code : "WEB_REQUEST_FAILED";
      const clearSession = ["WEB_SESSION_REQUIRED", "MATRIX_SESSION_REVOKED", "MATRIX_IDENTITY_MISMATCH", "MATRIX_ROOM_MEMBERSHIP_REVOKED"].includes(code);
      json(response, Number.isSafeInteger(error?.status) ? error.status : 500, { error: code }, clearSession ? { "set-cookie": clearCookieHeader({ secureCookies }) } : {});
      return true;
    }
  }

  return Object.freeze({
    handle,
    async authorizeRead(request) { return authenticated(request); },
    async close() {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.map((session) => discardSession(session, { revoke: true })));
    },
    sessionCount() { cleanExpired(); return sessions.size; },
  });
}
