# Professional delivery after bounded pause guard

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Implementor Runner endpoint/guard boundary)

## Scope

Fresh Team `tg-del7-03ee36`, Project `professional-del7-03ee36`, and the
fixed Designer → Implementor → Assessor → Operator delivery chain. This is a
new Full run after the deterministic paused-Worker liveness guard passed. It
must not replay any Task from `tg-del6-92f8d9`.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
Worker/Runner/deployment images, valid change specification, fixture, command
`["node","probe.mjs"]`, cwd, timeout `30000`, output limit `65536`,
deployment fault mode `none`, explicit approver, requester identity, and peer
policies remain fixed. Implementor/Assessor accept only `taskId`; immutable
broker plans provide command, cwd, timeout, and output bounds. No exploration,
manual Result, target-only activation, provider/model/fixture/policy
substitution, automatic retry, or replay.

## New lower-layer control

Each paused Worker boundary is driven only by
`smoke-testing/support/pause-worker-until-file.sh`. The helper verifies the
exact container and `AGENTTEAMS_WORKER_NAME`, enforces a 120-second maximum
pause budget, waits for an exact `ready=pass` marker after broker preparation,
and always attempts unpause. If the guard, broker preparation, or Task turn
fails, stop fail-closed without resending the notification.

The Implementor and Assessor must be guarded separately. The Operator may be
kept running until immediately before the release Task if its deployment
broker/target are prepared first; otherwise the same guard is required.

## Required machine proof

- checksum-verified setup and `make verify` before Team creation;
- Active five-role roster, authenticated requester, and peer-policy convergence;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- exactly one Runner plan/execution per Implementor/Assessor, fixed command,
  sealed artifact, and read-only independent assessment;
- explicit requester approval from a Matrix session distinct from the Operator,
  bound to the exact operation digest;
- deployment journal/receipt, post-verification, requester terminal delivery,
  durable `DELIVERED` Evidence;
- exact owned resource cleanup.

## Observed result

**FAIL-CLOSED / no `DELIVERED`.**

The checksum-verified cached installer was used; `make up` and `make verify`
passed. Team `tg-del7-03ee36` became Active with the five-role roster. The
Implementor, Assessor, and Operator each completed one initialization turn.
The Leader created Project `professional-del7-03ee36`; the design Task was
completed and accepted, and exactly one Implement Task
`professional-del7-03ee36-implement-0` was dispatched.

The new pause guard correctly enforced its 120-second paused-Worker budget, but
the external broker preparation did not publish its readiness marker before the
budget expired. The Worker therefore resumed without a valid reachable broker.
Its machine Evidence contains exactly one `runner.plan.requested`, zero plan
responses, one `runner.plan.failed` with stable code
`RUNNER_BROKER_DNS_UNAVAILABLE`, zero command executions, and one blocker
Result. The blocker Result has content digest
`1f33ef71ddda31bdcdd5d0c54f355a833c4c395ca54c8daed4789308a68855bf`; no
artifact or `ChangeRevisionRef` exists. The run-owned broker itself reported
ready, but its suffixed container name did not match the Worker's fixed default
broker endpoint, so that readiness was not a valid Worker binding proof.

No notification, Task, Runner command, approval, deployment, or Result was
retried. Assessor, Operator release, requester delivery, and `DELIVERED`
Evidence were not attempted. This is a Full test-driver/broker-registration
failure, not successful delivery and not evidence that the fixed command ran.

### Cleanup

The exact run-owned broker, config/fixture/state volumes, readiness markers, and
Team were removed. `make uninstall` exited `2` after leaving the four exact
Worker containers; only those `tg-del7-03ee36` containers were manually
removed. Final checks found no `agentteams-*` containers, no `del7` resources,
no AgentTeams network, no generated Manager environment, and no install log.
The checksum-verified installer cache remains intentionally. Physical cleanup
is PASS; the functional Full result remains permanently FAIL-CLOSED.

## Stop rules

Any blocker, readiness/identity failure, plan/transport failure, evidence or
approval mismatch, unknown result, deployment uncertainty, notification guard
failure, or cleanup failure is fail-closed. Do not retry a failed Task,
notification, command, approval, or deployment. Model prose cannot establish
`DELIVERED`.

## Owned resources

Team `tg-del7-03ee36`, its Project/Tasks and exact Workers; run-labeled Runner
and deployment containers, volumes, networks, readiness markers, and temporary
files. Credentials, raw prompts/responses, and unrestricted logs remain
outside this report.
