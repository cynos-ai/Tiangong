const CONSUMER_ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const RECEIPT_ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,256}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_BATCH = 32;

function requireString(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} is missing or invalid`);
  }
  return value;
}

function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(error.code)
    ? error.code : "OUTBOX_HANDLER_FAILED";
}

function receiptId(wakeId, value) {
  if (value === undefined || value === null) return `receipt-${wakeId}`;
  return requireString(value, "outbox receipt", RECEIPT_ID);
}

/**
 * Deliver pending wakes at least once, then claim and acknowledge them.
 * Handlers must use deterministic/idempotent side effects: a crash after the
 * side effect and before ack leaves the wake pending for safe replay.
 */
export async function drainLeaderOutbox({ store, handlers = {}, consumerId, maxEntries = MAX_BATCH } = {}) {
  if (!store || typeof store.listOutbox !== "function" || typeof store.claimWake !== "function" || typeof store.ackWake !== "function") {
    throw new TypeError("Leader outbox requires a CoordinationStore");
  }
  requireString(consumerId, "outbox consumerId", CONSUMER_ID);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_BATCH) {
    throw new TypeError("outbox maxEntries is outside the bounded range");
  }
  if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) throw new TypeError("outbox handlers must be an object");
  const pending = await store.listOutbox({ status: "pending" });
  const claimed = (await store.listOutbox({ status: "claimed" }))
    .filter((wake) => wake.consumerId === consumerId);
  const candidates = [...pending, ...claimed];
  const results = [];
  for (const wake of candidates.slice(0, maxEntries)) {
    const handler = handlers[wake.kind];
    if (typeof handler !== "function") continue;
    try {
      const value = await handler(Object.freeze(wake));
      const receipt = receiptId(wake.wakeId, value?.receiptId);
      if (wake.status === "pending") {
        await store.claimWake({
          wakeId: wake.wakeId,
          consumerId,
          requestId: `outbox-claim-${wake.wakeId}`,
        });
      }
      const acknowledged = await store.ackWake({
        wakeId: wake.wakeId,
        consumerId,
        receiptId: receipt,
        requestId: `outbox-ack-${wake.wakeId}`,
      });
      results.push({ wakeId: wake.wakeId, kind: wake.kind, status: acknowledged.wake.status, receiptId: receipt });
    } catch (error) {
      results.push({ wakeId: wake.wakeId, kind: wake.kind, status: wake.status === "claimed" ? "claimed" : "pending", errorCode: errorCode(error) });
    }
  }
  return Object.freeze({ scanned: Math.min(candidates.length, maxEntries), results: Object.freeze(results) });
}

/**
 * Build the two B2 handlers once deployment has bound route projection and
 * native Leader resume. The resolver is intentionally explicit: a Work only
 * contains routeId, so a stale or guessed Matrix room can never be inferred.
 */
export function createLeaderOutboxHandlers({ store, channel, resolveWorkRoute, resumeLeader } = {}) {
  if (!store || typeof store.getWork !== "function") throw new TypeError("Leader outbox handlers require a CoordinationStore");
  if (!channel || typeof channel.notifyWorkAdmitted !== "function") throw new TypeError("Leader outbox handlers require a Team channel");
  if (typeof resolveWorkRoute !== "function") throw new TypeError("Leader outbox handlers require a Work route resolver");
  if (typeof resumeLeader !== "function") throw new TypeError("Leader outbox handlers require a native Leader resume hook");
  return Object.freeze({
    "human-reply": async (wake) => {
      const work = await store.getWork(wake.workId);
      if (!work?.work || work.work.actorId !== wake.targetMemberId) throw new Error("OUTBOX_HUMAN_TARGET_MISMATCH");
      const route = await resolveWorkRoute(work);
      if (!route || typeof route !== "object" || !MATRIX_ROOM_ID.test(route.roomId ?? "") || !DIGEST.test(route.bindingDigest ?? "")) {
        throw new Error("OUTBOX_ROUTE_BINDING_INVALID");
      }
      const reply = await channel.notifyWorkAdmitted(work.work.actorId, {
        roomId: route.roomId,
        workId: work.work.workId,
        sourceEventId: work.work.sourceEventId,
        bindingDigest: route.bindingDigest,
      });
      return { receiptId: reply.transactionId };
    },
    "leader-resume": async (wake) => {
      const result = await resumeLeader(Object.freeze(wake));
      return result === undefined ? undefined : { receiptId: result?.receiptId ?? result?.sessionId };
    },
  });
}
