# Professional delivery after approval Result handoff

> Date: 2026-08-04
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Leader initialization boundary)

## Scope

Fresh Team `tg-del12-7b2c9f`, Project `professional-del12-7b2c9f`, five
role-scoped Workers, fixed Runner broker, disposable deployment target/broker,
explicit approval, requester delivery, durable Evidence, and exact cleanup.
This run is independent of del8 through del11. No earlier Task, notification,
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

## New code boundary under test

After the approved `deploy_release` operation has durably completed, the
Worker runtime submits the bound release ResultEnvelope from the exact machine
outcome and records bounded handoff Evidence. A later exact model submission is
only a Result replay. Approval continuation failures remain fail-closed and
record a stable handoff failure code.

## Setup observations

The first Team apply was rejected because the stock CLI requires Worker
resources to exist before the Team references them. No Team, Project, Task,
notification, approval, or deployment side effect was created by that rejected
apply. The exact Worker manifest was then applied once and the exact Team
manifest once; all five Workers reached `Running`, Matrix identities and rooms
were present, and the Team reached `Active`.

## Required machine proof

- checksum-verified setup, `make verify`, fixed Runner broker readiness;
- Active five-role Team, authenticated requester, and converged Matrix policies;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- one immutable Runner preparation/plan/execution per professional Task and
  exact sealed artifact/read-only assessment;
- deployment broker/target readiness before Release notification, exact
  approval subject and operation digest, one deployment, receipt and
  post-verification;
- requester delivery and durable `DELIVERED` Evidence;
- exact cleanup of Team, Workers, Runner/deployment resources, volumes,
  network, state, and temporary files.

## Terminal outcome

The exact initialization message was sent once to each of Designer,
Implementor, Assessor, and Leader in its authenticated Team room. Designer,
Implementor, and Assessor each returned one exact marker; the Leader returned no
exact marker before the bounded initialization timeout. The Operator was not
initialized. Machine reconciliation found four initialization message events,
three exact responses, one Leader message with zero exact response events, and
no Project, Task, Runner invocation, approval, deployment, Result, requester
delivery, or `DELIVERED` evidence. The Leader Worker remained running and its
bounded readiness log was present, so this is an initialization/Matrix response
boundary failure, not a functional delivery attempt.

No initialization message was resent and no Task or deployment side effect was
created. The run is permanently fail-closed. Cleanup must remove only the exact
del12 Team, Workers, Runner state, AgentTeams resources, and temporary files;
cleanup cannot upgrade the verdict. Cleanup passed after the supported
uninstall left the four known exact Worker containers; only the five exact
`tg-del12-7b2c9f` Worker names were removed, the exact AgentTeams network was
verified absent, no AgentTeams containers or data volume remained, and the
pinned installer cache was restored with its checksum.

## Stop rules

Any readiness, preparation, plan, transport, evidence, revision, approval,
deployment, unknown-outcome, notification, result-handoff, requester-delivery,
or cleanup failure is terminal and fail-closed. Do not resend a potentially
consumed Matrix message or retry a failed Task, approval, or deployment.
