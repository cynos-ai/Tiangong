import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCheckpointApprovalPolicyWellFormed,
  assertExplicitSubjectApproval,
  assertOperationApprovalSubject,
  isMatrixUserId,
  resolveDeploymentApprover,
} from "../agent/gates/explicit-subject-policy.mjs";

const ADMIN = "@demo-admin:tiangong.example";
const OTHER = "@someone-else:tiangong.example";

test("isMatrixUserId accepts well-formed Matrix user ids and rejects others", () => {
  assert.equal(isMatrixUserId(ADMIN), true);
  assert.equal(isMatrixUserId("@user:server.com"), true);
  assert.equal(isMatrixUserId("not-an-id"), false);
  assert.equal(isMatrixUserId(""), false);
  assert.equal(isMatrixUserId(null), false);
});

test("resolveDeploymentApprover resolves the configured admin and fails closed otherwise", () => {
  const approver = resolveDeploymentApprover({ deploymentApprover: ADMIN });
  assert.equal(approver.type, "explicit_subject");
  assert.equal(approver.subject, ADMIN);
  assert.equal(Object.isFrozen(approver), true);
  // missing or non-Matrix config fails closed
  assert.throws(() => resolveDeploymentApprover({}), /configured Matrix user id/);
  assert.throws(() => resolveDeploymentApprover({ deploymentApprover: "admin" }), /configured Matrix user id/);
});

test("assertExplicitSubjectApproval authorizes the configured admin only", () => {
  const approver = resolveDeploymentApprover({ deploymentApprover: ADMIN });
  assert.equal(assertExplicitSubjectApproval({ actorId: ADMIN, approver }), ADMIN);
  // a different Matrix identity is rejected
  assert.throws(
    () => assertExplicitSubjectApproval({ actorId: OTHER, approver }),
    /not the configured deployment approver/,
  );
  // a non-Matrix actor is rejected
  assert.throws(
    () => assertExplicitSubjectApproval({ actorId: "leader", approver }),
    /not a Matrix user id/,
  );
});

test("the approver subject never comes from the checkpoint", () => {
  // a checkpoint may declare intent without a subject
  assert.equal(
    assertCheckpointApprovalPolicyWellFormed({ approvalPolicy: { type: "explicit_subject" } }),
    true,
  );
  assert.equal(assertCheckpointApprovalPolicyWellFormed({}), true);
  // a checkpoint smuggling a subject is rejected (Task/model cannot choose the approver)
  assert.throws(
    () => assertCheckpointApprovalPolicyWellFormed({ approvalPolicy: { type: "explicit_subject", subject: ADMIN } }),
    /must not travel with the checkpoint/,
  );
  // an unsupported policy type is rejected
  assert.throws(
    () => assertCheckpointApprovalPolicyWellFormed({ approvalPolicy: { type: "anyone" } }),
    /unsupported approval policy type/,
  );
});

test("runtime approval selection uses config for explicit_subject and preserves requester-only default", () => {
  const explicitCheckpoint = { operation: { approvalPolicy: { type: "explicit_subject" } } };
  assert.equal(assertOperationApprovalSubject({
    checkpoint: explicitCheckpoint,
    actorId: ADMIN,
    config: { deploymentApprover: ADMIN },
    assertRequester: () => { throw new Error("requester path must not run"); },
  }), ADMIN);
  assert.throws(() => assertOperationApprovalSubject({
    checkpoint: explicitCheckpoint,
    actorId: OTHER,
    config: { deploymentApprover: ADMIN },
    assertRequester: () => OTHER,
  }), /not the configured deployment approver/u);

  const requesterCheckpoint = { requestedBy: OTHER };
  assert.equal(assertOperationApprovalSubject({
    checkpoint: requesterCheckpoint,
    actorId: OTHER,
    config: {},
    assertRequester: (checkpoint, actor) => {
      assert.equal(checkpoint, requesterCheckpoint);
      return actor;
    },
  }), OTHER);
});

test("even with a forged subject on the checkpoint, only config decides the approver", () => {
  const approver = resolveDeploymentApprover({ deploymentApprover: ADMIN });
  // the gate ignores any checkpoint; the actor must equal the config subject
  assert.throws(
    () => assertExplicitSubjectApproval({ actorId: OTHER, approver }),
    /not the configured deployment approver/,
  );
});
