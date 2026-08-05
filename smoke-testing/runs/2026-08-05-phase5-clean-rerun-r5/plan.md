# Phase 5 clean rerun R5 — revision and safe rollback reproducibility

> Date: 2026-08-05
> Level: independent Full AgentTeams/Matrix/Runner/deployment rerun
> Status: FAIL-CLOSED (Runner preparation input reference invalid)

## Scope

Fresh exact-scope Team `tg-p5r5-08050900`, five Workers, Runner broker,
Project, approval, Evidence, and fault-injected target. No R4 Team, Worker,
Project/Task, approval, journal, target, or artifact is reused. Historical
AgentTeams Project/Task records remain preserved under the authority boundary;
there are no active prior Team/Worker or Runner resources.

## Contract

Repeat the bounded R4 contract: revision 0 is intentionally not final because
acceptance requires `revisionIndex >= 1`; Assessor requests one revision;
revision 1 is accepted; Operator approval and one faulted deployment produce
`FAILED_SAFE` after one rollback and healthy previous-digest verification.
Run the read-only readiness probe before the first Task notification.

## Machine result

The first Design and Implement Results were persisted. The Assessor Task was
created with an input reference in the form
`p5r5-08050900-implement-0:<result-digest>`. The code-owned Runner preparation
boundary accepts Task IDs as input references; it therefore failed closed with
`RUNNER_BROKER_PREPARATION_INPUT_INVALID` before an assessment command plan or
ChangeRevision could be proven. The Assessor submitted a blocker Result and
the Leader recorded a `blocked` decision with no result digest.

No Release Task, approval, deployment, rollback, or terminal delivery was
created. This is a clean-rerun failure, not a successful Phase 5 claim and not
a reason to loosen the input-reference contract.

## Stop and cleanup

Any missing machine binding, revision, approval, deployment, rollback, report,
Evidence, or cleanup proof is fail-closed. Delete only exact run-owned
resources; preserve AgentTeams Project/Task authority and do not uninstall or
rebootstrap local AgentTeams.

Cleanup passed: the exact Runner broker and volumes, Team, five Workers,
cleanup helper, exact Worker containers, and temporary manifests were absent.
The AgentTeams-owned Project/Task records are retained under the authority
boundary.
