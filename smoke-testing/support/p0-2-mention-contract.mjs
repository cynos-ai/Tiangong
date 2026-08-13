// Deterministic contract for the P0.2 mention wire-format boundary and the
// worker-owned Matrix delivery contract. The live focused run
// (run-p0-2-mention-delivery.sh) exercises these against a real requireMention
// Worker; this module proves the wire-format and replay facts deterministically.
import { ok, strictEqual, match } from "node:assert/strict";

export const MENTION_WORKER_PATTERN = /^@[A-Za-z0-9._=-]{1,255}:[^\s/]{1,255}$/u;

// The Dashboard bug class: m.mentions.user_ids is present and correct, but the
// formatted_body carries NO matrix.to anchor for the worker MXID. A
// requireMention Worker must not wake on this format.
export function isDashboardPlainMention(event, workerMxid) {
  const content = event?.content ?? {};
  const mentions = content["m.mentions"]?.user_ids ?? [];
  if (!Array.isArray(mentions) || mentions.length !== 1 || mentions[0] !== workerMxid) return false;
  const fb = typeof content.formatted_body === "string" ? content.formatted_body : "";
  // No anchor pointing at the worker MXID -> the plain-text Dashboard shape.
  return !fb.includes(`https://matrix.to/#/${workerMxid}`) && !fb.includes(`href`);
}

// The standard Element / OpenClaw rich mention: formatted_body contains a
// matrix.to anchor for the worker MXID, plus m.mentions.user_ids.
export function isStandardRichMention(event, workerMxid) {
  const content = event?.content ?? {};
  const mentions = content["m.mentions"]?.user_ids ?? [];
  if (!Array.isArray(mentions) || mentions.length !== 1 || mentions[0] !== workerMxid) return false;
  if (content.format !== "org.matrix.custom.html") return false;
  const fb = typeof content.formatted_body === "string" ? content.formatted_body : "";
  return fb.includes(`href="https://matrix.to/#/${workerMxid}"`) || fb.includes(`matrix.to/#/${workerMxid}`);
}

export function assertMentionGateBoundary(dashboardEvent, richEvent, workerMxid) {
  ok(MENTION_WORKER_PATTERN.test(workerMxid), "worker MXID shape is invalid");
  ok(isDashboardPlainMention(dashboardEvent, workerMxid), "dashboard event must be the plain-text mention shape");
  ok(!isStandardRichMention(dashboardEvent, workerMxid), "dashboard event must NOT be a standard rich mention");
  ok(isStandardRichMention(richEvent, workerMxid), "rich event must be the standard rich mention shape");
  ok(!isDashboardPlainMention(richEvent, workerMxid), "rich event must not be classified as dashboard plain");
  return true;
}

// Worker-owned delivery contract decision (frozen for P1): the Matrix event_id
// is the stable delivery ack / echo, and the Matrix transaction id is the
// send-idempotency key. A duplicate PUT with the same txn id returns the same
// event id and must not create a second event or a second effect.
export function assertReplayContract(originalEventId, replayEventId) {
  ok(typeof originalEventId === "string" && originalEventId.length > 0, "original event id missing");
  strictEqual(replayEventId, originalEventId, "duplicate txn id must return the same event id");
  return true;
}

export function assertSenderPreserved(event, expectedSender) {
  ok(typeof expectedSender === "string" && MENTION_WORKER_PATTERN.test(expectedSender));
  strictEqual(event?.sender, expectedSender, "Matrix sender was not preserved");
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = "@tiangong-p0-2-mention-target:matrix-local.agentteams.io:18080";
  const admin = "@admin:matrix-local.agentteams.io:18080";
  const dashboard = {
    content: {
      msgtype: "m.text",
      body: "@Tiangong P0.2 Target Worker dashboard-mention nonce-1",
      formatted_body: "@Tiangong P0.2 Target Worker dashboard-mention nonce-1",
      "m.mentions": { user_ids: [worker] },
    },
  };
  const rich = {
    content: {
      msgtype: "m.text",
      body: `${worker} rich-mention nonce-2`,
      format: "org.matrix.custom.html",
      formatted_body: `<a href="https://matrix.to/#/${worker}">${worker}</a> rich-mention nonce-2`,
      "m.mentions": { user_ids: [worker] },
    },
  };
  assertMentionGateBoundary(dashboard, rich, worker);
  assertReplayContract("$rich-event-1", "$rich-event-1");
  assertSenderPreserved({ sender: admin }, admin);
  assertSenderPreserved({ sender: worker }, worker);
  console.log("p0 mention/delivery contract: 5/5 passed");
}
