import { canonicalJson, sha256 } from "../../worker/agent/canonical-json.mjs";

export const COORDINATION_MIGRATION_CONTRACT_VERSION = 1;
export const REQUIRED_MIGRATION_GATES = Object.freeze([
  "providerCanary",
  "matrixWeb",
  "toolResultRetention",
  "restartRecovery",
  "rollback",
  "cleanup",
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PHASES = new Set(["planned", "prepared", "canary", "cutover", "rolled-back", "completed"]);
const ALLOWED_TRANSITIONS = Object.freeze({
  planned: new Set(["prepared", "canary"]),
  prepared: new Set(["canary", "rolled-back"]),
  canary: new Set(["cutover", "rolled-back"]),
  cutover: new Set(["completed", "rolled-back"]),
  "rolled-back": new Set(),
  completed: new Set(),
});
const ROUTE_TRANSPORTS = new Set(["native-responses", "responses-via-chat-bridge"]);
const GATE_RESULTS = new Set(["pass", "fail", "unknown"]);

export class CoordinationMigrationContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoordinationMigrationContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoordinationMigrationContractError(code, message);
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("migration-object-invalid", `${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("migration-field-unknown", `${name} contains unsupported field ${key}.`);
}

function id(value, name) {
  if (typeof value !== "string" || !ID.test(value)) fail("migration-id-invalid", `${name} is invalid.`);
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("migration-digest-invalid", `${name} must be a lowercase SHA-256 digest.`);
  return value;
}

function timestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("migration-timestamp-invalid", `${name} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function boundedWindow(value) {
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 7 * 24 * 60 * 60 * 1000) {
    fail("migration-recovery-window-invalid", "rollback.maxRecoveryWindowMs must be between one minute and seven days.");
  }
  return value;
}

function route(value, name) {
  exactKeys(value, new Set(["provider", "model", "endpoint", "transport", "bridge", "credentialSource"]), name);
  const provider = id(value.provider, `${name}.provider`);
  const model = id(value.model, `${name}.model`);
  if (typeof value.endpoint !== "string" || value.endpoint.length === 0) fail("migration-endpoint-invalid", `${name}.endpoint is required.`);
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { fail("migration-endpoint-invalid", `${name}.endpoint is invalid.`); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail("migration-endpoint-unsafe", `${name}.endpoint must not contain credentials, query, or fragment.`);
  }
  const transport = value.transport;
  if (!ROUTE_TRANSPORTS.has(transport)) fail("migration-transport-invalid", `${name}.transport is unsupported.`);
  const bridge = value.bridge ?? null;
  if (transport === "native-responses" && bridge !== null) fail("migration-bridge-invalid", `${name} native Responses route must not have a bridge.`);
  if (transport === "responses-via-chat-bridge" && bridge !== "opencodex") fail("migration-bridge-invalid", `${name} Chat-only route must use the OpenCodex bridge.`);
  if (value.credentialSource !== "agentteams-secret") fail("migration-credential-source-invalid", `${name}.credentialSource must be agentteams-secret.`);
  return Object.freeze({
    provider,
    model,
    endpoint: endpoint.toString().replace(/\/$/u, ""),
    transport,
    bridge,
    credentialSource: "agentteams-secret",
  });
}

function gateNames(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_MIGRATION_GATES.length ||
      value.some((entry) => typeof entry !== "string" || !REQUIRED_MIGRATION_GATES.includes(entry)) ||
      new Set(value).size !== REQUIRED_MIGRATION_GATES.length) {
    fail("migration-gates-invalid", "requiredGates must contain each migration gate exactly once.");
  }
  return Object.freeze([...value]);
}

export function routeDigest(routeValue) {
  return sha256(route(routeValue, "route"));
}

export function createCoordinationMigrationPlan(input = {}) {
  exactKeys(input, new Set([
    "contractVersion", "migrationId", "createdAt", "source", "target", "defaultRoute",
    "candidateRoute", "rollback", "legacyLane", "requiredGates",
  ]), "migration plan");
  if (input.contractVersion !== COORDINATION_MIGRATION_CONTRACT_VERSION) fail("migration-contract-version-invalid", "Unsupported migration contract version.");
  const migrationId = id(input.migrationId, "migrationId");
  const createdAt = timestamp(input.createdAt, "createdAt");

  exactKeys(input.source, new Set(["lane", "namespace", "snapshotDigest", "snapshotAt"]), "source");
  if (input.source.lane !== "legacy-pi") fail("migration-source-invalid", "Only the retained legacy-pi lane can be migrated by this contract.");
  const source = Object.freeze({
    lane: "legacy-pi",
    namespace: id(input.source.namespace, "source.namespace"),
    snapshotDigest: digest(input.source.snapshotDigest, "source.snapshotDigest"),
    snapshotAt: timestamp(input.source.snapshotAt, "source.snapshotAt"),
  });

  exactKeys(input.target, new Set(["schema", "migrationVersions", "cutoverMode"]), "target");
  if (input.target.schema !== "tiangong_coordination") fail("migration-target-invalid", "target.schema must be tiangong_coordination.");
  if (!Array.isArray(input.target.migrationVersions) || JSON.stringify(input.target.migrationVersions) !== JSON.stringify(["001_coordination", "002_task_result"])) {
    fail("migration-target-invalid", "target.migrationVersions must pin the coordination schema versions in order.");
  }
  if (input.target.cutoverMode !== "shadow-read-then-cutover") fail("migration-cutover-mode-invalid", "Only shadow-read-then-cutover is supported.");
  const target = Object.freeze({ schema: "tiangong_coordination", migrationVersions: Object.freeze([...input.target.migrationVersions]), cutoverMode: input.target.cutoverMode });

  const defaultRoute = route(input.defaultRoute, "defaultRoute");
  const candidateRoute = route(input.candidateRoute, "candidateRoute");
  if (defaultRoute.model === candidateRoute.model && defaultRoute.endpoint === candidateRoute.endpoint) fail("migration-route-not-distinct", "candidateRoute must be distinct from the current default route.");

  exactKeys(input.rollback, new Set(["previousRouteDigest", "snapshotDigest", "owner", "maxRecoveryWindowMs"]), "rollback");
  const rollback = Object.freeze({
    previousRouteDigest: digest(input.rollback.previousRouteDigest, "rollback.previousRouteDigest"),
    snapshotDigest: digest(input.rollback.snapshotDigest, "rollback.snapshotDigest"),
    owner: id(input.rollback.owner, "rollback.owner"),
    maxRecoveryWindowMs: boundedWindow(input.rollback.maxRecoveryWindowMs),
  });
  if (rollback.previousRouteDigest !== routeDigest(defaultRoute) || rollback.snapshotDigest !== source.snapshotDigest) {
    fail("migration-rollback-binding-mismatch", "rollback must bind the current route and the exact source snapshot.");
  }

  exactKeys(input.legacyLane, new Set(["name", "retained", "readOnly"]), "legacyLane");
  if (input.legacyLane.name !== "legacy-pi" || input.legacyLane.retained !== true || input.legacyLane.readOnly !== true) {
    fail("migration-legacy-lane-invalid", "legacy-pi must remain retained and read-only during migration.");
  }
  const legacyLane = Object.freeze({ name: "legacy-pi", retained: true, readOnly: true });
  const requiredGates = gateNames(input.requiredGates);
  const body = { contractVersion: COORDINATION_MIGRATION_CONTRACT_VERSION, migrationId, createdAt, source, target, defaultRoute, candidateRoute, rollback, legacyLane, requiredGates };
  return Object.freeze({ ...body, planDigest: sha256(canonicalJson(body)), phase: "planned" });
}

function validatedPlan(plan) {
  if (!plan || plan.contractVersion !== COORDINATION_MIGRATION_CONTRACT_VERSION || typeof plan.planDigest !== "string" || !PHASES.has(plan.phase)) {
    fail("migration-plan-invalid", "A validated migration plan is required.");
  }
  const { planDigest, phase, ...body } = plan;
  if (sha256(canonicalJson(body)) !== planDigest) fail("migration-plan-tampered", "The migration plan digest does not match its contents.");
  return plan;
}

export function evaluateCoordinationMigrationGates(plan, observations = {}) {
  validatedPlan(plan);
  exactKeys(observations, new Set([...REQUIRED_MIGRATION_GATES, "defaultRouteUnchanged", "targetSchemaReady", "snapshotVerified"]), "migration observations");
  for (const gate of REQUIRED_MIGRATION_GATES) {
    if (!GATE_RESULTS.has(observations[gate])) fail("migration-gate-result-invalid", `${gate} must be pass, fail, or unknown.`);
  }
  const failedGates = plan.requiredGates.filter((gate) => observations[gate] !== "pass");
  const failedFacts = [];
  if (observations.defaultRouteUnchanged !== true) failedFacts.push("defaultRouteUnchanged");
  if (observations.targetSchemaReady !== true) failedFacts.push("targetSchemaReady");
  if (observations.snapshotVerified !== true) failedFacts.push("snapshotVerified");
  return Object.freeze({ ready: failedGates.length === 0 && failedFacts.length === 0, failedGates, failedFacts });
}

export function transitionCoordinationMigration(plan, nextPhase, facts = {}) {
  validatedPlan(plan);
  if (!PHASES.has(nextPhase) || nextPhase === "planned") fail("migration-phase-invalid", `Unsupported migration phase ${nextPhase}.`);
  exactKeys(facts, new Set(["currentPhase", "observations", "currentRouteDigest", "targetSchemaReady", "snapshotVerified", "previousRouteRestored", "cutoverVerified"]), "migration transition facts");
  const currentPhase = facts.currentPhase ?? plan.phase;
  if (!PHASES.has(currentPhase) || !ALLOWED_TRANSITIONS[currentPhase]?.has(nextPhase)) fail("migration-phase-transition-invalid", `Cannot transition migration from ${currentPhase} to ${nextPhase}.`);
  if (nextPhase === "cutover") {
    const gateResult = evaluateCoordinationMigrationGates(plan, facts.observations ?? {});
    if (!gateResult.ready || facts.currentRouteDigest !== routeDigest(plan.defaultRoute) || facts.targetSchemaReady !== true || facts.snapshotVerified !== true) {
      fail("migration-cutover-not-ready", "Migration cutover is not ready; all gates, source snapshot, target schema, and current route must be verified.");
    }
  }
  if (nextPhase === "rolled-back" && (facts.snapshotVerified !== true || facts.previousRouteRestored !== true)) {
    fail("migration-rollback-not-verified", "Rollback requires a verified source snapshot and restored previous route.");
  }
  if (nextPhase === "completed" && facts.cutoverVerified !== true) fail("migration-completion-not-verified", "Migration completion requires an independently verified cutover.");
  return Object.freeze({ migrationId: plan.migrationId, planDigest: plan.planDigest, phase: nextPhase, observedAt: new Date().toISOString() });
}
