import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRoleRuntimeRoute,
  ROLE_RUNTIME_MATRIX,
  roleIdFromEnvironment,
  runtimeRouteFromEnvironment,
} from "../agent/runtime-routing.mjs";

test("B5 role matrix routes the Leader and non-coding professionals to OpenClaw built-in", () => {
  for (const roleId of ["leader", "designer", "assessor", "operator"]) {
    const route = assertRoleRuntimeRoute({ roleId, runtime: "openclaw-built-in", fallback: "none" });
    assert.equal(route.coding, false);
    assert.match(route.routeDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(ROLE_RUNTIME_MATRIX[roleId].runtime, "openclaw-built-in");
  }
});

test("B5 routes the Implementor to Codex app-server with no fallback", () => {
  const route = runtimeRouteFromEnvironment({
    TIANGONG_ROLE_ID: "implementor",
    TIANGONG_CODEX_RUNTIME: "1",
    OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
  });
  assert.deepEqual(route, {
    schemaVersion: 1,
    roleId: "implementor",
    runtime: "codex-app-server",
    coding: true,
    fallback: "none",
    routeDigest: route.routeDigest,
  });
});

test("B5 rejects a Codex runtime accidentally selected for the Leader", () => {
  assert.throws(
    () => runtimeRouteFromEnvironment({
      AGENTTEAMS_WORKER_ROLE: "team_leader",
      TIANGONG_CODEX_RUNTIME: "1",
      OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
    }),
    (error) => error.code === "TIANGONG_RUNTIME_ROUTE_INVALID" && error.reasonCode === "RUNTIME_ROLE_MISMATCH",
  );
});

test("B5 rejects fallback and unknown role metadata", () => {
  assert.throws(
    () => assertRoleRuntimeRoute({ roleId: "implementor", runtime: "codex-app-server", fallback: "legacy-runtime" }),
    (error) => error.reasonCode === "FALLBACK_FORBIDDEN",
  );
  assert.throws(() => roleIdFromEnvironment({ AGENTTEAMS_WORKER_ROLE: "worker" }), (error) => error.reasonCode === "ROLE_MISSING");
  assert.throws(() => assertRoleRuntimeRoute({ roleId: "reviewer", runtime: "openclaw-built-in" }), (error) => error.reasonCode === "ROLE_UNSUPPORTED");
});
