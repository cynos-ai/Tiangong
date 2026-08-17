import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGeneratedEnvironment,
  renderProbePage,
  validateBrowserReport,
} from "./matrix-browser-contract.mjs";
import { ProbeController } from "./run-matrix-browser-smoke.mjs";

const expected = Object.freeze({
  runId: "11111111-2222-4333-8444-555555555555",
  userId: "@p0-browser-111111112222:matrix.test",
  roomId: "!plain:matrix.test",
  encryptedRoomId: "!encrypted:matrix.test",
});

function passingReport(overrides = {}) {
  return {
    runId: expected.runId,
    userId: expected.userId,
    roomId: expected.roomId,
    encryptedRoomId: expected.encryptedRoomId,
    firstEventId: "$first",
    replayEventId: "$first",
    relationEventId: "$relation",
    mediaUri: "mxc://matrix.test/media",
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
    storageEmpty: true,
    consoleErrors: 0,
    networkErrors: 0,
    ...overrides,
  };
}

test("accepts only the complete browser contract", () => {
  const value = validateBrowserReport(passingReport(), expected);
  assert.equal(value.status, "pass");
  assert.equal(value.firstEventId, "$first");
  assert.equal(value.checks.sessionRevoked, true);
  assert.equal(Object.hasOwn(value, "accessToken"), false);
});

test("rejects replay, identity, relation, security, and browser-error shortcuts", () => {
  const cases = [
    { replayEventId: "$second" },
    { firstEventCount: 2 },
    { userId: "@other:matrix.test" },
    { relation: false },
    { namespacedReference: false },
    { senderPreserved: false },
    { encryptedRoomBlocked: false },
    { logout: false },
    { sessionRevoked: false },
    { storageEmpty: false },
    { consoleErrors: 1 },
    { networkErrors: 1 },
    { accessToken: "secret" },
  ];
  for (const patch of cases) {
    assert.throws(() => validateBrowserReport(passingReport(patch), expected));
  }
});

test("parses the fixed generated environment without executing shell text", () => {
  const parsed = parseGeneratedEnvironment(`
AGENTTEAMS_ADMIN_USER=admin
AGENTTEAMS_ADMIN_PASSWORD='password value'
AGENTTEAMS_MATRIX_DOMAIN=matrix.test
AGENTTEAMS_MATRIX_APPSERVICE_AS_TOKEN=as-token
AGENTTEAMS_PORT_GATEWAY=18080
`);
  assert.equal(parsed.AGENTTEAMS_ADMIN_PASSWORD, "password value");
  assert.equal(parsed.AGENTTEAMS_PORT_GATEWAY, "18080");
  assert.throws(() => parseGeneratedEnvironment("AGENTTEAMS_ADMIN_USER=one\nAGENTTEAMS_ADMIN_USER=two\n"));
  assert.throws(() => parseGeneratedEnvironment("AGENTTEAMS_ADMIN_USER=$(touch /tmp/no)\n"));
});

test("server status does not retain generated credentials in its public state", () => {
  const configuration = {
    domain: "matrix.test",
    matrixOrigin: "http://127.0.0.1:18080",
    adminUser: "admin",
    adminPassword: "fixture-admin-password",
    appserviceToken: "fixture-appservice-token",
  };
  const controller = new ProbeController(configuration);
  const status = JSON.stringify(controller.status());
  assert.equal(Object.hasOwn(configuration, "adminPassword"), false);
  assert.equal(Object.hasOwn(configuration, "appserviceToken"), false);
  assert.doesNotMatch(status, /fixture-admin-password|fixture-appservice-token/gu);
});

test("renders a credential-free page with a restrictive browser policy", () => {
  const html = renderProbePage({
    matrixOrigin: "http://127.0.0.1:18080",
    runId: expected.runId,
  });
  assert.match(html, /default-src 'none'/u);
  assert.match(html, /connect-src 'self' http:\/\/127\.0\.0\.1:18080/u);
  assert.match(html, /\/bootstrap/u);
  assert.match(html, /\/result/u);
  assert.doesNotMatch(html, /password value|as-token|token-secret/iu);
});
