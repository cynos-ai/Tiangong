export class PolicyGate {
  #store;

  constructor({ idempotencyStore }) {
    this.#store = idempotencyStore;
  }

  async evaluate(context) {
    if (context.operation.toolName === "read") return { kind: "allow" };
    if (context.operation.toolName !== "write") {
      return {
        kind: "deny",
        reason: "tool is not authorized by the Tiangong policy",
        reasonCode: "TOOL_NOT_AUTHORIZED",
      };
    }

    if (typeof context.actorId !== "string" || context.actorId === "") {
      return {
        kind: "deny",
        reason: "an authenticated approval subject is required for workspace writes",
        reasonCode: "APPROVAL_SUBJECT_UNAVAILABLE",
      };
    }

    const existing = await this.#store.get(context.idempotencyKey);
    if (existing?.operationDigest && existing.operationDigest !== context.operationDigest) {
      return {
        kind: "deny",
        reason: "stored approval does not match the requested operation",
        reasonCode: "OPERATION_DIGEST_MISMATCH",
      };
    }
    if (existing?.status === "approved" || existing?.status === "completed") {
      return { kind: "allow", approvalId: existing.approvalId };
    }
    if (existing?.status === "rejected") {
      return {
        kind: "deny",
        reason: "the requested operation was rejected",
        reasonCode: "APPROVAL_REJECTED",
      };
    }
    if (existing?.status === "executing" || existing?.status === "failed") {
      return {
        kind: "deny",
        reason: "the previous execution outcome requires reconciliation",
        reasonCode: "EXECUTION_UNCERTAIN",
      };
    }
    return {
      kind: "pending",
      reason: "workspace writes require explicit approval",
      reasonCode: "WORKSPACE_WRITE_APPROVAL_REQUIRED",
      approvalId: existing?.approvalId ?? `approval-${context.idempotencyKey.slice(0, 24)}`,
    };
  }
}
