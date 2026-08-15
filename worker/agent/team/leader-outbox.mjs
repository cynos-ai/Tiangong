const CONSUMER_ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const RECEIPT_ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,256}$/u;
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
  const results = [];
  for (const wake of pending.slice(0, maxEntries)) {
    const handler = handlers[wake.kind];
    if (typeof handler !== "function") continue;
    try {
      const value = await handler(Object.freeze(wake));
      const receipt = receiptId(wake.wakeId, value?.receiptId);
      await store.claimWake({
        wakeId: wake.wakeId,
        consumerId,
        requestId: `outbox-claim-${wake.wakeId}`,
      });
      const acknowledged = await store.ackWake({
        wakeId: wake.wakeId,
        consumerId,
        receiptId: receipt,
        requestId: `outbox-ack-${wake.wakeId}`,
      });
      results.push({ wakeId: wake.wakeId, kind: wake.kind, status: acknowledged.wake.status, receiptId: receipt });
    } catch (error) {
      results.push({ wakeId: wake.wakeId, kind: wake.kind, status: "pending", errorCode: errorCode(error) });
    }
  }
  return Object.freeze({ scanned: Math.min(pending.length, maxEntries), results: Object.freeze(results) });
}
