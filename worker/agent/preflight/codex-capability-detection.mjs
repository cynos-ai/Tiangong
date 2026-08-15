import { mkdir, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { validateOpenCodexSidecarReceipt } from "../deployment/opencodex-sidecar.mjs";

export const CODEX_AUTO_TRANSPORT = "auto";
export const CODEX_NATIVE_TRANSPORT = "native-responses";
export const CODEX_BRIDGE_TRANSPORT = "responses-via-chat-bridge";
export const CODEX_BRIDGE = "opencodex";
export const CODEX_DETECTOR_VERSION = "responses-probe-v1";

const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export class CodexCapabilityDetectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexCapabilityDetectionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CodexCapabilityDetectionError(code, message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function safeEndpoint(value) {
  const raw = nonEmptyString(value);
  if (!raw) fail("codex-detection-base-url-missing", "Codex capability detection requires a provider base URL.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("codex-detection-base-url-invalid", "Codex capability detection requires a valid provider base URL.");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail("codex-detection-base-url-unsafe", "Codex capability detection requires an HTTP(S) URL without credentials or query data.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function responseHeaders(response) {
  return typeof response?.headers?.get === "function"
    ? nonEmptyString(response.headers.get("content-type"))
    : "";
}

function responseLooksLikeResponses(text, contentType) {
  if (!text || text.length > MAX_PROBE_RESPONSE_BYTES) return false;
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return /response\.(created|completed)|response\.output/iu.test(text);
  }
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) && !body.error;
  } catch {
    return false;
  }
}

function unsupportedErrorBody(text) {
  return /unsupported|not[ -]?supported|unknown[^\n]{0,80}responses|responses[^\n]{0,80}not[ -]?supported|endpoint[^\n]{0,80}(not found|missing)|route[^\n]{0,80}(not found|missing)/iu.test(text);
}

async function readBoundedResponse(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    fail("codex-detection-response-unreadable", "The Responses capability probe response could not be read.");
  }
  if (typeof text !== "string" || text.length > MAX_PROBE_RESPONSE_BYTES) {
    fail("codex-detection-response-unbounded", "The Responses capability probe response exceeded the bounded limit.");
  }
  return text;
}

