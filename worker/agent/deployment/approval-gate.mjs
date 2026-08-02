export class DeploymentApprovalGate {
  #store;
  constructor({ idempotencyStore }) { if (!idempotencyStore?.get) throw new TypeError("Deployment approval Gate requires idempotency storage"); this.#store = idempotencyStore; }
  async evaluate(context) {
    if (context.operation?.toolName !== "deploy_release") return { kind: "deny", reason: "tool is outside the deployment approval surface", reasonCode: "TOOL_NOT_AUTHORIZED" };
    if (typeof context.actorId !== "string" || context.actorId === "") return { kind: "deny", reason: "an authenticated approval subject is required", reasonCode: "APPROVAL_SUBJECT_UNAVAILABLE" };
    const existing = await this.#store.get(context.idempotencyKey);
    if (existing?.operationDigest && existing.operationDigest !== context.operationDigest) return { kind: "deny", reason: "stored approval does not match the deployment", reasonCode: "OPERATION_DIGEST_MISMATCH" };
    if (["approved", "completed"].includes(existing?.status)) return { kind: "allow", approvalId: existing.approvalId };
    if (existing?.status === "rejected") return { kind: "deny", reason: "deployment was rejected", reasonCode: "APPROVAL_REJECTED" };
    if (["executing", "failed"].includes(existing?.status)) return { kind: "deny", reason: "deployment outcome requires reconciliation", reasonCode: "EXECUTION_UNCERTAIN" };
    return { kind: "pending", reason: "deployment requires explicit approval", reasonCode: "DEPLOYMENT_APPROVAL_REQUIRED", approvalId: existing?.approvalId ?? `approval-${context.idempotencyKey.slice(0, 24)}` };
  }
}
