# Professional Worker initialization boundary

> Date: 2026-08-03
> Level: focused real AgentTeams/Runner integration
> Status: FAIL-CLOSED (task consumed before broker registration)

## Hypothesis

The two diagnostic-enabled Implementor failures occurred immediately after a
sleeping Worker was woken and made its first Runner plan request. A later
read-only plan request from the same container succeeded. This focused run
changes exactly one variable: Implementor remains Running from Team startup and
its AgentTeams network/container initialization is observed before the Leader
creates the Implement Task.

This is not a retry of either failed Task and does not claim delivery. It stops
at the first immutable Implementor plan/execution boundary unless the observed
result authorizes a separately recorded continuation.

## Fixed contract

Provider/model, prompt, fixture, immutable command plan `["node","probe.mjs"]`,
timeout, output bound, Runner image, network policy, and broker identity remain
fixed. The model may call `run_command` once with only its assigned Task ID.
There is no exploratory command, pre-execution, automatic retry, manual Result,
or test-driver-authored Task/Result.

## Required evidence

- Fresh Manager readiness and `make verify`.
- Active Team with all five Workers and effective peer allowlists.
- Implementor container Running with an `agentteams-net` address before the
  Implement Task exists.
- Fresh Project and immutable Implement Task created by the real Leader.
- Broker plan requested/received or plan failure Evidence, plus broker request
  logs and Runner journal state.
- If successful: one completed `["node","probe.mjs"]` execution and sealed
  revision. If not: fail-closed blocker and no command side effect.
- Exact cleanup; upstream member-release residue remains a red observation.

## Result

**FAIL-CLOSED / diagnostic hypothesis not exercised.**

- Fresh `make up` completed with automatic Manager readiness recovery and the
  focused Team reached Active. All five Worker containers were already Running
  with stable `agentteams-net` addresses before the Leader prompt.
- The Leader created Project `professional-init-4da994` and Implement Task
  `professional-init-4da994-implement-0`. Because the Implementor was kept
  Running, it consumed the assignment immediately:
  - `runner.plan.requested` at `2026-08-03T07:44:11.815Z`;
  - `runner.plan.failed` at `2026-08-03T07:44:13.117Z`, code
    `RUNNER_BROKER_PLAN_NETWORK_ERROR`.
- The run-owned broker was not created and ready until
  `2026-08-03T07:44:32.983Z`. Therefore this run proves a separate
  task-dispatch/runner-registration race, not the earlier “broker ready before
  sleeping Worker wake” boundary. No broker HTTP request, command, Runner
  journal, revision, or replay occurred.
- The blocker Result remained fail-closed and no Assess/Release Task was
  authorized. This run is not a retry or an upgrade of any previous verdict.

The result establishes an orchestration invariant for any future real run:
the Runner broker binding must exist and be reachable before the Implement Task
notification can be consumed. Creating the immutable broker binding after
Leader dispatch is too late; creating it before the Task is impossible without
an explicit registration/preparation boundary. That boundary must be owned by
code or by a deterministic test-driver pause, never by model timing.

Cleanup: the supported uninstall again left four exact Worker containers;
manual deletion of only those resources completed cleanup. Verified zero
`agentteams-*` containers, zero `agentteams-*` networks/volumes, no generated
Manager environment, and no `/home/sj/agentteams-install.log`. Cleanup is
physically complete; the functional run remains red.

## Stop rule

Any plan failure or uncertain command outcome remains fail-closed. This focused
run does not replay or upgrade the previous Full failures.
