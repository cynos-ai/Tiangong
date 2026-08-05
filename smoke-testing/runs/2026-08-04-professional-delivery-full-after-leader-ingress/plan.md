# Professional delivery after bounded approval-result handoff

> Date: 2026-08-04
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Operator continuation boundary)

## Scope

Fresh Team `tg-del13-8c3d0a`, Project `professional-del13-8c3d0a`, five
role-scoped Workers, fixed Runner broker, disposable deployment target/broker,
explicit approval, requester delivery, durable Evidence, and exact cleanup.
This run is independent of del8 through del12. No earlier Task, notification,
approval, execution, or Result is replayed.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 installer checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
role images, `smoke-testing/fixtures/runner-isolation`, command
`["node","probe.mjs"]`, role cwd, timeout `30000`, output limit `65536`,
exact fixture stdout `runner_probe=pass`, explicit approval subject, requester
identity, peer policies, and deployment fault mode `none`. Implementor and
Assessor tools receive only `taskId`; command, cwd, timeout, and output limits
remain immutable broker authority. No exploration, substitution, manual Result,
Task retry, approval retry, deployment retry, or model prose can prove delivery.

## Ingress and deployment ordering

The four professional Workers receive one exact initialization marker each.
The Leader is not sent a synthetic initialization prompt: its first real
authenticated Team-room prompt creates the Project and design Task. This avoids
confusing Leader readiness with a model-only marker turn. The fixed deployment
broker and target are provisioned immediately after the immutable Implementor
ChangeRevision is materialized, before the Leader can dispatch the Release Task,
using the predetermined Release Task ID and exact revision reference.

## Required machine proof

- checksum-verified setup, `make verify`, fixed Runner broker readiness;
- Active five-role Team, authenticated requester, and converged Matrix policies;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- one immutable Runner preparation/plan/execution per professional Task and
  exact sealed artifact/read-only assessment;
- deployment broker/target readiness before Release notification consumption,
  exact approval subject and operation digest, one deployment, receipt and
  post-verification;
- runtime auto-submitted bound Release ResultEnvelope, requester delivery, and
  durable `DELIVERED` Evidence;
- exact cleanup of Team, Workers, Runner/deployment resources, volumes,
  network, state, and temporary files.

## Terminal outcome

The exact four professional initialization markers each received one exact
response. The initial Manager-container Leader helper got HTTP 403 before any
Matrix event was created; the host-admin Leader ingress then sent one distinct
authenticated prompt and received one `LEADER_DONE` response. The Project and
design Task were created. Machine records showed one accepted Designer Result,
one Implementor Result with ChangeRevision content digest
`84e38334ef6d79ba8052a008a88bd795424493c23f090b90986edb5ac3372018`, artifact
digest `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`, and
one independent Assessor Result binding the same revision. The Release Task
`professional-del13-8c3d0a-release-0` was created only after the fixed
Target/broker preparation was ready; target status and broker readiness both
passed before release notification consumption.

The Operator consumed the Release notification and resolved the assigned Task,
but its bounded Evidence contains no `deploy_release` proposal, Gate decision,
approval, deployment journal/receipt, Release ResultEnvelope, requester
terminal delivery, or `DELIVERED` Evidence. No continuation or Task replay was
sent, and no deployment side effect occurred. The functional run is therefore
permanently fail-closed at the Operator continuation boundary; deployment
readiness alone does not authorize delivery.

Cleanup after evidence capture must remove the exact target/broker, three
labeled deployment volumes, Runner broker/state, Team, Workers, network, and
temporary capability/config files. Cleanup cannot upgrade the verdict.

## Stop rules

Any readiness, preparation, plan, transport, evidence, revision, approval,
deployment, unknown-outcome, notification, result-handoff, requester-delivery,
or cleanup failure is terminal and fail-closed. Do not resend a potentially
consumed Matrix message or retry a failed Task, approval, or deployment.
