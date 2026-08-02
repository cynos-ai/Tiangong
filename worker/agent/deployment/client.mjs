import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { createChangeRevisionRef } from "../work/change-revision-ref.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_AGENTTEAMS_DEPLOYMENT_BROKER_ENDPOINT = "http://tiangong-deployment-broker:8791/v1/deploy";

function endpoint(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Deployment broker endpoint must be an absolute URL"); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/v1/deploy" || !HOST.test(parsed.hostname)) {
    throw new Error("Deployment broker endpoint must be a credential-free internal HTTP /v1/deploy URL");
  }
  return parsed.toString();
}

export function deploymentBrokerEndpointForWorker({ role, env = process.env } = {}) {
  if (role !== "operator") return undefined;
  if (env.TIANGONG_DEPLOYMENT_BROKER_ENDPOINT !== undefined) {
    if (typeof env.TIANGONG_DEPLOYMENT_BROKER_ENDPOINT !== "string" || env.TIANGONG_DEPLOYMENT_BROKER_ENDPOINT === "") {
      throw new Error("Configured deployment broker endpoint is empty");
    }
    return endpoint(env.TIANGONG_DEPLOYMENT_BROKER_ENDPOINT);
  }
  return typeof env.AGENTTEAMS_WORKER_NAME === "string" && env.AGENTTEAMS_WORKER_NAME !== ""
    ? DEFAULT_AGENTTEAMS_DEPLOYMENT_BROKER_ENDPOINT
    : undefined;
}

async function bounded(response) {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== "function") throw new Error("DEPLOYMENT_BROKER_RESPONSE_INVALID");
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk); bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("DEPLOYMENT_BROKER_RESPONSE_TOO_LARGE");
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("DEPLOYMENT_BROKER_RESPONSE_INVALID"); }
}

export function createDeploymentBrokerClient({ brokerEndpoint, taskId, fetchImpl = globalThis.fetch }) {
  const url = endpoint(brokerEndpoint);
  if (typeof taskId !== "string" || !ID.test(taskId) || typeof fetchImpl !== "function") throw new TypeError("Deployment broker client binding is invalid");
  async function request(path, value) {
    const requestUrl = new URL(url); requestUrl.pathname = path;
    const response = await fetchImpl(requestUrl, { method: "POST", headers: { "content-type": "application/json" }, body: canonicalJson(value) });
    if (!response || response.status !== 200) throw new Error("DEPLOYMENT_BROKER_REQUEST_REJECTED");
    return bounded(response);
  }
  return Object.freeze({
    async plan({ changeRevisionRef }) {
      const revision = createChangeRevisionRef(changeRevisionRef);
      const value = await request("/v1/plan", { schemaVersion: 1, taskId, changeRevisionRef: revision });
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\n") !== ["changeRevisionRef", "previousDigest", "targetId"].sort().join("\n") ||
          typeof value.targetId !== "string" || !ID.test(value.targetId) || !DIGEST.test(value.previousDigest ?? "") || canonicalJson(createChangeRevisionRef(value.changeRevisionRef)) !== canonicalJson(revision)) {
        throw new Error("DEPLOYMENT_BROKER_RESPONSE_INVALID");
      }
      return value;
    },
    async deploy({ actionDigest, changeRevisionRef }) {
      if (typeof actionDigest !== "string" || !DIGEST.test(actionDigest)) throw new Error("Deployment action digest is invalid");
      const revision = createChangeRevisionRef(changeRevisionRef);
      const value = await request("/v1/deploy", { schemaVersion: 1, taskId, actionDigest, changeRevisionRef: revision });
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join("\n") !== ["outcome", "replayed"].sort().join("\n") ||
          typeof value.replayed !== "boolean" || !isDeploymentOutcome(value.outcome)) throw new Error("DEPLOYMENT_BROKER_RESPONSE_INVALID");
      return value;
    },
  });
}

export function createDeploymentOutcome(input) {
  const revision = createChangeRevisionRef(input.changeRevisionRef);
  const disposition = input.disposition;
  if (!new Set(["DELIVERED", "FAILED_SAFE", "RECOVERY_REQUIRED"]).has(disposition) ||
      typeof input.taskId !== "string" || !ID.test(input.taskId) ||
      typeof input.targetId !== "string" || !ID.test(input.targetId) ||
      !DIGEST.test(input.operationDigest ?? "") || !DIGEST.test(input.previousDigest ?? "") ||
      !DIGEST.test(input.currentDigest ?? "") || typeof input.postVerifyHealthy !== "boolean" ||
      typeof input.rollbackPerformed !== "boolean" ||
      !(input.previousVerifyHealthy === null || typeof input.previousVerifyHealthy === "boolean")) {
    throw new Error("Deployment outcome is invalid");
  }
  if ((disposition === "DELIVERED" && (!input.postVerifyHealthy || input.rollbackPerformed || input.currentDigest !== revision.artifactDigest)) ||
      (disposition === "FAILED_SAFE" && (input.postVerifyHealthy || !input.rollbackPerformed || input.previousVerifyHealthy !== true || input.currentDigest !== input.previousDigest)) ||
      (disposition === "RECOVERY_REQUIRED" && input.postVerifyHealthy)) {
    throw new Error("Deployment outcome disposition is inconsistent");
  }
  const base = Object.freeze({
    kind: "tiangong.deployment-outcome", schemaVersion: 1,
    taskId: input.taskId, targetId: input.targetId, operationDigest: input.operationDigest,
    previousDigest: input.previousDigest, currentDigest: input.currentDigest,
    changeRevisionRef: revision, disposition, postVerifyHealthy: input.postVerifyHealthy,
    rollbackPerformed: input.rollbackPerformed, previousVerifyHealthy: input.previousVerifyHealthy,
  });
  return Object.freeze({ ...base, contentDigest: sha256(base) });
}

export function isDeploymentOutcome(value) {
  try { return canonicalJson(createDeploymentOutcome(value)) === canonicalJson(value); } catch { return false; }
}
