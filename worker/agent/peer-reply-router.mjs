import { normalizeReplyTarget } from "./turn-contract.mjs";

const MATRIX_USER_ID_IN_TEXT = /@[A-Za-z0-9._=+\/-]+:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]+)?/gu;
const MAX_PENDING_PEERS = 32;

export class PeerReplyRouter {
  #pending = new Set();

  get pendingCount() {
    return this.#pending.size;
  }

  plan(candidate) {
    const target = normalizeReplyTarget(candidate);
    if (!target) return Object.freeze({ replyTarget: null, expectedPeerId: null });
    const expected = this.#pending.has(target.id);
    return Object.freeze({
      replyTarget: expected ? null : target,
      expectedPeerId: expected ? target.id : null,
    });
  }

  commit(plan, { text, replyTarget }) {
    if (!plan || typeof plan !== "object") throw new TypeError("peer reply plan is required");
    if (typeof text !== "string") throw new TypeError("peer reply text must be a string");
    const target = normalizeReplyTarget(replyTarget);
    const next = new Set(this.#pending);
    if (plan.expectedPeerId !== null) next.delete(plan.expectedPeerId);
    const observed = new Set(target ? [target.id] : []);
    for (const match of text.matchAll(MATRIX_USER_ID_IN_TEXT)) observed.add(match[0]);
    for (const id of observed) next.add(id);
    if (next.size > MAX_PENDING_PEERS) throw new Error("peer reply target limit exceeded");
    this.#pending = next;
  }
}
