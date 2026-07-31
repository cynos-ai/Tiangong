export class TurnGateState {
  #pending;

  get pending() {
    return this.#pending ? structuredClone(this.#pending) : undefined;
  }

  suspend(checkpoint) {
    if (!checkpoint?.idempotencyKey || !checkpoint?.operationDigest) {
      throw new TypeError("A pending checkpoint requires idempotencyKey and operationDigest");
    }
    if (this.#pending && this.#pending.idempotencyKey !== checkpoint.idempotencyKey) {
      return this.pending;
    }
    this.#pending = structuredClone(checkpoint);
    return this.pending;
  }

  decisionFor(toolCallId) {
    if (!this.#pending) return undefined;
    return {
      kind: "pending",
      reason: "another tool call suspended this turn",
      approvalId: this.#pending.approvalId,
      blockedByToolCallId: this.#pending.toolCallId,
      toolCallId,
    };
  }
}

export function assertGateDecision(decision) {
  if (!decision || !["allow", "deny", "pending"].includes(decision.kind)) {
    throw new TypeError("Gate must return allow, deny, or pending");
  }
  if (decision.kind !== "allow" && (typeof decision.reason !== "string" || decision.reason === "")) {
    throw new TypeError(`${decision.kind} decision requires a reason`);
  }
  if (decision.kind === "pending" &&
      (typeof decision.approvalId !== "string" || decision.approvalId === "")) {
    throw new TypeError("pending decision requires approvalId");
  }
  return decision;
}
