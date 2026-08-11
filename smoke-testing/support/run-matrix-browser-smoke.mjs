#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseGeneratedEnvironment,
  renderProbePage,
  validateBrowserReport,
} from "./matrix-browser-contract.mjs";

const MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_ENVIRONMENT_FILE = ".runtime/agentteams/manager.env";
const USERNAME_PREFIX = "p0-browser-";
const MEDIA_URI = /^mxc:\/\/([^/\s]{1,255})\/([^/\s]{1,255})$/u;
const SAFE_USER_LOCALPART = /^[a-z0-9][a-z0-9_-]{1,62}$/u;

class ProbeError extends Error {
  constructor(code, status = 500) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
    this.status = status;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodePath(value) {
  return encodeURIComponent(value);
}

function requireValue(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) throw new ProbeError(`missing_${key.toLowerCase()}`, 500);
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProbeError("invalid_matrix_gateway_port", 500);
  return port;
}

function parseListenPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ProbeError("invalid_probe_port", 2);
  return port;
}

function environmentFilePath() {
  return process.env.TIANGONG_AGENTTEAMS_ENV ?? DEFAULT_ENVIRONMENT_FILE;
}

async function readEnvironment() {
  let text;
  try {
    text = await readFile(environmentFilePath(), "utf8");
  } catch {
    throw new ProbeError("agentteams_environment_unavailable", 500);
  }
  try {
    return parseGeneratedEnvironment(text);
  } catch {
    throw new ProbeError("agentteams_environment_invalid", 500);
  }
}

function createConfiguration(environment) {
  const domain = requireValue(environment, "AGENTTEAMS_MATRIX_DOMAIN");
  if (/[\s/\\]/u.test(domain) || domain.length > 255) throw new ProbeError("invalid_matrix_domain", 500);
  const matrixOrigin = process.env.TIANGONG_MATRIX_BROWSER_MATRIX_ORIGIN ??
    `http://127.0.0.1:${parsePort(requireValue(environment, "AGENTTEAMS_PORT_GATEWAY"))}`;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(matrixOrigin);
  } catch {
    throw new ProbeError("invalid_matrix_origin", 500);
  }
  if (!/^https?:$/u.test(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password ||
      parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
    throw new ProbeError("invalid_matrix_origin", 500);
  }
  const origin = parsedOrigin.origin;
  return {
    domain,
    matrixOrigin: origin,
    adminUser: requireValue(environment, "AGENTTEAMS_ADMIN_USER"),
    adminPassword: requireValue(environment, "AGENTTEAMS_ADMIN_PASSWORD"),
    appserviceToken: requireValue(environment, "AGENTTEAMS_MATRIX_APPSERVICE_AS_TOKEN"),
  };
}

function matrixUserId(localpart, domain) {
  return `@${localpart}:${domain}`;
}

function roomPath(roomId, suffix = "") {
  return `/_matrix/client/v3/rooms/${encodePath(roomId)}${suffix}`;
}

