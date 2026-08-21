import { canonicalJson, sha256 } from "./canonical-json.mjs";

const RESPONSIBILITY = /^[a-z][a-z0-9_-]{0,63}$/u;
const RUNTIME = "openclaw-built-in";

export const RESPONSIBILITY_RUNTIME_MATRIX = Object.freeze({
  leader: Object.freeze({ responsibility: "leader", runtime: "openclaw-built-in", coding: false }),
  architect: Object.freeze({ responsibility: "architect", runtime: "openclaw-built-in", coding: false }),
  challenger: Object.freeze({ responsibility: "challenger", runtime: "openclaw-built-in", coding: false }),
  developer: Object.freeze({ responsibility: "developer", runtime: "openclaw-built-in", coding: true }),
  reviewer: Object.freeze({ responsibility: "reviewer", runtime: "openclaw-built-in", coding: false }),
  tester: Object.freeze({ responsibility: "tester", runtime: "openclaw-built-in", coding: false }),
});

function fail(reasonCode, message) { throw Object.assign(new Error(message), { code: "TIANGONG_RUNTIME_ROUTE_INVALID", reasonCode }); }
function responsibility(value) {
  const normalized = value === "team_leader" ? "leader" : value;
  if (typeof normalized !== "string" || !RESPONSIBILITY.test(normalized)) fail("RESPONSIBILITY_INVALID", "Runtime routing requires a bounded professional responsibility");
  if (!Object.hasOwn(RESPONSIBILITY_RUNTIME_MATRIX, normalized)) fail("RESPONSIBILITY_UNSUPPORTED", `No initial runtime route exists for ${normalized}`);
  return normalized;
}

export function assertMemberRuntimeRoute({ responsibility: inputResponsibility, configuredRuntime, configuredModel, selectedRuntime, selectedModel, fallback = "none" } = {}) {
  const resolved = responsibility(inputResponsibility); const expected = RESPONSIBILITY_RUNTIME_MATRIX[resolved];
  if (fallback !== "none") fail("FALLBACK_FORBIDDEN", "Initial MemberConfig routes require fallback=none");
  if (configuredRuntime !== RUNTIME || configuredRuntime !== expected.runtime) fail("RUNTIME_RESPONSIBILITY_MISMATCH", `${resolved} must configure ${expected.runtime}`);
  if (selectedRuntime !== configuredRuntime) fail("RUNTIME_CONFIG_MISMATCH", "Selected runtime differs from current MemberConfig");
  if (typeof configuredModel !== "string" || configuredModel.length === 0 || selectedModel !== configuredModel) fail("MODEL_CONFIG_MISMATCH", "Selected model differs from current MemberConfig");
  const route = { schemaVersion: 2, responsibility: resolved, runtime: configuredRuntime, model: configuredModel, coding: expected.coding, fallback: "none" };
  return Object.freeze({ ...route, routeDigest: sha256(canonicalJson(route)) });
}

/** Validate the deployment projection of the current MemberConfig. */
export function runtimeRouteFromEnvironment(env = process.env) {
  const inputResponsibility = env.TIANGONG_MEMBER_RESPONSIBILITY ?? (env.AGENTTEAMS_WORKER_ROLE === "team_leader" ? "leader" : undefined);
  if (!inputResponsibility) fail("RESPONSIBILITY_MISSING", "TIANGONG_MEMBER_RESPONSIBILITY is required for non-Leader members");
  const configuredRuntime = env.TIANGONG_MEMBER_RUNTIME;
  const configuredModel = env.TIANGONG_MEMBER_MODEL;
  if (!configuredRuntime || !configuredModel) fail("MEMBER_CONFIG_MISSING", "Current MemberConfig runtime and model projection are required");
  const selectedRuntime = "openclaw-built-in";
  const selectedModel = env.AGENTTEAMS_MODEL ?? env.TIANGONG_SELECTED_MODEL;
  return assertMemberRuntimeRoute({ responsibility: inputResponsibility, configuredRuntime, configuredModel, selectedRuntime, selectedModel, fallback: env.OPENCLAW_AGENT_HARNESS_FALLBACK ?? "none" });
}
