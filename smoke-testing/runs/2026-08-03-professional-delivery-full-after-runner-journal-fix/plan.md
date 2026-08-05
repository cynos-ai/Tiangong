# Professional delivery after RunnerJournal synchronization fix

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Implementor Task-notification boundary)

## Scope

Fresh Team `tg-del6-92f8d9`, Project, five-role Designer → Implementor →
Assessor → Operator workflow, closed Runner broker, disposable deployment
target/service/broker, explicit approval, release Result, requester Matrix
terminal delivery, and exact cleanup.

This is the one Full attempt authorized by focused v5 after the code-level
fixes for Worker-scoped approval/Runner state, constrained deployment pending
arguments, and stale runtime sync. Implementor, Assessor, and Operator each
receive one bounded setup turn and have a persistent Tiangong session before
being paused. Each exact Worker is unpaused at most once only after its
immutable binding and external readiness are machine-proven.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
Worker/Runner/deployment images, valid change specification, fixture, command
`["node","probe.mjs"]`, cwd, timeout `30000`, output limit `65536`,
deployment fault mode `none`, explicit approver, requester identity, and peer
policies remain fixed. Implementor/Assessor receive only `taskId`; immutable
plans supply execution fields. No exploration, manual Result, target-only
activation, provider/model/fixture/policy substitution, automatic retry, or
replay is allowed.

## Required machine proof

- checksum-verified setup and `make verify` before Team/Project creation;
- Active roster, authenticated requester, and peer-policy convergence;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- exactly one Runner plan/execution per Implementor/Assessor, fixed command,
  sealed artifact, and readonly independent assessment;
- approval found from requester Matrix session distinct from Operator Team
  session and bound to the exact operation digest;
- deployment journal/receipt, post-verification, requester terminal delivery,
  durable `DELIVERED` Evidence;
- exact owned cleanup.

## Observed result

**FAIL-CLOSED / no `DELIVERED`.**

`make verify` passed and the five-worker roster reached authenticated channel
readiness. Implementor, Assessor, and Operator each completed the bounded
initialization DM with one persistent Tiangong session before pause. The
Leader created Project `professional-del6-92f8d9`; the Designer Result was
accepted and Implement Task `professional-del6-92f8d9-implement-0` was
machine-dispatched. The Leader Evidence recorded exactly one task dispatch
with delivered Matrix mention and no queued/replayed notification.

After the run-owned Runner broker reported ready, the exact Implementor was
unpaused once. It did not consume the assigned Task: no local Evidence file,
`task.resolved`, `runner.plan.requested`, `runner.plan.received`, command
execution, or Implement Result appeared. The Task remained durable in the
fixed AgentTeams shared storage. No notification was resent and no Task was
retried. Assessor dispatch, Operator release, approval, deployment,
post-verification, requester delivery, and `DELIVERED` Evidence were not
attempted. The next attempt requires a deterministic lower-layer orchestration
fix that keeps each paused Worker inside the Channel Plane liveness budget or
moves broker preparation before notification; no Full retry is authorized by
this record.

This Full attempt is therefore red despite the focused v5 RunnerJournal
completion pass. The bounded diagnostic found the original Task mention durable
in the Team room, but the paused Implementor produced no Tiangong turn after
unpause. Its OpenClaw gateway subsequently recorded the stable
`MATRIX_GATEWAY_TICK_TIMEOUT` disconnect after the pause exceeded the gateway
liveness interval; the queued Matrix event was not replayed into a Tiangong
turn. This is an AgentTeams/OpenClaw Channel Plane lifecycle boundary, not a
Runner result. Focused and Full verdicts are not upgraded by cleanup or by the
durable-but-unconsumed Task.

## Stop rules

Any blocker, readiness/identity failure, plan/transport failure, evidence or
approval mismatch, unknown result, deployment uncertainty, or cleanup failure
is fail-closed. No failed Task, command, or deployment is replayed. Model prose
cannot establish `DELIVERED`.

## Cleanup

The exact Implement Runner broker and three exact Runner volumes were removed.
Native Team deletion passed. The supported uninstall again left the four exact
Worker containers; only those exact names were manually removed. Final checks
found zero `agentteams-*` containers, networks, or volumes, zero `del6` run
resources, no generated Manager environment, and no install log. Physical
cleanup is PASS after the known upstream residue; the functional verdict
remains FAIL-CLOSED.

## Owned resources

Team `tg-del6-92f8d9`, its Project/Tasks and exact Workers; run-labeled Runner
and deployment containers/volumes/network. Credentials, raw prompts/responses,
and unrestricted logs remain outside this report.
