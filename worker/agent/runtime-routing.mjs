// B5 role/runtime contract.
//
// OpenClaw remains the runtime owner. Tiangong only binds a professional role
// to the one upstream runtime that the deployment has approved for that role;
// it never implements another model loop or a fallback harness.

import { canonicalJson, sha256 } from "./canonical-json.mjs";

const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const RUNTIME_SET = new Set(["openclaw-built-in", "codex-app-server"]);

export const ROLE_RUNTIME_MATRIX = Object.freeze({
  leader: Object.freeze({ roleId: "leader", runtime: "openclaw-built-in", coding: false }),
  designer: Object.freeze({ roleId: "designer", runtime: "openclaw-built-in", coding: false }),
  implementor: Object.freeze({ roleId: "implementor", runtime: "codex-app-server", coding: true }),
  assessor: Object.freeze({ roleId: "assessor", runtime: "openclaw-built-in", coding: false }),
  operator: Object.freeze({ roleId: "operator", runtime: "openclaw-built-in", coding: false }),
});

function fail(reasonCode, message) {
  const error = new Error(message);
  error.code = "TIANGONG_RUNTIME_ROUTE_INVALID";
  error.reasonCode = reasonCode;
  throw error;
}

function roleId(value) {
  const normalized = value === "team_leader" ? "leader" : value;
  if (typeof normalized !== "string" || !ROLE_PATTERN.test(normalized)) {
    fail("ROLE_INVALID", "Runtime routing requires a bounded role id");
  }
  if (!Object.hasOwn(ROLE_RUNTIME_MATRIX, normalized)) {
    fail("ROLE_UNSUPPORTED", `No B5 runtime route exists for role ${normalized}`);
  }
  return normalized;
}

/** Resolve the role from deployment-owned identity metadata, never from model text. */
export function roleIdFromEnvironment(env = process.env) {
  const configured = typeof env?.TIANGONG_ROLE_ID === "string" && env.TIANGONG_ROLE_ID !== ""
    ? env.TIANGONG_ROLE_ID
    : env?.AGENTTEAMS_WORKER_ROLE === "team_leader" ? "leader" : undefined;
  if (!configured) fail("ROLE_MISSING", "B5 runtime routing requires TIANGONG_ROLE_ID for a non-Leader Worker");
  return roleId(configured);
}

/**
 * Validate one deployment-selected route. `fallback` is deliberately part of
 * the contract so a route cannot silently drop into a second Agent Kernel.
 */
export function assertRoleRuntimeRoute({ roleId: configuredRole, runtime, fallback = "none" } = {}) {
  const resolvedRole = roleId(configuredRole);
  const expected = ROLE_RUNTIME_MATRIX[resolvedRole];
  if (fallback !== "none") fail("FALLBACK_FORBIDDEN", "B5 role routes require fallback=none");
  if (runtime !== expected.runtime) {
    fail("RUNTIME_ROLE_MISMATCH", `${resolvedRole} must use ${expected.runtime}, not ${String(runtime)}`);
  }
  if (!RUNTIME_SET.has(runtime)) fail("RUNTIME_UNSUPPORTED", `Unsupported runtime ${String(runtime)}`);
  const route = {
    schemaVersion: 1,
    roleId: resolvedRole,
    runtime,
    coding: expected.coding,
    fallback: "none",
  };
  return Object.freeze({ ...route, routeDigest: sha256(canonicalJson(route)) });
}

/** Build the route selected by the current environment and fail closed. */
export function runtimeRouteFromEnvironment(env = process.env) {
  const role = roleIdFromEnvironment(env);
  const runtime = env?.TIANGONG_CODEX_RUNTIME === "1" ? "codex-app-server" : "openclaw-built-in";
  return assertRoleRuntimeRoute({
    roleId: role,
    runtime,
    fallback: env?.OPENCLAW_AGENT_HARNESS_FALLBACK ?? "none",
  });
}
