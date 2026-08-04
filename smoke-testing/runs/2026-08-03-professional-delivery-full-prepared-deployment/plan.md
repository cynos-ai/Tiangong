# Professional delivery with pre-provisioned deployment boundary

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (post-approval Release Result handoff)

## Scope

Fresh Team `tg-del11-4c18a0`, Project, and Designer → Implementor → Assessor →
Operator chain. This run is independent of del8, del9, and del10; no earlier
Task, notification, approval, execution, or result may be replayed.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
role images, fixed isolation fixture, command `["node","probe.mjs"]`, role
cwd, timeout `30000`, output limit `65536`, exact successful fixture stdout
`runner_probe=pass`, target previous digest, explicit approval subject,
requester identity, peer policies, and deployment fault mode `none`. No
exploration, JSON redesign, substitution, manual Result, automatic retry, or
replay.

## Broker ordering

The code-owned Runner broker is started before Team/Project creation. Before
Leader notification can create the Release Task, a disposable target service
and the fixed `tiangong-deployment-broker` are pre-provisioned on
`agentteams-net` with the exact Operator container/image, deterministic Release
Task ID, target capability, previous digest, and the expected immutable
ChangeRevision reference for the fixed fixture. The broker still validates the
actual submitted ChangeRevision and operation digest; any mismatch fails
closed. Workers receive no Docker socket or platform credentials.

## Required proof

- checksum-verified setup, `make verify`, Active five-role Team, authenticated
  requester, and converged Matrix policies;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- one Runner preparation/plan/execution per professional Task and exact sealed
  artifact/read-only assessment;
- deployment broker/target readiness before Release notification, exact
  requester approval, deployment journal/receipt, post-verification,
  requester delivery, and durable `DELIVERED` Evidence;
- exact cleanup of Team, Workers, Runner/deployment brokers, target, state,
  volumes, network, and temporary files.

## Stop rules

Any readiness, preparation, plan, transport, evidence, revision, approval,
deployment, unknown-outcome, notification, or cleanup failure is terminal and
fail-closed. Do not resend a mention, replay a Task, retry a command, approval,
or deployment. Cleanup cannot upgrade a functional failure.

## Owned resources

Team `tg-del11-4c18a0`, exact five Workers and native/shared Project/Tasks;
fixed Runner broker/state; deployment target, deployment broker, config/state
volumes, and temporary files carrying this run identity.

## Terminal outcome

The run passed the Active Team boundary, fixed-fixture Designer/Implementor/
Assessor chain, exact sealed artifact, independent assessment, and deployment
broker/target readiness before Release notification. The explicit requester
approval was accepted for approval ID `approval-a73fda911233c252b3679295` and
operation digest `43b448a78782f3ff16d36bbe533083ccb5b10c51612e89306a6e708e1d2e3dc2`.
The deployment broker journal and Worker Evidence captured a single successful
`DELIVERED` deployment outcome with target `target-del11-4c18a0` and current
artifact digest `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`.

However, the Operator did not submit the required bound Release ResultEnvelope
or requester terminal delivery. A later direct-DM continuation was correctly
rejected because its authenticated actor was `@admin`, not the Project Leader;
no Task replay, second approval, or second deployment was attempted. The
native Release Task remains `assigned`, with no `result-envelope.json`, so the
functional verdict is permanently fail-closed and this run does not authorize
`DELIVERED`. This exposes a post-approval continuation/result-handoff defect,
not evidence that machine deployment alone proves delivery.

Cleanup after evidence capture must remove the target, deployment broker,
three deployment volumes, Runner broker/state, Team, and exact Worker residue;
physical cleanup cannot upgrade this functional verdict.
