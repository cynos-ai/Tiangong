# Professional delivery after cross-session approval fix

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (paused Worker did not consume queued Task)

## Scope

Fresh Team `tg-del4-b672ac`, Project, five-role Designer → Implementor →
Assessor → Operator chain, closed Runner broker, disposable deployment target,
deployment broker, authenticated explicit approval, requester Matrix delivery,
and exact cleanup. This run is authorized by the code-level fixes in commits
`d9cea20` and `95f3f11` after the previous Full stopped at the cross-session
approval boundary.

The previous failure showed that requester approval used a different Matrix
session from the Operator pending operation. The first fix moved idempotency,
pending-operation, and deployment-receipt state to a fixed Worker-scoped state
root. The second fix added a constrained structured-arguments envelope for
`deploy_release`; only `{taskId}` is persisted and raw write payload handling
remains separate.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 installer and
checksum `701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`,
fixed Worker/Runner/deployment images, fixture, command `["node","probe.mjs"]`,
cwd, timeout `30000`, output limit `65536`, deployment fault mode `none`,
requester identity, explicit approval subject, and peer policy remain fixed.
Implementor and Assessor receive only `taskId`; argv, cwd, timeout, and output
limits come from immutable broker plans. No exploratory command, manual Result,
target-only activation, provider substitution, automatic retry, or replay is
allowed.

Implementor, Assessor, and Operator are paused only by the exact smoke driver
while their run-owned broker or target boundary is prepared. Each is unpaused
at most once after the required binding/readiness facts exist. This is test
orchestration, not a production synchronization API.

## Required machine proof

- checksum-verified setup and `make verify` before Team creation;
- Active five-role Team, complete roster, authenticated requester, and peer
  policy convergence;
- accepted Designer, Implementor, and independent Assessor Results;
- exactly one first plan and execution for each Runner Task, sealed artifact,
  and read-only Assessor materialization;
- explicit subject approval found from a requester Matrix session distinct from
  the Operator Team-room session, with the exact operation digest;
- deployment journal/receipt, post-verification, accepted release Result,
  requester Matrix delivery, and durable `DELIVERED` Evidence;
- exact cleanup of only run-owned resources.

## Stop rules

Any blocker, identity/readiness failure, plan failure, transport failure,
evidence mismatch, approval mismatch, deployment uncertainty, unknown result,
or cleanup failure is fail-closed. No failed Task, approval, or deployment is
replayed. Model prose cannot establish `DELIVERED`.

## Owned resources

- Team and Project created for this run;
- five exact Worker containers and the run's Runner and deployment containers;
- run-labeled Runner/deployment config, fixture, state, and target volumes;
- any run-specific network created for the deployment target.

Credentials, provider configuration, raw prompts/responses, and unrestricted
logs stay outside Evidence and diagnostics.

## Result

**FAIL-CLOSED / no `DELIVERED`.**

The checksum-verified setup and `make verify` passed. Fresh Team
`tg-del4-b672ac` reached Active. The first pause was initially applied before
all four Worker readiness facts had converged; no Project side effect existed
at that point. The exact three Workers were unpaused, `readyWorkers=4` was
observed, and the same exact three were paused again before the valid setup
retry. This corrected the roster readiness precondition before Project
creation.

The Leader then created Project `professional-del4-b672ac` with binding digest
`067e39c4383512d9b52e3b9c0e98647b24cf9b9025b80a373580697fd12d1e8b`, the
Designer submitted an accepted bound Result, and the Leader dispatched
Implement Task `professional-del4-b672ac-implement-0`. Its immutable Task
binding digest was
`28df61b026e3214b16cff029a25cf50dcca848a1e7443a19c96190aa931c82e7`.

The run-owned Runner broker was created from the rebuilt image and reported
`runner_broker_ready=pass` before exactly one unpause of the exact Implementor
container. The Team room contained the original Implement Task mention, but
no Implementor Tiangong session or Evidence file appeared after a bounded
wait. There was no `runner.plan.requested`, no `/v1/plan` request, no Runner
journal, no execution, and no Implement Result. The broker log contained zero
request events and its state volume contained no journal files.

This is a distinct paused-Worker notification/lifecycle boundary, not a
Runner transport result and not evidence that the approval fix failed. The
run was stopped without dispatch replay, manual Result, or model continuation.
The next focused setup must establish and machine-verify an initialized
Implementor session before the pause (as required by the prior focused v2
proof), then repeat only this lifecycle boundary. No Full delivery is
authorized until that deterministic lower-layer/setup boundary is proven.

### Cleanup

The exact Runner broker and three run-labeled Runner volumes were removed.
Native Team deletion succeeded. The supported uninstall again left the four
exact Worker containers; only those exact names were manually removed. Final
checks found zero `agentteams-*` containers, networks, or volumes, zero
`del4-b672ac` resources, no generated Manager environment, and no install log.
Physical cleanup is PASS after known upstream residue; the functional Full
smoke remains red.

## Execution log

- setup: `make up`, `make verify` — PASS;
- project/task setup after roster convergence — machine-bound PASS through
  accepted Designer and Implement Task dispatch;
- Runner broker readiness — PASS;
- Implementor queued-task consumption after one unpause — FAIL-CLOSED;
- Runner execution, approval, deployment, release, requester delivery — NOT
  ATTEMPTED.
