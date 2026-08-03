# Professional delivery after cross-turn approval deduplication

> Date: 2026-08-04
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: PASS (machine DELIVERED)

## Scope

Fresh Team `tg-del15-ae5f2c`, Project `professional-del15-ae5f2c`, five
role-scoped Workers, fixed Runner broker, disposable deployment target/broker,
explicit approval, requester delivery, durable Evidence, and exact cleanup.
This run is independent of del8 through del14. No earlier Task, notification,
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
Task notification is consumed. Resolving a release Task invokes the guarded
`deploy_release` boundary once; repeated cross-turn resolution must reuse the
same Worker-scoped approval and idempotency identity rather than create a
second pending authorization.

## Required machine proof

- checksum-verified setup, `make verify`, fixed Runner broker readiness;
- Active five-role Team, authenticated requester, and converged Matrix policies;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- one immutable Runner preparation/plan/execution per professional Task and
  exact sealed artifact/read-only assessment;
- deployment broker/target readiness before Release notification consumption,
  exact approval subject and operation digest, one deployment, receipt and
  post-verification;
- runtime auto-submitted bound Release ResultEnvelope, one approval identity,
  requester delivery, and durable `DELIVERED` Evidence;
- exact cleanup of Team, Workers, Runner/deployment resources, volumes,
  network, state, and temporary files.

## Terminal outcome

The run passed checksum-verified setup, Active five-role Team readiness, four
exact professional initialization markers, authenticated Leader ingress, and
the complete native Project/Task chain. The machine Results were:

- Designer Result digest `8fdf0510bc04fbe17876bdf27f47cc357f0dc1497872d5938d5dd17705e74995`;
- Implementor Result digest `d5a03bf6fb54b875b1b749b045f7b39eeac9247b682358c54d45d80323699d66`,
  ChangeRevision digest `3b8256686a0ddbebd847ee8b5fa5234369d0cb0ed5d5f14fcc1036927545ccec`,
  artifact digest `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`;
- independent Assessor Result digest
  `318276fdff2ac076995b31da823adbcdb6076d6a39e3ceaf92ef9ff259b88760`, binding
  the same ChangeRevision and artifact;
- Release Result digest `b95906a4f234816368a8fa90866873251a7545beb8bad9ba4f85afb515daf440`,
  outcome digest `cd9d3a44ab66adefc19ef89099eb599b0c329ce48b458d0b4e193dcf300a0679`,
  disposition `DELIVERED`, and target `target-del15-ae5f2c`.

Implementor and Assessor each had exactly one preparation/plan receipt, one
plan response, zero plan failures, and one non-replayed completed Runner
execution. Their independent Runner invocation keys were
`6f479bf31fb967049ac8dbf9adb9c47f89c130517f697448c9cde6cfda769bec` and
`9a26980ae519987d4e4028ef6b18000fb52e952c3fc06d6c2405793485a4aff6`; their
plan digests were `9eb81d595f35d05571c08a21753ef38beef634a455fa764ce60359f4de1b4f38`
and `0814d3c7953cf131916fc9f9415e493e12b6b6e2707496ad519b86bb0fceadf3`.
Both materialized the fixed artifact digest.

The deployment target journal contained one initialization, one stage, one
activation, and one healthy post-deploy verification. The final target digest
matched the sealed artifact. The single Worker-scoped operation digest was
`1df9c9b44b74a0e4a8a67ccd94d75da5b63b8c5e1cdcfc9d823c3076e75a4fe3`, with
exact approval ID `approval-7273e5b42dcc1a396aa89ccb`; after approval the
idempotency journal had one operation identity in the pending → approved →
executing → completed chain, and no second approval identity. Runtime Evidence
recorded the deployment completion, one `team.result.submitted`, and one
`deployment.release.result.autosubmitted` for the exact Release Result. The
Leader accepted that Result and wrote terminal `DELIVERED` report digest
`995ddc6ddf5fc8d35d95d2c54c0e30a1264cba823a8862af1d7b853071ac07cf`; exactly
one requester terminal Matrix delivery event was observed.

The Operator made four bounded `team_resolve_task` attempts that failed before
any deployment proposal while its shared assessment input was materializing.
Those attempts produced no Runner, approval, deployment, or Result side effect;
the subsequent successful attempt created the one deduplicated approval above.
No failed Task, Runner execution, approval, deployment, or notification was
retried. This is recorded as a pre-side-effect synchronization observation, not
as an additional delivery operation.

The functional verdict is machine-authorized `DELIVERED`. Physical cleanup
must still pass independently and cannot be used as proof of delivery.

## Cleanup

After evidence capture, remove the exact target/broker, three labeled
Deployment volumes, Runner broker/state, Team, Workers, network, and temporary
capability/config files. Verify absence and restore the pinned installer cache.
A cleanup failure keeps this run red.

## Stop rules

Any readiness, preparation, plan, transport, evidence, revision, approval,
deployment, unknown-outcome, notification, result-handoff, requester-delivery,
or cleanup failure is terminal and fail-closed. Do not resend a potentially
consumed Matrix message or retry a failed Task, approval, or deployment.
