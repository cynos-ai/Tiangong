// explicit_subject deployment approval policy (architecture §10 / gate 8).
//
// The existing gate only allows the requester to approve. When the Leader
// dispatches an Operator deploy Task the requester is the Leader, so a human
// admin could never approve it. This code-owned policy lets a single,
// explicitly configured demo admin Matrix identity approve Leader-dispatched
// deploys, bound to the operation digest/target/revision/precondition/rollback.
//
// Security property: the approver subject comes ONLY from fixed demo/team
// config resolved at gate time and is checked against the authenticated Matrix
// actor. It is never read from Task text, model parameters, the upstream owner
// boolean, or the checkpoint itself. A checkpoint may only declare the intent
// to use explicit_subject; it must not carry a subject.

const MATRIX_USER_ID_PATTERN = /^@[A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+$/u;

export function isMatrixUserId(value) {
  return typeof value === "string" && MATRIX_USER_ID_PATTERN.test(value);
}

// Resolve the single configured deployment approver from fixed config. The
// config is code/demo-owned; a missing or non-Matrix value fails closed.
export function resolveDeploymentApprover(config) {
  const subject = config?.deploymentApprover;
  if (!isMatrixUserId(subject)) {
    throw new Error("deploymentApprover must be a configured Matrix user id");
  }
  return Object.freeze({ type: "explicit_subject", subject });
}

// Authorize an authenticated actor against the configured approver. The
// subject is never read from the checkpoint; only `approver` (from config) is
// trusted. actorId must be the authenticated Matrix identity.
export function assertExplicitSubjectApproval({ actorId, approver }) {
  if (approver?.type !== "explicit_subject") {
    throw new Error("approval policy is not explicit_subject");
  }
  if (!isMatrixUserId(actorId)) {
    throw new Error("authenticated actor is not a Matrix user id");
  }
  if (actorId !== approver.subject) {
    throw new Error("actor is not the configured deployment approver");
  }
  return actorId;
}

// A checkpoint may declare the intent to use explicit_subject, but it must NOT
// smuggle a subject (which would let Task text or model parameters choose the
// approver). This is the guard that keeps the subject config-bound.
export function assertCheckpointApprovalPolicyWellFormed(checkpoint) {
  const policy = checkpoint?.operation?.approvalPolicy ?? checkpoint?.approvalPolicy;
  if (policy === undefined || policy === null) return true;
  if (policy?.type !== "explicit_subject") {
    throw new Error("unsupported approval policy type");
  }
  if (policy.subject !== undefined) {
    throw new Error("approval policy subject must not travel with the checkpoint");
  }
  return true;
}

export function assertOperationApprovalSubject({ checkpoint, actorId, config, assertRequester }) {
  assertCheckpointApprovalPolicyWellFormed(checkpoint);
  const policy = checkpoint?.operation?.approvalPolicy ?? checkpoint?.approvalPolicy;
  if (policy?.type === "explicit_subject") {
    const approver = resolveDeploymentApprover(config);
    return assertExplicitSubjectApproval({ actorId, approver });
  }
  if (typeof assertRequester !== "function") {
    throw new TypeError("requester approval validator is required");
  }
  return assertRequester(checkpoint, actorId);
}