function parseMediaUri(value, domain) {
  if (typeof value !== "string") return null;
  const match = MEDIA_URI.exec(value);
  if (!match || match[1] !== domain) return null;
  return Object.freeze({ uri: value, server: match[1], mediaId: match[2] });
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new ProbeError("request_body_too_large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonRequest(request) {
  const body = await readRequestBody(request);
  try {
    return JSON.parse(body);
  } catch {
    throw new ProbeError("request_json_invalid", 400);
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function isRoomAbsent(response) {
  return [403, 404].includes(response.status) ||
    (response.status === 500 && response.json?.errcode === "M_UNKNOWN" && /M_NOT_FOUND|missing state/iu.test(String(response.json?.error ?? "")));
}

function publicCleanupFacts(facts) {
  return {
    passwordEventRedacted: facts.passwordEventRedacted === true,
    mediaDeleted: facts.mediaDeleted === true,
    mediaAbsent: facts.mediaAbsent === true,
    roomsAbsent: facts.roomsAbsent === true,
    userDeactivated: facts.userDeactivated === true,
    userLoginDenied: facts.userLoginDenied === true,
    adminSessionClosed: facts.adminSessionClosed === true,
    errors: [...facts.errors],
  };
}

class ProbeController {
  constructor(configuration) {
    this.adminPassword = configuration.adminPassword;
    this.appserviceToken = configuration.appserviceToken;
    delete configuration.adminPassword;
    delete configuration.appserviceToken;
    this.configuration = Object.freeze(configuration);
    this.runId = randomUUID();
    const localpart = USERNAME_PREFIX + this.runId.replaceAll("-", "").slice(0, 16);
    if (!SAFE_USER_LOCALPART.test(localpart)) throw new ProbeError("generated_username_invalid", 500);
    this.localpart = localpart;
    this.userId = matrixUserId(localpart, configuration.domain);
    this.password = randomBytes(32).toString("base64url");
    this.roomId = null;
    this.encryptedRoomId = null;
    this.adminRoomId = null;
    this.adminToken = null;
    this.appserviceUserToken = null;
    this.resetEventId = null;
    this.media = null;
    this.createdUser = false;
    this.createdRooms = [];
    this.bootstrapDelivered = false;
    this.phase = "idle";
    this.result = null;
    this.cleanupFacts = {
      passwordEventRedacted: false,
      mediaDeleted: false,
      mediaAbsent: false,
      roomsAbsent: false,
      userDeactivated: false,
      userLoginDenied: false,
      adminSessionClosed: false,
      errors: [],
    };
    this.preparePromise = null;
    this.cleanupPromise = null;
  }

  get expected() {
    return {
      runId: this.runId,
      userId: this.userId,
      roomId: this.roomId,
      encryptedRoomId: this.encryptedRoomId,
    };
  }

  async matrix(path, { method = "GET", token = null, body = undefined, headers = {}, acceptedStatuses = null, discardBody = false } = {}) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("accept", "application/json");
    if (token) requestHeaders.set("authorization", `Bearer ${token}`);
    if (body !== undefined && !requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
    let response;
    try {
      response = await fetch(this.configuration.matrixOrigin + path, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
        redirect: "follow",
      });
    } catch {
      throw new ProbeError("matrix_transport_failed", 502);
    }
    if (discardBody) {
      try { await response.body?.cancel(); } catch {}
      return { status: response.status, json: null };
    }
    let text = "";
    try {
      text = await response.text();
    } catch {
      throw new ProbeError("matrix_response_read_failed", 502);
    }
    if (text.length > MAX_REQUEST_BYTES) throw new ProbeError("matrix_response_too_large", 502);
    let json = null;
    if (text.length > 0) {
      try { json = JSON.parse(text); } catch { throw new ProbeError("matrix_response_json_invalid", 502); }
    }
    if (acceptedStatuses && !acceptedStatuses.includes(response.status)) {
      throw new ProbeError(`matrix_http_${response.status}`, 502);
    }
    return { status: response.status, json };
  }

  async loginAdmin() {
    const response = await this.matrix("/_matrix/client/v3/login", {
      method: "POST",
      body: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: this.configuration.adminUser },
        password: this.adminPassword,
      },
      acceptedStatuses: [200],
    });
    if (!isRecord(response.json) || typeof response.json.access_token !== "string" || response.json.access_token.length === 0) {
      throw new ProbeError("admin_login_response_invalid", 502);
    }
    this.adminToken = response.json.access_token;
  }

  async resolveAdminRoom() {
    const response = await this.matrix(`/_matrix/client/v3/directory/room/${encodePath(`#admins:${this.configuration.domain}`)}`, {
      token: this.adminToken,
      acceptedStatuses: [200],
    });
    if (typeof response.json?.room_id !== "string") throw new ProbeError("admin_room_unresolved", 502);
    this.adminRoomId = response.json.room_id;
  }

  async adminCommand(command) {
    if (!this.adminToken || !this.adminRoomId) throw new ProbeError("admin_session_unavailable", 502);
    const response = await this.matrix(roomPath(this.adminRoomId, `/send/m.room.message/probe-${randomUUID()}`), {
      method: "PUT",
      token: this.adminToken,
      body: { msgtype: "m.text", body: command },
      acceptedStatuses: [200, 201],
    });
    if (typeof response.json?.event_id !== "string") throw new ProbeError("admin_command_response_invalid", 502);
    return response.json.event_id;
  }

  async createUser() {
    const response = await this.matrix("/_matrix/client/v3/register", {
      method: "POST",
      token: this.appserviceToken,
      body: { type: "m.login.application_service", username: this.localpart },
      acceptedStatuses: [200, 201],
    });
    if (response.json?.user_id !== this.userId || typeof response.json.access_token !== "string") {
      throw new ProbeError("disposable_user_response_invalid", 502);
    }
    this.createdUser = true;
    this.appserviceUserToken = response.json.access_token;
  }

  async createRooms() {
    const plain = await this.matrix("/_matrix/client/v3/createRoom", {
      method: "POST",
      token: this.adminToken,
      body: {
        preset: "private_chat",
        visibility: "private",
        name: `P0 Matrix Browser ${this.runId.slice(0, 8)}`,
        invite: [this.userId],
      },
      acceptedStatuses: [200, 201],
    });
    if (typeof plain.json?.room_id !== "string") throw new ProbeError("plain_room_response_invalid", 502);
    this.roomId = plain.json.room_id;
    this.createdRooms.push(this.roomId);

    const encrypted = await this.matrix("/_matrix/client/v3/createRoom", {
      method: "POST",
      token: this.adminToken,
      body: {
        preset: "private_chat",
        visibility: "private",
        name: `P0 Matrix Browser encrypted ${this.runId.slice(0, 8)}`,
        invite: [this.userId],
        initial_state: [{
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        }],
      },
      acceptedStatuses: [200, 201],
    });
    if (typeof encrypted.json?.room_id !== "string") throw new ProbeError("encrypted_room_response_invalid", 502);
    this.encryptedRoomId = encrypted.json.room_id;
    this.createdRooms.push(this.encryptedRoomId);
  }

  async waitForPasswordLogin() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = await this.matrix("/_matrix/client/v3/login", {
        method: "POST",
        body: {
          type: "m.login.password",
          identifier: { type: "m.id.user", user: this.localpart },
          password: this.password,
        },
        acceptedStatuses: null,
      });
      if (response.status === 200 && typeof response.json?.access_token === "string") {
        const token = response.json.access_token;
        await this.matrix("/_matrix/client/v3/logout", { method: "POST", token, acceptedStatuses: [200, 401, 403] });
        return;
      }
      await sleep(500);
    }
    throw new ProbeError("disposable_password_not_ready", 504);
  }

  async prepare() {
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = (async () => {
      this.phase = "preparing";
      await this.loginAdmin();
      await this.resolveAdminRoom();
      await this.createUser();
      this.resetEventId = await this.adminCommand(`!admin users reset-password ${this.userId} ${this.password}`);
      await this.createRooms();
      await this.waitForPasswordLogin();
      if (this.appserviceUserToken) {
        await this.matrix("/_matrix/client/v3/logout", { method: "POST", token: this.appserviceUserToken, acceptedStatuses: [200, 401, 403] });
        this.appserviceUserToken = null;
      }
      this.appserviceToken = null;
      this.phase = "ready";
    })().catch(async (error) => {
      this.phase = "preparation-failed";
      await this.cleanup();
      throw error instanceof ProbeError ? error : new ProbeError("probe_preparation_failed", 500);
    });
    return this.preparePromise;
  }

  registerOwnedMedia(value) {
    const media = parseMediaUri(value, this.configuration.domain);
    if (!media || !this.createdUser) throw new ProbeError("owned_media_reference_invalid", 400);
    if (this.media && this.media.uri !== media.uri) throw new ProbeError("multiple_owned_media_references", 409);
    this.media = media;
  }

  async redactResetEvent() {
    if (!this.resetEventId) return true;
    if (!this.adminToken || !this.adminRoomId) return false;
    try {
      await this.matrix(roomPath(this.adminRoomId, `/redact/${encodePath(this.resetEventId)}/cleanup-${randomUUID()}`), {
        method: "PUT",
        token: this.adminToken,
        body: { reason: "P0 disposable credential cleanup" },
        acceptedStatuses: [200, 201],
      });
      const event = await this.matrix(roomPath(this.adminRoomId, `/event/${encodePath(this.resetEventId)}`), {
        token: this.adminToken,
        acceptedStatuses: [200],
      });
      return typeof event.json?.content?.body !== "string";
    } catch {
      return false;
    }
  }

  async deleteOwnedMedia() {
    if (!this.media) return true;
    if (!this.adminToken) return false;
    try {
      await this.adminCommand(`!admin media delete --mxc ${this.media.uri}`);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const response = await this.matrix(`/_matrix/media/v3/download/${encodePath(this.media.server)}/${encodePath(this.media.mediaId)}`, {
          token: this.adminToken,
          acceptedStatuses: null,
          discardBody: true,
        });
        if ([404, 410].includes(response.status)) return true;
        await sleep(500);
      }
    } catch {}
    return false;
  }

  async deleteOwnedRooms() {
    if (this.createdRooms.length === 0) return true;
    if (!this.adminToken) return false;
    let sent = true;
    for (const roomId of this.createdRooms) {
      try {
        await this.adminCommand(`!admin rooms delete-room ${roomId}`);
      } catch {
        sent = false;
      }
    }
    if (!sent) return false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      let absent = true;
      for (const roomId of this.createdRooms) {
        const response = await this.matrix(roomPath(roomId, "/state"), {
          token: this.adminToken,
          acceptedStatuses: null,
        }).catch(() => ({ status: 599 }));
        if (!isRoomAbsent(response)) {
          absent = false;
          break;
        }
      }
      if (absent) return true;
      await sleep(500);
    }
    return false;
  }

  async deactivateOwnedUser() {
    if (!this.createdUser) return true;
    if (!this.adminToken) return false;
    try {
      await this.adminCommand(`!admin users deactivate ${this.userId}`);
    } catch {
      return false;
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const response = await this.matrix("/_matrix/client/v3/login", {
        method: "POST",
        body: {
          type: "m.login.password",
          identifier: { type: "m.id.user", user: this.localpart },
          password: this.password,
        },
        acceptedStatuses: null,
      });
      if ([401, 403].includes(response.status)) return true;
      if (response.status === 200 && typeof response.json?.access_token === "string") {
        await this.matrix("/_matrix/client/v3/logout", { method: "POST", token: response.json.access_token, acceptedStatuses: [200, 401, 403] }).catch(() => {});
      }
      await sleep(500);
    }
    return false;
  }

  async cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      this.phase = "cleaning-up";
      const errors = this.cleanupFacts.errors;
      try {
        if (!this.adminToken && this.createdUser) {
          try {
            await this.loginAdmin();
            await this.resolveAdminRoom();
          } catch {
            errors.push("admin_relogin_failed");
          }
        }
        this.cleanupFacts.passwordEventRedacted = await this.redactResetEvent();
        if (!this.cleanupFacts.passwordEventRedacted && this.resetEventId) errors.push("password_event_redaction_failed");
        this.cleanupFacts.mediaDeleted = await this.deleteOwnedMedia();
        this.cleanupFacts.mediaAbsent = !this.media || this.cleanupFacts.mediaDeleted;
        if (this.media && !this.cleanupFacts.mediaDeleted) errors.push("media_cleanup_failed");
        this.cleanupFacts.roomsAbsent = await this.deleteOwnedRooms();
        if (!this.cleanupFacts.roomsAbsent && this.createdRooms.length > 0) errors.push("room_cleanup_failed");
        this.cleanupFacts.userLoginDenied = await this.deactivateOwnedUser();
        this.cleanupFacts.userDeactivated = this.cleanupFacts.userLoginDenied;
        if (!this.cleanupFacts.userLoginDenied && this.createdUser) errors.push("user_deactivation_failed");
      } finally {
        if (this.appserviceUserToken) {
          await this.matrix("/_matrix/client/v3/logout", { method: "POST", token: this.appserviceUserToken, acceptedStatuses: [200, 401, 403] }).catch(() => {});
          this.appserviceUserToken = null;
        }
        if (this.adminToken) {
          try {
            await this.matrix("/_matrix/client/v3/logout", { method: "POST", token: this.adminToken, acceptedStatuses: [200, 401, 403] });
            this.cleanupFacts.adminSessionClosed = true;
          } catch {
            errors.push("admin_logout_failed");
          }
        }
        this.adminToken = null;
        this.adminPassword = null;
        this.appserviceToken = null;
        this.password = "revoked";
        this.phase = errors.length === 0 ? "cleanup-passed" : "cleanup-failed";
      }
      return publicCleanupFacts(this.cleanupFacts);
    })();
    return this.cleanupPromise;
  }

  status() {
    return {
      status: this.phase === "cleanup-passed" && this.result?.status === "pass" ? "pass" : this.phase === "cleanup-failed" ? "fail" : "running",
      phase: this.phase,
      runId: this.runId,
      bootstrapDelivered: this.bootstrapDelivered,
      result: this.result,
      cleanup: publicCleanupFacts(this.cleanupFacts),
    };
  }

  async handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ready", phase: this.phase, runId: this.runId });
        return;
      }
      if (request.method === "GET" && url.pathname === "/status") {
        sendJson(response, 200, this.status());
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        sendText(response, 200, renderProbePage({ matrixOrigin: this.configuration.matrixOrigin, runId: this.runId }), "text/html; charset=utf-8", {
          "content-security-policy": "frame-ancestors 'none'",
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/bootstrap") {
        if (this.bootstrapDelivered) throw new ProbeError("bootstrap_already_consumed", 409);
        await this.prepare();
        this.bootstrapDelivered = true;
        sendJson(response, 200, {
          runId: this.runId,
          matrixOrigin: this.configuration.matrixOrigin,
          userId: this.userId,
          roomId: this.roomId,
          encryptedRoomId: this.encryptedRoomId,
          password: this.password,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/owned-media") {
        const body = await readJsonRequest(request);
        this.registerOwnedMedia(body?.mediaUri);
        sendJson(response, 200, { status: "accepted" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/result") {
        const body = await readJsonRequest(request);
        let contract = null;
        let contractPassed = false;
        try {
          const validated = validateBrowserReport(body, this.expected);
          this.registerOwnedMedia(body.mediaUri);
          contract = validated;
          contractPassed = true;
        } catch {
          if (body?.mediaUri) {
            try { this.registerOwnedMedia(body.mediaUri); } catch {}
          }
        }
        const cleanup = await this.cleanup();
        this.result = {
          status: contractPassed && cleanup.errors.length === 0 ? "pass" : "fail",
          contract,
          cleanup,
        };
        if (this.result.status === "pass") {
          sendJson(response, 200, this.result);
        } else if (!contractPassed) {
          const browserFailureCode = typeof body?.browserErrorCode === "string" && /^[a-z][a-z0-9_]{1,63}$/u.test(body.browserErrorCode)
            ? body.browserErrorCode
            : "browser_contract_failed";
          const browserDiagnostic = isRecord(body?.browserDiagnostic) &&
            typeof body.browserDiagnostic.relationReferencePresent === "boolean" &&
            typeof body.browserDiagnostic.relationReferenceMatches === "boolean"
            ? {
              relationReferencePresent: body.browserDiagnostic.relationReferencePresent,
              relationReferenceMatches: body.browserDiagnostic.relationReferenceMatches,
            }
            : null;
          sendJson(response, 422, { status: "fail", errorCode: "browser_contract_failed", browserFailureCode, browserDiagnostic, cleanup });
        } else {
          sendJson(response, 500, { status: "fail", errorCode: "cleanup_failed", cleanup });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/cleanup") {
        throw new ProbeError("cleanup_requires_process_signal", 405);
      }
      sendJson(response, 404, { status: "fail", errorCode: "not_found" });
    } catch (error) {
      const probeError = error instanceof ProbeError ? error : new ProbeError("probe_request_failed", 500);
      sendJson(response, probeError.status, { status: "fail", errorCode: probeError.code });
    }
  }
}

function parseArguments(argumentsList) {
  if (argumentsList[0] !== "serve") throw new ProbeError("usage_serve_required", 2);
  let port = 0;
  for (let index = 1; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--port") {
      port = parseListenPort(argumentsList[index + 1]);
      index += 1;
    } else {
      throw new ProbeError("usage_argument_invalid", 2);
    }
  }
  return { port };
}

async function main() {
  const argumentsValue = parseArguments(process.argv.slice(2));
  let environment = await readEnvironment();
  const configuration = createConfiguration(environment);
  environment = null;
  const controller = new ProbeController(configuration);
  const server = createServer((request, response) => controller.handle(request, response));
  let closing = false;
  const close = async (exitCode) => {
    if (closing) return;
    closing = true;
    await controller.cleanup();
    await new Promise((resolve) => server.close(() => resolve()));
    process.exitCode = exitCode;
  };
  process.once("SIGTERM", () => { void close(0); });
  process.once("SIGINT", () => { void close(130); });
  server.on("error", () => { process.exitCode = 1; });
  server.listen(argumentsValue.port, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, runId: controller.runId }) + "\n");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof ProbeError ? error.code : "probe_start_failed"}\n`);
    process.exitCode = error instanceof ProbeError ? error.status === 2 ? 2 : 1 : 1;
  });
}

export { ProbeController, createConfiguration };
