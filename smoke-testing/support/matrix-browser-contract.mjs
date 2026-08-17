import { strict as assert } from "node:assert";

const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/u;
const SECRET_KEY = /(access[_-]?token|api[_-]?key|authorization|credential|password|secret|session[_-]?token)/iu;
const EVENT_ID = /^\$[^\s\u0000-\u001f]{1,255}$/u;
const MATRIX_ID = /^@[^\s\u0000-\u001f]{1,255}$/u;
const ROOM_ID = /^![^\s\u0000-\u001f]{1,255}$/u;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const BROWSER_REPORT_KEYS = new Set([
  "runId",
  "userId",
  "roomId",
  "encryptedRoomId",
  "firstEventId",
  "replayEventId",
  "relationEventId",
  "mediaUri",
  "browserErrorCode",
  "mediaApi",
  "login",
  "whoami",
  "joinedRooms",
  "sync",
  "history",
  "txnReplay",
  "firstEventCount",
  "relation",
  "namespacedReference",
  "senderPreserved",
  "mediaUpload",
  "mediaDownload",
  "encryptedRoomBlocked",
  "logout",
  "sessionRevoked",
  "storageEmpty",
  "consoleErrors",
  "networkErrors",
]);

const REQUIRED_TRUE_FIELDS = [
  "login",
  "whoami",
  "joinedRooms",
  "sync",
  "history",
  "txnReplay",
  "relation",
  "namespacedReference",
  "senderPreserved",
  "mediaUpload",
  "mediaDownload",
  "encryptedRoomBlocked",
  "logout",
  "sessionRevoked",
  "storageEmpty",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new TypeError(message);
}

function assertString(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    fail(`${label} must be a bounded non-empty string`);
  }
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  return value;
}

function unquoteEnvironmentValue(value, lineNumber) {
  if (value.length === 0) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first !== "'" && first !== '"') {
    if (/[`]|\$\(/u.test(value)) fail(`unsafe environment syntax on line ${lineNumber}`);
    return value;
  }
  if (last !== first || value.length < 2) fail(`unterminated environment quote on line ${lineNumber}`);
  const inner = value.slice(1, -1);
  if (first === "'") {
    if (inner.includes("'")) fail(`invalid single-quoted environment value on line ${lineNumber}`);
    return inner;
  }
  if (/[`]|\$\(/u.test(inner)) fail(`unsafe environment syntax on line ${lineNumber}`);
  return inner.replace(/\\([\\"nrt])/gu, (_, character) => ({
    "\\": "\\",
    '"': '"',
    n: "\n",
    r: "\r",
    t: "\t",
  })[character]);
}

/**
 * Parse the one-assignment-per-line generated AgentTeams environment format.
 * This deliberately does not implement shell evaluation or expansion.
 */
export function parseGeneratedEnvironment(text) {
  if (typeof text !== "string" || text.length > 1024 * 1024) {
    fail("generated environment must be bounded text");
  }
  const result = Object.create(null);
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !ENVIRONMENT_KEY.test(match[1])) {
      fail(`invalid generated environment assignment on line ${lineNumber}`);
    }
    const [, key, rawValue] = match;
    if (Object.hasOwn(result, key)) fail(`duplicate generated environment key: ${key}`);
    result[key] = unquoteEnvironmentValue(rawValue, lineNumber);
  }
  return result;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function assertHttpOrigin(value, label) {
  const parsed = new URL(value);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail(`${label} must be an origin URL`);
  }
  return parsed.origin;
}

/**
 * Render the disposable browser page. No credential is interpolated here;
 * the page receives the short-lived password only from the one-use bootstrap
 * response and keeps it in a local variable until the Matrix login request.
 */
