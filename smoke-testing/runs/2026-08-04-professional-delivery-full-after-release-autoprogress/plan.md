# Professional delivery with code-owned release auto-progress

> Date: 2026-08-04
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (duplicate approval proposal)

## Scope

Fresh Team `tg-del14-9d4e1b`, Project `professional-del14-9d4e1b`, five
role-scoped Workers, fixed Runner broker, disposable deployment target/broker,
explicit approval, requester delivery, durable Evidence, and exact cleanup.
This run is independent of del8 through del13. No earlier Task, notification,
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

## Ingress and release ordering

The four professional Workers receive one exact initialization marker each.
The Leader's first real authenticated Team-room prompt creates the Project and
design Task. The fixed deployment target/broker will be provisioned after the
immutable Implementor ChangeRevision is materialized and before the Release
Task notification is consumed. For an Operator release Task, resolving the Task
through `team_resolve_task` invokes the same guarded `deploy_release` boundary
once, so a model turn that stops after resolution cannot bypass approval or
leave a deployment side effect unbound.

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

The run completed the Designer, Implementor, independent Assessor, and
Operator deployment path. It produced one fixed Runner plan/execution per
Implementor and Assessor, one approved deployment with operation digest
`1538a45dfd0d0b90d4f0f768e34397ff965bfb87efa7bb9c8204d19477100243`, approval
ID `approval-a38eda4d01200dba73b9648c`, deployment outcome digest
`07f8dfb81c00b6fbff5bc98e1d46cf063da2658e919847001b3147f7218eafdf`, release
Result digest `20c8374cab3cc567a591e165755d96fce76604e26a761693fd46d177ce34d5e3`,
accepted terminal decision, and one requester `DELIVERED` Matrix report.

However, repeated Operator turns after the first pending approval created a
second pending approval ID `approval-a68c7491f852ca9a95087192` for the same
operation digest. No second deployment occurred and the second approval was
not sent or approved, but the duplicate pending authorization violates the
one-operation/one-approval contract. The run therefore remains permanently
fail-closed and does not promote native `DELIVERED` state to a Tiangong success
verdict. This is a Worker-scoped operation-deduplication defect exposed by the
new code-owned release auto-progress path.

Cleanup after evidence capture must remove the exact target/broker, three
labeled deployment volumes, Runner broker/state, Team, Workers, network, and
temporary capability/config files. Cleanup cannot upgrade the verdict.

## Stop rules

Any readiness, preparation, plan, transport, evidence, revision, approval,
deployment, unknown-outcome, notification, result-handoff, requester-delivery,
or cleanup failure is terminal and fail-closed. Do not resend a potentially
consumed Matrix message or retry a failed Task, approval, or deployment.
