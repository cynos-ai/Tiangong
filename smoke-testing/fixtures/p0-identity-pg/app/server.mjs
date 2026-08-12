import Fastify from "fastify";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

const MAX_BODY_BYTES = 16 * 1024;
const USER_ID_PATTERN = /^@[A-Za-z0-9._=-]{1,255}:[^\s/]{1,255}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/u;
const SESSION_COOKIE = "tiangong_probe_session";
const OPERATION_PATTERN = /^p0-operation-[a-z0-9-]{1,64}$/u;
const ACTIONS = new Set(["approve", "reject"]);
const runId = randomUUID();

class ProbeError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name}`);
  return value;
}

function integerEnvironment(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`invalid_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid_${name}`);
  return value;
}

const probeKey = required("PROBE_KEY");
const matrixOrigin = new URL(required("MATRIX_ORIGIN"));
if (!/^https?:$/u.test(matrixOrigin.protocol) || matrixOrigin.username || matrixOrigin.password ||
    matrixOrigin.pathname !== "/" || matrixOrigin.search || matrixOrigin.hash) {
  throw new Error("invalid_MATRIX_ORIGIN");
}
const matrixHost = required("MATRIX_HOST");
const boundWorkerUserId = required("BOUND_WORKER_USER_ID");
if (!USER_ID_PATTERN.test(boundWorkerUserId)) throw new Error("invalid_BOUND_WORKER_USER_ID");
const sessionTtlMs = integerEnvironment("SESSION_TTL_MS", 30_000, { min: 1_000, max: 300_000 });
const stepUpTtlMs = integerEnvironment("STEP_UP_TTL_MS", 5_000, { min: 100, max: 30_000 });
const port = integerEnvironment("PORT", 8080, { min: 1, max: 65_535 });
const host = process.env.HOST ?? "0.0.0.0";

const pool = new Pool({
  host: required("PGHOST"),
  port: integerEnvironment("PGPORT", 5432, { min: 1, max: 65_535 }),
  user: required("PGUSER"),
  password: required("PGPASSWORD"),
  database: required("PGDATABASE"),
  max: 8,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 5_000,
  application_name: "tiangong-p0-4-probe",
});

const sessions = new Map();
const challenges = new Map();
const streams = new Set();
const counters = { matrixWhoami: 0, databaseProbe: 0 };
const app = Fastify({
  bodyLimit: MAX_BODY_BYTES,
  logger: false,
  disableRequestLogging: true,
});

function errorBody(code) {
  return { error: code };
}

function fail(code, status = 400) {
  throw new ProbeError(code, status);
}

function requireProbeKey(request) {
  if (request.headers["x-probe-key"] !== probeKey) fail("probe_not_found", 404);
}

function bearerToken(request) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !/^Bearer [A-Za-z0-9._~-]{16,512}$/u.test(value)) {
    fail("matrix_proof_required", 401);
  }
  return value.slice("Bearer ".length);
}

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== "string") return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]{1,64}$/u.test(name) && /^[A-Za-z0-9._~-]{16,128}$/u.test(value)) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function sessionFrom(request) {
  const id = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  if (!id) fail("app_session_required", 401);
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    fail("app_session_expired", 401);
  }
  return { id, session };
}

function csrfFrom(request, session) {
  if (request.headers["x-csrf-token"] !== session.csrfToken) fail("csrf_required", 403);
}

function validateActor(userId) {
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) throw new Error("invalid_matrix_actor");
  return userId;
}

async function matrixWhoami(token) {
  counters.matrixWhoami += 1;
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
    host: matrixHost,
  });
  let response;
  try {
    response = await fetch(new URL("/_matrix/client/v3/account/whoami", matrixOrigin), {
      headers,
      redirect: "error",
    });
  } catch {
    fail("matrix_identity_unavailable", 503);
  }
  let json = null;
  try {
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) fail("matrix_identity_response_too_large", 502);
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    fail("matrix_identity_response_invalid", 502);
  }
  if (response.status !== 200 || !json || typeof json.user_id !== "string") {
    fail("matrix_proof_rejected", 401);
  }
  return validateActor(json.user_id);
}

async function currentActor(request) {
  return matrixWhoami(bearerToken(request));
}

function setSessionCookie(reply, value, maxAgeSeconds) {
  reply.header("set-cookie", `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`);
}

function clearSessionCookie(reply) {
  reply.header("set-cookie", `${SESSION_COOKIE}=deleted; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function sessionResponse(session, actor) {
  return {
    actor,
    auth_mode: "transient_matrix_proof",
    max_staleness_ms: 0,
    session_ttl_ms: sessionTtlMs,
    csrf_token: session.csrfToken,
  };
}

function requestSession(request) {
  const result = sessionFrom(request);
  csrfFrom(request, result.session);
  return result;
}

