import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../canonical-json.mjs";
import { DeploymentJournal } from "./journal.mjs";

const CONFIG_PATH = "/run/tiangong-deployment-service/config.json";
const STATE_PATH = "/var/lib/tiangong-deployment-service/events.jsonl";
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const CAPABILITY = /^[A-Za-z0-9._~-]{32,256}$/u;
const FAULT_MODES = new Set(["none", "post_verify_fail", "rollback_fail", "verify_previous_fail"]);
const CONFIG_KEYS = ["capabilityDigest", "faultMode", "listenPort", "previousDigest", "schemaVersion", "targetId"];

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function demand(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} has an invalid format`);
  return value;
}

export function validateDeploymentServiceConfig(value) {
  exactKeys(value, CONFIG_KEYS, "Deployment service config");
  if (value.schemaVersion !== 1 || !Number.isInteger(value.listenPort) || value.listenPort < 1 || value.listenPort > 65535 ||
      !FAULT_MODES.has(value.faultMode)) throw new Error("Deployment service config is invalid");
  return Object.freeze({
    schemaVersion: 1,
    listenPort: value.listenPort,
    targetId: demand(value.targetId, ID, "targetId"),
    previousDigest: demand(value.previousDigest, DIGEST, "previousDigest"),
    capabilityDigest: demand(value.capabilityDigest, DIGEST, "capabilityDigest"),
    faultMode: value.faultMode,
  });
}

async function readBoundedJson(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error("Deployment service config must be a bounded regular file");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertCapability(request, expectedDigest) {
  const authorizationHeaders = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "authorization") authorizationHeaders.push(request.rawHeaders[index + 1]);
  }
  if (authorizationHeaders.length !== 1 || !authorizationHeaders[0].startsWith("Bearer ")) {
    throw new Error("DEPLOYMENT_AUTHORIZATION_REJECTED");
  }
  const capability = authorizationHeaders[0].slice("Bearer ".length);
  const actualDigest = CAPABILITY.test(capability) ? sha256(capability) : "0".repeat(64);
  if (!CAPABILITY.test(capability) || !timingSafeEqual(Buffer.from(actualDigest, "hex"), Buffer.from(expectedDigest, "hex"))) {
    throw new Error("DEPLOYMENT_AUTHORIZATION_REJECTED");
  }
}

async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("DEPLOYMENT_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("DEPLOYMENT_REQUEST_INVALID");
  }
}

function send(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function createDeploymentServiceHandler({ config, journal }) {
  if (!config?.capabilityDigest || !journal) throw new TypeError("Deployment service requires config and journal");
  return async function handle(request, response) {
    try {
      assertCapability(request, config.capabilityDigest);
      if (request.method === "GET" && request.url === "/v1/status") {
        send(response, 200, { status: await journal.status() });
        return;
      }
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
        send(response, 404, { error: "DEPLOYMENT_ROUTE_NOT_FOUND" });
        return;
      }
      const body = await readBody(request);
      if (request.url === "/v1/stage") {
        exactKeys(body, ["artifactDigest", "expectedCurrentDigest", "operationId", "rollbackDigest"], "stage request");
        send(response, 200, await journal.stage(body));
      } else if (request.url === "/v1/activate") {
        exactKeys(body, ["operationId"], "activate request");
        send(response, 200, await journal.activate(body));
      } else if (request.url === "/v1/verify") {
        exactKeys(body, ["expectedDigest", "operationId", "phase"], "verify request");
        send(response, 200, await journal.verify(body));
      } else if (request.url === "/v1/rollback") {
        exactKeys(body, ["operationId"], "rollback request");
        send(response, 200, await journal.rollback(body));
      } else {
        send(response, 404, { error: "DEPLOYMENT_ROUTE_NOT_FOUND" });
      }
    } catch (error) {
      const authorization = error?.message === "DEPLOYMENT_AUTHORIZATION_REJECTED";
      process.stderr.write(`deployment_service_request_failed code=${authorization ? "DEPLOYMENT_AUTHORIZATION_REJECTED" : "DEPLOYMENT_REQUEST_REJECTED"}\n`);
      if (!response.headersSent) send(response, authorization ? 403 : 409, {
        error: authorization ? "DEPLOYMENT_AUTHORIZATION_REJECTED" : "DEPLOYMENT_REQUEST_REJECTED",
      });
      else response.destroy();
    }
  };
}

export async function startDeploymentService({ configPath = CONFIG_PATH, statePath = STATE_PATH } = {}) {
  const config = validateDeploymentServiceConfig(await readBoundedJson(configPath));
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const journal = new DeploymentJournal({
    filePath: statePath,
    targetId: config.targetId,
    previousDigest: config.previousDigest,
    faultMode: config.faultMode,
  });
  await journal.status();
  const server = createServer(createDeploymentServiceHandler({ config, journal }));
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, "0.0.0.0", () => {
      server.off("error", reject);
      ready();
    });
  });
  return { server, config, journal };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { server, config } = await startDeploymentService();
  process.stdout.write(`deployment_service_ready=pass port=${config.listenPort} target=${config.targetId}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
