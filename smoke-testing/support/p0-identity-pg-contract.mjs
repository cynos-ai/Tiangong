import { readFile } from "node:fs/promises";
import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { resolve } from "node:path";

export const TRANSIENT_AUTH_MODE = "transient_matrix_proof";
export const REQUIRED_COOKIE_FLAGS = ["HttpOnly", "SameSite=Strict", "Path=/"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertHealth(value) {
  ok(isRecord(value));
  strictEqual(value.status, "ready");
  strictEqual(value.database, "ready");
  strictEqual(value.network, "agentteams");
  return true;
}

export function assertReadAuthorization(value, expectedActor) {
  ok(isRecord(value));
  strictEqual(value.actor, expectedActor);
  strictEqual(value.auth_mode, TRANSIENT_AUTH_MODE);
  strictEqual(value.max_staleness_ms, 0);
  return true;
}

export function assertDatabaseFacts(value) {
  ok(isRecord(value));
  strictEqual(value.unique_constraint?.insert_committed, true);
  strictEqual(value.unique_constraint?.duplicate_rejected, true);
  strictEqual(value.select_for_update?.committed_transactions, 2);
  strictEqual(value.select_for_update?.final_epoch, 2);
  ok(["first-commit", "second-commit"].includes(value.select_for_update?.final_value));
  strictEqual(value.optimistic_epoch?.accepted, 1);
  strictEqual(value.optimistic_epoch?.rejected, 1);
  strictEqual(value.optimistic_epoch?.final_epoch, 1);
  strictEqual(value.credential_free_rows, true);
  return true;
}

export function assertCookieHeader(header) {
  strictEqual(typeof header, "string");
  match(header, /^tiangong_probe_session=[A-Za-z0-9._~-]{16,128};/u);
  for (const flag of REQUIRED_COOKIE_FLAGS) ok(header.includes(flag), `missing cookie flag ${flag}`);
  ok(!header.includes("Secure"), "the HTTP-only local probe must not claim Secure on plain HTTP");
  return true;
}

export function assertFreshStepUp(value, actor, operationId, action, issuer) {
  ok(isRecord(value));
  strictEqual(value.status, "fresh_step_up_accepted");
  strictEqual(value.actor, actor);
  strictEqual(value.operation_id, operationId);
  strictEqual(value.action, action);
  strictEqual(value.issuer, issuer);
  strictEqual(value.challenge_used, true);
  strictEqual(value.session_bound, true);
  return true;
}

export function assertNoCredentialLeak(text, secrets) {
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) strictEqual(text.includes(secret), false, "credential leaked into observable text");
  }
  ok(!/(Bearer\s+[A-Za-z0-9._~-]{16,512}|password\s*[:=]|access_token\s*[:=])/iu.test(text));
  return true;
}

export async function assertFixtureAssets(root) {
  const packageJson = JSON.parse(await readFile(resolve(root, "app/package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "app/package-lock.json"), "utf8"));
  strictEqual(packageJson.private, true);
  strictEqual(packageJson.dependencies.fastify, "5.11.3");
  strictEqual(packageJson.dependencies.pg, "8.23.0");
  strictEqual(packageJson.devDependencies.vite, "7.3.6");
  strictEqual(lock.lockfileVersion, 3);
  const packageSources = Object.values(lock.packages).flatMap((entry) => entry?.resolved ? [entry.resolved] : []);
  ok(packageSources.every((source) => source.startsWith("https://registry.npmjs.org/")));
  const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
  match(dockerfile, /FROM node:22\.23\.2-bookworm-slim@sha256:[a-f0-9]{64} AS build/u);
  match(dockerfile, /FROM node:22\.23\.2-bookworm-slim@sha256:[a-f0-9]{64}\n/u);
  match(dockerfile, /npm ci --omit=dev/u);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assertFixtureAssets(resolve(process.cwd(), "smoke-testing/fixtures/p0-identity-pg"));
  const actor = "@p0-human:matrix-local.agentteams.io:18080";
  assertHealth({ status: "ready", database: "ready", network: "agentteams" });
  assertReadAuthorization({ actor, auth_mode: TRANSIENT_AUTH_MODE, max_staleness_ms: 0 }, actor);
  assertDatabaseFacts({
    unique_constraint: { insert_committed: true, duplicate_rejected: true },
    select_for_update: { committed_transactions: 2, final_epoch: 2, final_value: "second-commit" },
    optimistic_epoch: { accepted: 1, rejected: 1, final_epoch: 1 },
    credential_free_rows: true,
  });
  assertCookieHeader("tiangong_probe_session=abcdefghijklmnopqrstuvwxyz0123456789; HttpOnly; SameSite=Strict; Path=/; Max-Age=30");
  assertFreshStepUp({
    status: "fresh_step_up_accepted", actor, operation_id: "p0-operation-1", action: "approve",
    issuer: "http://matrix.local", challenge_used: true, session_bound: true,
  }, actor, "p0-operation-1", "approve", "http://matrix.local");
  assertNoCredentialLeak("status=ready actor=@p0-human:matrix.local", ["super-secret-token"]);
  throws(() => assertReadAuthorization({ actor, auth_mode: "bounded_ttl", max_staleness_ms: 30000 }, actor));
  console.log("p0 identity/postgresql contract: 8/8 passed");
}
