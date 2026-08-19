import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMemberAgent } from "../../worker/agent/packages/loader.mjs";
import { readLeaderRuntimeBinding } from "../../worker/agent/team/leader-runtime-config.mjs";
import { createRuntimeConsoleServer } from "../server.mjs";
import { createMatrixWebGateway } from "../matrix-web-gateway.mjs";
import { createPostgresCoordinationStore } from "./bootstrap.mjs";
import { createMatrixWakeConsumer } from "./matrix-wake-consumer.mjs";

function required(value, name) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) throw new TypeError(`${name} is required`);
  return value;
}

function portValue(value) {
  const port = Number(value ?? 8780);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("Coordination runtime port is invalid");
  return port;
}

/**
 * Start the deployment-owned Coordination API and optional Matrix outbox
 * consumer. This process is the only component that receives PG/Matrix
 * secrets; the Worker connects through the narrow bearer API.
 */
export async function startCoordinationRuntime(options = {}) {
  const bindingFile = options.bindingFile ?? process.env.TIANGONG_LEADER_RUNTIME_BINDING_FILE;
  const controlToken = required(options.controlToken ?? process.env.TIANGONG_COORDINATION_CONTROL_TOKEN, "TIANGONG_COORDINATION_CONTROL_TOKEN");
  const binding = options.binding ?? await readLeaderRuntimeBinding(required(bindingFile, "TIANGONG_LEADER_RUNTIME_BINDING_FILE"));
  let pool = options.pool;
  let store = options.store;
  if (!store) {
    const created = createPostgresCoordinationStore({ connectionString: options.databaseUrl ?? process.env.TIANGONG_COORDINATION_DATABASE_URL });
    pool = created.pool;
    store = created.store;
  }
  if (!pool || typeof pool.end !== "function") pool = { async end() {} };
  await Promise.all(binding.members.map((memberConfig) => resolveMemberAgent({ memberConfig })));
  await store.migrate();
  const matrixUrl = options.matrixUrl ?? process.env.AGENTTEAMS_MATRIX_URL ?? process.env.TIANGONG_MATRIX_URL;
  const matrixToken = options.matrixToken ?? process.env.TIANGONG_COORDINATION_MATRIX_TOKEN;
  if (!matrixUrl && matrixToken) throw new TypeError("Matrix wake consumer token requires a Matrix URL");
  const consumer = matrixUrl && matrixToken ? createMatrixWakeConsumer({
    store,
    binding,
    matrixUrl,
    matrixToken,
    consumerId: options.consumerId ?? process.env.TIANGONG_COORDINATION_CONSUMER_ID ?? "tiangong-coordination-matrix",
    intervalMs: options.intervalMs ?? Number(process.env.TIANGONG_COORDINATION_OUTBOX_INTERVAL_MS ?? 2_000),
    fetchImpl: options.fetchImpl,
  }) : null;
  const matrixWebGateway = options.matrixWebGateway ?? (matrixUrl ? createMatrixWebGateway({
    matrixUrl,
    binding,
    fetchImpl: options.matrixWebFetchImpl ?? options.fetchImpl,
    secureCookies: options.secureCookies ?? process.env.TIANGONG_WEB_SECURE_COOKIES !== "0",
  }) : null);
  const server = createRuntimeConsoleServer({
    factsFile: options.factsFile,
    captureFile: options.captureFile,
    coordinationStore: store,
    memberConfigs: binding.members,
    matrixWebGateway,
    coordinationControl: {
      store,
      bearerToken: controlToken,
      team: binding.team,
      route: binding.route,
      profile: binding.profile,
      leaderMember: binding.leaderMember,
      members: binding.members,
      leaderSessionId: options.leaderSessionId,
    },
    readiness: async () => {
      await store.health();
      if (consumer && consumer.health().lastErrorCode && !consumer.health().identityReady) return { ready: false, source: "matrix-consumer-not-ready" };
      return { ready: true, source: consumer ? "postgres-and-matrix" : "postgres" };
    },
  });
  const port = portValue(options.port ?? process.env.TIANGONG_COORDINATION_PORT ?? process.env.PORT);
  const host = options.host ?? "0.0.0.0";
  await new Promise((resolveListen, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolveListen(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  try {
    if (consumer) await consumer.start();
  } catch (error) {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    await pool.end();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    server,
    pool,
    store,
    binding,
    consumer,
    port,
    async close() {
      if (closed) return;
      closed = true;
      await consumer?.stop();
      await matrixWebGateway?.close?.();
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await pool.end();
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let runtime;
  try {
    runtime = await startCoordinationRuntime();
    process.stdout.write(`tiangong_coordination_runtime_listening=${runtime.port}\n`);
    const shutdown = async () => {
      try { await runtime.close(); process.exit(0); } catch { process.exit(1); }
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch {
    process.exitCode = 1;
  }
}