async function probeNativeResponses({ baseUrl, consumerToken, modelId, fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== "function") fail("codex-detection-client-missing", "No fetch implementation is available for Codex capability detection.");
  if (!nonEmptyString(consumerToken)) fail("codex-detection-token-missing", "Codex capability detection requires the Worker consumer token.");
  if (!nonEmptyString(modelId)) fail("codex-detection-model-missing", "Codex capability detection requires a model id.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    fail("codex-detection-timeout-invalid", "Codex capability detection timeout is outside the bounded range.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL("responses", `${baseUrl}/`).toString(), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${consumerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        input: "Tiangong Responses capability probe",
        max_output_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (!response || !Number.isInteger(response.status)) {
      fail("codex-detection-response-invalid", "The Responses capability probe returned an invalid HTTP response.");
    }
    const text = await readBoundedResponse(response);
    if (response.status >= 200 && response.status < 300) {
      if (!responseLooksLikeResponses(text, responseHeaders(response))) {
        fail("codex-detection-response-contract-invalid", "The Responses capability probe returned an unrecognized response contract.");
      }
      return { outcome: "supported", reasonCode: "responses-supported", status: response.status };
    }
    if ([404, 405, 415].includes(response.status) || (response.status === 400 && unsupportedErrorBody(text))) {
      return { outcome: "unsupported", reasonCode: "responses-endpoint-unsupported", status: response.status };
    }
    fail(`codex-detection-http-${response.status}`, "The Responses capability probe failed for a reason other than protocol incompatibility.");
  } catch (error) {
    if (error instanceof CodexCapabilityDetectionError) throw error;
    fail(error?.name === "AbortError" ? "codex-detection-timeout" : "codex-detection-unreachable", "The Responses capability probe could not establish a bounded result.");
  } finally {
    clearTimeout(timer);
  }
}

async function readReceiptFromUrl(receiptUrl, fetchImpl) {
  if (typeof fetchImpl !== "function") fail("codex-bridge-receipt-unreadable", "The OpenCodex readiness receipt client is unavailable.");
  let url;
  try {
    url = new URL(receiptUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("unsafe");
  } catch {
    fail("codex-bridge-receipt-invalid", "The OpenCodex readiness receipt URL is invalid.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response || response.status !== 200) fail("codex-bridge-receipt-unreadable", "The OpenCodex readiness receipt service did not return a ready receipt.");
    const text = await response.text();
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_RECEIPT_BYTES) fail("codex-bridge-receipt-invalid", "The OpenCodex readiness receipt exceeded the bounded limit.");
    try { return JSON.parse(text); } catch { fail("codex-bridge-receipt-invalid", "The OpenCodex readiness receipt was not valid JSON."); }
  } catch (error) {
    if (error instanceof CodexCapabilityDetectionError) throw error;
    fail(error?.name === "AbortError" ? "codex-bridge-receipt-timeout" : "codex-bridge-receipt-unreadable", "The OpenCodex readiness receipt service could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}

export async function readOpenCodexSidecarReceipt(receiptPath, { provider, model, receiptUrl, fetchImpl = globalThis.fetch } = {}) {
  const source = nonEmptyString(receiptPath) || nonEmptyString(receiptUrl);
  if (!source) {
    fail("codex-compatibility-unavailable", "The model does not expose Responses and no OpenCodex readiness receipt is available.");
  }
  let receipt;
  if (/^https?:\/\//iu.test(source)) {
    receipt = await readReceiptFromUrl(source, fetchImpl);
  } else {
    try {
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_RECEIPT_BYTES) {
        fail("codex-bridge-receipt-invalid", "The OpenCodex readiness receipt is not a bounded regular file.");
      }
      receipt = JSON.parse(await readFile(source, "utf8"));
    } catch (error) {
      if (error instanceof CodexCapabilityDetectionError) throw error;
      fail("codex-bridge-receipt-unreadable", "The OpenCodex readiness receipt could not be read.");
    }
  }
  try {
    return validateOpenCodexSidecarReceipt(receipt, { provider, model });
  } catch {
    fail("codex-bridge-receipt-invalid", "The OpenCodex readiness receipt does not match the selected provider and model.");
  }
}

function recordValue(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value.slice(0, 256) : value;
}

async function writeDetectionRecord(recordPath, record) {
  if (!isAbsolute(recordPath)) fail("codex-detection-record-path-invalid", "Codex capability detection requires an absolute record path.");
  let existing;
  try {
    existing = await lstat(recordPath);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("codex-detection-record-unavailable", "The Codex capability record path could not be inspected.");
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    fail("codex-detection-record-invalid", "The Codex capability record path is not a regular file.");
  }
  const temporaryPath = `${recordPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, recordPath);
  } catch {
    try { await unlink(temporaryPath); } catch { /* best-effort cleanup */ }
    fail("codex-detection-record-write-failed", "The Codex capability result could not be recorded.");
  }
}

async function recordAndReturn({ recordPath, provider, model, baseUrl, outcome, reasonCode, status, transport, bridge, sidecar }) {
  const result = {
    schemaVersion: 1,
    detectorVersion: CODEX_DETECTOR_VERSION,
    checkedAt: new Date().toISOString(),
    provider: recordValue(provider),
    model: recordValue(model),
    endpoint: recordValue(baseUrl),
    outcome,
    reasonCode,
    status: Number.isInteger(status) ? status : null,
    transport,
    ...(bridge ? { bridge } : {}),
    ...(sidecar ? { sidecarId: sidecar.sidecarId, sidecarGeneration: sidecar.generation } : {}),
  };
  if (recordPath) await writeDetectionRecord(recordPath, result);
  return result;
}

/**
 * Probe one selected model at Worker startup. Only a clear protocol-negative
 * response selects OpenCodex; auth, network, malformed, and timeout failures
 * remain errors. The returned record is intentionally metadata-only.
 */
export async function detectCodexRoute({
  provider = "agentteams-gateway",
  model,
  baseUrl,
  consumerToken,
  sidecarReceiptPath,
  sidecarReceiptUrl,
  recordPath,
  requireBridgeReceipt = true,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const endpoint = safeEndpoint(baseUrl);
  let result;
  try {
    result = await probeNativeResponses({ baseUrl: endpoint, consumerToken, modelId: model, fetchImpl, timeoutMs });
  } catch (error) {
    if (error instanceof CodexCapabilityDetectionError) {
      await recordAndReturn({
        recordPath,
        provider,
        model,
        baseUrl: endpoint,
        outcome: "error",
        reasonCode: error.code,
        status: null,
        transport: "unknown",
      });
    }
    throw error;
  }
  if (result.outcome === "supported") {
    return recordAndReturn({
      recordPath,
      provider,
      model,
      baseUrl: endpoint,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      status: result.status,
      transport: CODEX_NATIVE_TRANSPORT,
    });
  }

  let sidecar;
  try {
    if (!requireBridgeReceipt) {
      return recordAndReturn({
        recordPath,
        provider,
        model,
        baseUrl: endpoint,
        outcome: "unsupported",
        reasonCode: result.reasonCode,
        status: result.status,
        transport: CODEX_BRIDGE_TRANSPORT,
        bridge: CODEX_BRIDGE,
      });
    }
    sidecar = await readOpenCodexSidecarReceipt(sidecarReceiptPath, {
      provider,
      model,
      receiptUrl: sidecarReceiptUrl,
      fetchImpl,
    });
  } catch (error) {
    if (error instanceof CodexCapabilityDetectionError) {
      await recordAndReturn({
        recordPath,
        provider,
        model,
        baseUrl: endpoint,
        outcome: "unavailable",
        reasonCode: error.code,
        status: result.status,
        transport: "unknown",
      });
    }
    throw error;
  }
  return recordAndReturn({
    recordPath,
    provider,
    model,
    baseUrl: sidecar.endpoint,
    outcome: "unsupported",
    reasonCode: result.reasonCode,
    status: result.status,
    transport: CODEX_BRIDGE_TRANSPORT,
    bridge: CODEX_BRIDGE,
    sidecar,
  });
}