function boundedString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code, 400);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function prepareProbeTables(client) {
  await client.query("DROP TABLE IF EXISTS p0_identity_probe");
  await client.query(`
    CREATE TABLE p0_identity_probe (
      id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL,
      value TEXT NOT NULL
    )
  `);
}

async function runDatabaseProbe() {
  counters.databaseProbe += 1;
  const setup = await pool.connect();
  try {
    await prepareProbeTables(setup);
  } finally {
    setup.release();
  }

  const unique = await withTransaction(async (client) => {
    await client.query("INSERT INTO p0_identity_probe (id, epoch, value) VALUES ($1, $2, $3)", ["unique", 0, "first"]);
    return true;
  });
  let duplicateRejected = false;
  try {
    await withTransaction(async (client) => {
      await client.query("INSERT INTO p0_identity_probe (id, epoch, value) VALUES ($1, $2, $3)", ["unique", 0, "duplicate"]);
    });
  } catch (error) {
    duplicateRejected = error?.code === "23505";
  }

  const lockSetup = await pool.connect();
  try {
    await lockSetup.query("INSERT INTO p0_identity_probe (id, epoch, value) VALUES ($1, $2, $3)", ["lock", 0, "seed"]);
  } finally {
    lockSetup.release();
  }
  const lockFirst = withTransaction(async (client) => {
    await client.query("SELECT epoch FROM p0_identity_probe WHERE id = $1 FOR UPDATE", ["lock"]);
    await sleep(100);
    await client.query("UPDATE p0_identity_probe SET epoch = epoch + 1, value = $2 WHERE id = $1", ["lock", "first-commit"]);
    return "first";
  });
  await sleep(15);
  const lockSecond = withTransaction(async (client) => {
    await client.query("SELECT epoch FROM p0_identity_probe WHERE id = $1 FOR UPDATE", ["lock"]);
    await client.query("UPDATE p0_identity_probe SET epoch = epoch + 1, value = $2 WHERE id = $1", ["lock", "second-commit"]);
    return "second";
  });
  const lockOrder = await Promise.all([lockFirst, lockSecond]);
  const lockFinal = await pool.query("SELECT epoch, value FROM p0_identity_probe WHERE id = $1", ["lock"]);

  const optimisticSetup = await pool.connect();
  try {
    await optimisticSetup.query("INSERT INTO p0_identity_probe (id, epoch, value) VALUES ($1, $2, $3)", ["optimistic", 0, "seed"]);
  } finally {
    optimisticSetup.release();
  }
  let arrived = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const optimisticAttempt = (value) => withTransaction(async (client) => {
    const read = await client.query("SELECT epoch FROM p0_identity_probe WHERE id = $1", ["optimistic"]);
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    const update = await client.query(
      "UPDATE p0_identity_probe SET epoch = epoch + 1, value = $2 WHERE id = $1 AND epoch = $3",
      ["optimistic", value, read.rows[0].epoch],
    );
    return update.rowCount;
  });
  const optimisticRows = await Promise.all([optimisticAttempt("accepted-a"), optimisticAttempt("accepted-b")]);
  const optimisticFinal = await pool.query("SELECT epoch, value FROM p0_identity_probe WHERE id = $1", ["optimistic"]);
  const rowText = JSON.stringify([...lockFinal.rows, ...optimisticFinal.rows]);

  return {
    unique_constraint: { insert_committed: unique, duplicate_rejected: duplicateRejected },
    select_for_update: {
      committed_transactions: lockOrder.length,
      final_epoch: lockFinal.rows[0]?.epoch,
      final_value: lockFinal.rows[0]?.value,
    },
    optimistic_epoch: {
      accepted: optimisticRows.filter((value) => value === 1).length,
      rejected: optimisticRows.filter((value) => value === 0).length,
      final_epoch: optimisticFinal.rows[0]?.epoch,
    },
    credential_free_rows: !/(Bearer|access_token|password|secret)/iu.test(rowText),
  };
}

function closeStream(stream) {
  if (stream.closed) return;
  stream.closed = true;
  clearInterval(stream.timer);
  streams.delete(stream);
  try { stream.response.end(); } catch {}
}

async function verifyStream(stream) {
  if (stream.closed) return;
  try {
    const actor = await matrixWhoami(stream.token);
    if (actor !== stream.actor) closeStream(stream);
  } catch {
    try {
      stream.response.write("event: revoked\ndata: {\"reason\":\"matrix-proof-rejected\"}\n\n");
    } catch {}
    closeStream(stream);
  }
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ProbeError) {
    reply.code(error.status).send(errorBody(error.code));
    return;
  }
  reply.code(500).send(errorBody("probe_internal_error"));
});

app.get("/", async (_request, reply) => {
  const page = await readFile(resolve(fileURLToPath(new URL(".", import.meta.url)), "dist/index.html"), "utf8");
  reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  reply.type("text/html; charset=utf-8").send(page);
});