export function renderProbePage({ matrixOrigin, runId }) {
  const origin = assertHttpOrigin(matrixOrigin, "matrixOrigin");
  assertString(runId, "runId", RUN_ID);
  const pageRunId = JSON.stringify(runId);
  const pageMatrixOrigin = JSON.stringify(origin);
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self' " + origin,
    "form-action 'none'",
    "img-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
  ].join("; ");

  const script = String.raw`(() => {
  "use strict";
  const RUN_ID = ${pageRunId};
  const MATRIX_ORIGIN = ${pageMatrixOrigin};
  const output = document.getElementById("output");
  const errors = { console: 0, network: 0 };
  let finished = false;
  let browserStep = "bootstrap";
  let relationReferencePresent = false;
  let relationReferenceMatches = false;
  let uploadedMediaUri = null;

  window.addEventListener("error", () => { errors.console += 1; });
  window.addEventListener("unhandledrejection", () => { errors.console += 1; });

  function show(value, kind = "running") {
    output.dataset.status = kind;
    output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  function boundedString(value, label) {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
      throw new Error(label + "_invalid");
    }
    return value;
  }

  async function request(url, options = {}, expectedStatuses = [200]) {
    let response;
    try {
      response = await fetch(url, { redirect: "follow", ...options });
    } catch {
      errors.network += 1;
      throw new Error("network_request_failed");
    }
    if (!expectedStatuses.includes(response.status)) {
      throw new Error("unexpected_http_status");
    }
    return response;
  }

  async function jsonRequest(path, token, options = {}, expectedStatuses = [200]) {
    const headers = new Headers(options.headers || {});
    headers.set("accept", "application/json");
    if (token) headers.set("authorization", "Bearer " + token);
    const response = await request(MATRIX_ORIGIN + path, { ...options, headers }, expectedStatuses);
    try {
      return { response, json: await response.json() };
    } catch {
      throw new Error("invalid_json_response");
    }
  }

  async function eventually(read, predicate, attempts = 24) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("eventual_consistency_timeout");
  }

  function roomPath(roomId, suffix) {
    return "/_matrix/client/v3/rooms/" + encodeURIComponent(roomId) + suffix;
  }

  function eventBody(event) {
    return event && event.type === "m.room.message" && event.content && typeof event.content.body === "string"
      ? event.content.body
      : null;
  }

  async function run() {
    show("Preparing disposable Matrix browser contract…");
    const bootstrapResponse = await request("/bootstrap", { headers: { accept: "application/json" } });
    const bootstrap = await bootstrapResponse.json();
    if (bootstrap.runId !== RUN_ID || bootstrap.matrixOrigin !== MATRIX_ORIGIN) throw new Error("bootstrap_binding_failed");
    const userId = boundedString(bootstrap.userId, "user_id");
    const roomId = boundedString(bootstrap.roomId, "room_id");
    const encryptedRoomId = boundedString(bootstrap.encryptedRoomId, "encrypted_room_id");
    let password = boundedString(bootstrap.password, "bootstrap_password");
    delete bootstrap.password;
    let token = null;
    let firstEventId = null;
    let relationEventId = null;
    try {
        browserStep = "login";
      const login = await jsonRequest("/_matrix/client/v3/login", null, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password }),
      });
      token = boundedString(login.json.access_token, "access_token");
      password = null;
      browserStep = "whoami";
      const whoami = await jsonRequest("/_matrix/client/v3/account/whoami", token);
      if (whoami.json.user_id !== userId) throw new Error("whoami_identity_mismatch");

      browserStep = "join";
      for (const targetRoomId of [roomId, encryptedRoomId]) {
        await jsonRequest("/_matrix/client/v3/join/" + encodeURIComponent(targetRoomId), token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }, [200, 201]);
      }
      browserStep = "joined-rooms";
      const joinedRooms = await jsonRequest("/_matrix/client/v3/joined_rooms", token);
      const joined = Array.isArray(joinedRooms.json.joined_rooms) ? joinedRooms.json.joined_rooms : [];
      if (!joined.includes(roomId) || !joined.includes(encryptedRoomId)) throw new Error("joined_room_identity_mismatch");

      browserStep = "sync";
      await jsonRequest("/_matrix/client/v3/sync?timeout=0&full_state=true", token);
      browserStep = "transaction";
      const firstBody = "P0_MATRIX_BROWSER_HUMAN " + RUN_ID;
      const txnId = "p0-browser-" + RUN_ID.replaceAll("-", "");
      const sendFirst = await jsonRequest(roomPath(roomId, "/send/m.room.message/" + encodeURIComponent(txnId)), token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "m.text", body: firstBody }),
      });
      firstEventId = boundedString(sendFirst.json.event_id, "first_event_id");
      const replay = await jsonRequest(roomPath(roomId, "/send/m.room.message/" + encodeURIComponent(txnId)), token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "m.text", body: firstBody }),
      });
      const replayEventId = boundedString(replay.json.event_id, "replay_event_id");
      if (replayEventId !== firstEventId) throw new Error("transaction_replay_event_mismatch");

      const history = await eventually(
        () => jsonRequest(roomPath(roomId, "/messages?dir=b&limit=100"), token),
        ({ json }) => Array.isArray(json.chunk) && json.chunk.some((event) => event.event_id === firstEventId),
      );
      const firstEvents = history.json.chunk.filter((event) => event.event_id === firstEventId && eventBody(event) === firstBody);
      if (firstEvents.length !== 1) throw new Error("transaction_replay_count_mismatch");

      browserStep = "relation";
      const reference = Object.freeze({ run_id: RUN_ID, source_event_id: firstEventId, purpose: "p0-browser-contract" });
      const relation = await jsonRequest(roomPath(roomId, "/send/m.room.message/relation-" + RUN_ID.replaceAll("-", "")), token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msgtype: "m.text",
          body: "P0_MATRIX_BROWSER_REPLY " + RUN_ID,
          "m.relates_to": { "m.in_reply_to": { event_id: firstEventId } },
          "com.tiangong.p0.reference": reference,
        }),
      });
      relationEventId = boundedString(relation.json.event_id, "relation_event_id");
      const relationHistory = await eventually(
        () => jsonRequest(roomPath(roomId, "/messages?dir=b&limit=100"), token),
        ({ json }) => Array.isArray(json.chunk) && json.chunk.some((event) => event.event_id === relationEventId),
      );
      const relationEvent = relationHistory.json.chunk.find((event) => event.event_id === relationEventId);
      const relatesTo = relationEvent?.content?.["m.relates_to"]?.["m.in_reply_to"];
      if (relatesTo?.event_id !== firstEventId) throw new Error("reply_relation_not_preserved");
      const observedReference = relationEvent?.content?.["com.tiangong.p0.reference"];
      relationReferencePresent = observedReference !== undefined;
      relationReferenceMatches = observedReference !== null && typeof observedReference === "object" && !Array.isArray(observedReference) &&
        JSON.stringify(Object.keys(observedReference).sort()) === JSON.stringify(["purpose", "run_id", "source_event_id"]) &&
        observedReference.run_id === reference.run_id &&
        observedReference.source_event_id === reference.source_event_id &&
        observedReference.purpose === reference.purpose;
      if (!relationReferenceMatches) {
        throw new Error("namespaced_reference_not_preserved");
      }
      const probeEvents = relationHistory.json.chunk.filter((event) => {
        const body = eventBody(event);
        return body === firstBody || body === "P0_MATRIX_BROWSER_REPLY " + RUN_ID;
      });
      if (probeEvents.length !== 2 || probeEvents.some((event) => event.sender !== userId)) throw new Error("human_sender_not_preserved");

      browserStep = "media-upload";
      const mediaBytes = new TextEncoder().encode("P0_MATRIX_BROWSER_MEDIA " + RUN_ID);
      const upload = await request(
        MATRIX_ORIGIN + "/_matrix/media/v3/upload?filename=" + encodeURIComponent("p0-browser-media.txt"),
        {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "text/plain" },
          body: mediaBytes,
        },
      );
      let uploadJson;
      try { uploadJson = await upload.json(); } catch { throw new Error("media_upload_response_invalid"); }
      const mediaUri = boundedString(uploadJson.content_uri, "media_uri");
      if (!mediaUri.startsWith("mxc://") || mediaUri.slice(6).split("/").length !== 2) throw new Error("media_uri_invalid");
      uploadedMediaUri = mediaUri;
      await request("/owned-media", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ mediaUri }),
      });
      const [mediaServer, mediaId] = mediaUri.slice(6).split("/");
      const download = await request(
        MATRIX_ORIGIN + "/_matrix/media/v3/download/" + encodeURIComponent(mediaServer) + "/" + encodeURIComponent(mediaId),
        { headers: { authorization: "Bearer " + token } },
      );
      const downloaded = new Uint8Array(await download.arrayBuffer());
      if (downloaded.length !== mediaBytes.length || downloaded.some((value, index) => value !== mediaBytes[index])) {
        throw new Error("media_roundtrip_mismatch");
      }

      browserStep = "encrypted-room";
      const encryptionState = await jsonRequest(roomPath(encryptedRoomId, "/state/m.room.encryption/"), token);
      if (encryptionState.json.algorithm !== "m.megolm.v1.aes-sha2") throw new Error("encrypted_room_algorithm_unexpected");

      browserStep = "logout";
      const logout = await jsonRequest("/_matrix/client/v3/logout", token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!logout.response.ok) throw new Error("logout_failed");
      const revoked = await jsonRequest("/_matrix/client/v3/account/whoami", token, {}, [401, 403]);
      if (revoked.response.ok) throw new Error("session_not_revoked");
      token = null;

      const report = {
        runId: RUN_ID,
        userId,
        roomId,
        encryptedRoomId,
        firstEventId,
        replayEventId,
        relationEventId,
        mediaUri,
        mediaApi: "media-v3",
        login: true,
        whoami: true,
        joinedRooms: true,
        sync: true,
        history: true,
        txnReplay: true,
        firstEventCount: 1,
        relation: true,
        namespacedReference: true,
        senderPreserved: true,
        mediaUpload: true,
        mediaDownload: true,
        encryptedRoomBlocked: true,
        logout: true,
        sessionRevoked: true,
        storageEmpty: window.localStorage.length === 0 && window.sessionStorage.length === 0 && document.cookie === "",
        consoleErrors: errors.console,
        networkErrors: errors.network,
      };
      const resultResponse = await fetch("/result", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(report),
      });
      const result = await resultResponse.json();
      if (!resultResponse.ok || result.status !== "pass") {
        finished = true;
        show(result, "fail");
        return;
      }
      finished = true;
      show(result, "pass");
    } finally {
      if (token) {
        try { await jsonRequest("/_matrix/client/v3/logout", token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch {}
        token = null;
      }
      password = null;
    }
  }

  run().catch(async (error) => {
    if (finished) return;
    const rawErrorCode = /^[a-z][a-z0-9_]{1,63}$/u.test(String(error?.message ?? ""))
      ? String(error.message)
      : "runtime_error";
    const browserErrorCode = (browserStep + "_" + rawErrorCode).slice(0, 63);
    const failure = {
      runId: RUN_ID,
      status: "browser-failure",
      browserErrorCode,
      browserDiagnostic: { relationReferencePresent, relationReferenceMatches },
      mediaUri: undefined,
      consoleErrors: errors.console,
      networkErrors: errors.network,
    };
    if (uploadedMediaUri) failure.mediaUri = uploadedMediaUri;
    try {
      const response = await fetch("/result", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(failure),
      });
      const result = await response.json();
      show(result, "fail");
    } catch {
      show({ status: "fail", errorCode: "result_submission_failed" }, "fail");
    }
  });
})();`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Tiangong Matrix browser contract</title>
<style>
:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #101416; color: #d9e4dc; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(880px, calc(100vw - 48px)); padding: 32px; border: 1px solid #30493a; border-radius: 18px; background: #17211c; box-shadow: 0 18px 70px #0008; }
h1 { font-size: 1.25rem; margin: 0 0 10px; color: #9de6b8; }
p { color: #a6b9ad; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 18px; border-radius: 12px; background: #0b100d; color: #d9e4dc; min-height: 120px; }
#output[data-status="pass"] { border: 1px solid #5dd389; }
#output[data-status="fail"] { border: 1px solid #e77d7d; color: #ffb2b2; }
</style>
</head>
<body><main><h1>Tiangong P0 Matrix browser contract</h1><p>Disposable identity; credentials remain in memory and are revoked after the probe.</p><pre id="output" data-status="running">Starting…</pre></main>
<script>${script}</script>
</body>
</html>`;
}

function assertNoSecretFields(value, path = "report") {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail(`${path}.${key} is not an allowed report field`);
    if (isRecord(child)) assertNoSecretFields(child, `${path}.${key}`);
    if (Array.isArray(child)) {
      for (const item of child) if (isRecord(item)) assertNoSecretFields(item, `${path}.${key}`);
    }
  }
}

/** Validate and return only the bounded browser facts used by the smoke report. */
export function validateBrowserReport(report, expected) {
  if (!isRecord(report) || !isRecord(expected)) fail("browser report and expected binding must be objects");
  assertNoSecretFields(report);
  for (const key of Object.keys(report)) {
    if (!BROWSER_REPORT_KEYS.has(key)) fail(`unexpected browser report field: ${key}`);
  }
  assertString(expected.runId, "expected.runId", RUN_ID);
  assertString(expected.userId, "expected.userId", MATRIX_ID);
  assertString(expected.roomId, "expected.roomId", ROOM_ID);
  assertString(expected.encryptedRoomId, "expected.encryptedRoomId", ROOM_ID);
  if (report.runId !== expected.runId) fail("browser run binding mismatch");
  if (report.userId !== expected.userId) fail("browser user binding mismatch");
  if (report.roomId !== expected.roomId) fail("browser room binding mismatch");
  if (report.encryptedRoomId !== expected.encryptedRoomId) fail("browser encrypted-room binding mismatch");
  assertString(report.firstEventId, "firstEventId", EVENT_ID);
  assertString(report.replayEventId, "replayEventId", EVENT_ID);
  assertString(report.relationEventId, "relationEventId", EVENT_ID);
  assertString(report.mediaUri, "mediaUri");
  if (!/^mxc:\/\/[^/\s]{1,255}\/[^/\s]{1,255}$/u.test(report.mediaUri)) fail("mediaUri has an invalid format");
  if (Object.hasOwn(report, "browserErrorCode")) fail("browser failure metadata cannot be present in a passing report");
  if (report.firstEventId !== report.replayEventId) fail("transaction replay did not preserve event identity");
  if (report.mediaApi !== "media-v3") fail("browser did not prove the supported media API");
  for (const field of REQUIRED_TRUE_FIELDS) {
    if (report[field] !== true) fail(`browser contract field ${field} did not pass`);
  }
  if (report.firstEventCount !== 1) fail("transaction replay produced more than one event");
  for (const field of ["consoleErrors", "networkErrors"]) {
    if (!Number.isInteger(report[field]) || report[field] !== 0) fail(`browser reported ${field}`);
  }
  return {
    status: "pass",
    runId: report.runId,
    userId: report.userId,
    roomId: report.roomId,
    encryptedRoomId: report.encryptedRoomId,
    firstEventId: report.firstEventId,
    replayEventId: report.replayEventId,
    relationEventId: report.relationEventId,
    mediaUri: report.mediaUri,
    mediaApi: report.mediaApi,
    checks: Object.fromEntries(REQUIRED_TRUE_FIELDS.map((field) => [field, true])),
    firstEventCount: report.firstEventCount,
    consoleErrors: report.consoleErrors,
    networkErrors: report.networkErrors,
    contract: "matrix-browser-p0",
  };
}

export { BROWSER_REPORT_KEYS };