app.get("/healthz", async (_request, reply) => {
  await pool.query("SELECT 1");
  reply.send({ status: "ready", database: "ready", network: "agentteams" });
});

app.post("/session/start", async (request, reply) => {
  requireProbeKey(request);
  const actor = await currentActor(request);
  const id = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const session = { userId: actor, csrfToken, expiresAt: Date.now() + sessionTtlMs };
  sessions.set(id, session);
  setSessionCookie(reply, id, Math.ceil(sessionTtlMs / 1000));
  reply.send(sessionResponse(session, actor));
});

app.post("/session/logout", async (request, reply) => {
  requireProbeKey(request);
  const { id } = requestSession(request);
  sessions.delete(id);
  clearSessionCookie(reply);
  reply.send({ status: "logged_out" });
});

app.get("/protected/read", async (request, reply) => {
  requireProbeKey(request);
  const { session } = sessionFrom(request);
  const actor = await currentActor(request);
  if (actor !== session.userId) fail("session_actor_mismatch", 403);
  reply.send({ actor, auth_mode: "transient_matrix_proof", max_staleness_ms: 0 });
});

app.get("/worker/internal-identity", async (request, reply) => {
  requireProbeKey(request);
  const actor = await currentActor(request);
  if (actor !== boundWorkerUserId) fail("worker_route_binding_mismatch", 403);
  reply.send({ actor, binding: "startup-bound-worker-matrix-identity", route: "p0-identity-probe" });
});

app.post("/database/probe", async (request, reply) => {
  requireProbeKey(request);
  const result = await runDatabaseProbe();
  reply.send(result);
});

app.get("/events", async (request, reply) => {
  requireProbeKey(request);
  const { id, session } = sessionFrom(request);
  const token = bearerToken(request);
  const actor = await matrixWhoami(token);
  if (actor !== session.userId) fail("session_actor_mismatch", 403);
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ actor, max_staleness_ms: 0 })}\n\n`);
  const stream = { id, actor, token, response, closed: false, timer: null };
  stream.timer = setInterval(() => { void verifyStream(stream); }, 250);
  streams.add(stream);
  response.on("close", () => closeStream(stream));
});

app.post("/step-up/challenge", async (request, reply) => {
  requireProbeKey(request);
  const { session } = requestSession(request);
  const operationId = boundedString(request.body?.operation_id, OPERATION_PATTERN, "operation_id_invalid");
  const action = boundedString(request.body?.action, /^[a-z]+$/u, "action_invalid");
  if (!ACTIONS.has(action)) fail("action_invalid", 400);
  const challengeId = randomBytes(24).toString("base64url");
  challenges.set(challengeId, {
    actor: session.userId,
    operationId,
    action,
    sessionCsrf: session.csrfToken,
    expiresAt: Date.now() + stepUpTtlMs,
    used: false,
  });
  reply.send({ challenge_id: challengeId, expires_in_ms: stepUpTtlMs, binding: "session-actor-operation-action" });
});

app.post("/step-up/complete", async (request, reply) => {
  requireProbeKey(request);
  const { id, session } = requestSession(request);
  const challengeId = boundedString(request.body?.challenge_id, /^[A-Za-z0-9_-]{16,128}$/u, "challenge_id_invalid");
  const operationId = boundedString(request.body?.operation_id, OPERATION_PATTERN, "operation_id_invalid");
  const action = boundedString(request.body?.action, /^[a-z]+$/u, "action_invalid");
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) fail("step_up_rejected", 403);
  if (challenge.actor !== session.userId || challenge.sessionCsrf !== session.csrfToken ||
      challenge.operationId !== operationId || challenge.action !== action) {
    fail("step_up_binding_mismatch", 403);
  }
  const actor = await currentActor(request);
  if (actor !== challenge.actor) fail("step_up_actor_mismatch", 403);
  challenge.used = true;
  challenges.set(challengeId, challenge);
  reply.send({
    status: "fresh_step_up_accepted",
    actor,
    operation_id: operationId,
    action,
    issuer: matrixOrigin.origin,
    challenge_used: true,
    session_bound: id.length > 0,
  });
});

app.get("/diagnostics", async (request, reply) => {
  requireProbeKey(request);
  reply.send({
    credential_storage: { matrix_token_in_memory_only: true, matrix_token_in_database: false, matrix_token_in_logs: false },
    sessions: sessions.size,
    challenges: challenges.size,
    active_sse_streams: streams.size,
    matrix_whoami_checks: counters.matrixWhoami,
    database_probes: counters.databaseProbe,
  });
});

const address = await app.listen({ host, port });
process.stdout.write(`${JSON.stringify({ status: "ready", url: address, run_id: runId })}\n`);

async function shutdown() {
  for (const stream of [...streams]) closeStream(stream);
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
}

process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
