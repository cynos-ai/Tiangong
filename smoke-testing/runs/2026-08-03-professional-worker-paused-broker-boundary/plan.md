# Pre-initialized Worker / broker-boundary proof

> Date: 2026-08-03
> Level: focused real AgentTeams/Runner integration
> Status: FAIL-CLOSED (focused setup input omission)

## Purpose

Isolate the remaining first-plan boundary without letting a newly-created Task
race a broker that does not exist. The real Implementor is started and its
`agentteams-net` address is observed first. The exact owned container is then
paused only while the Leader creates the fresh Implement Task and the run-owned
immutable broker binding is registered. It is unpaused only after the broker
reports ready.

This changes one lifecycle variable relative to the failed Full attempts: the
Worker process/network namespace is initialized before Task consumption. It is
not a replay and does not use the failed Projects or Tasks.

## Fixed contract

Provider/model, fixture, Runner image, plan `["node","probe.mjs"]`, timeout,
output bound, network policy, prompts, and role tools remain fixed. The model
may call `run_command` once with only the assigned Task ID. Docker pause is a
bounded test-driver control on the exact owned Worker container, not a model
tool and not a replacement for AgentTeams coordination state.

## Required evidence

- Fresh Manager readiness and Active five-role Team.
- Implementor Running with stable `agentteams-net` address before pause.
- Fresh Project/Implement Task from the real Leader while the exact Worker is
  paused.
- Broker immutable binding and `runner_broker_ready=pass` before unpause.
- `runner.plan.requested` plus either `runner.plan.received` and one completed
  immutable command, or a sanitized stable failure code.
- No replay or manual Result; exact cleanup with upstream residue recorded.

## Result

**FAIL-CLOSED / hypothesis not exercised.**

- Fresh AgentTeams readiness recovery succeeded and the Team reached Active;
  all five Worker containers were Running and the Implementor was observed with
  a stable `agentteams-net` address and initialized OpenClaw session before the
  exact container was paused.
- The Leader created Project `professional-pause-469a48`, but the focused
  prompt omitted a bound change specification. The real Designer correctly
  returned a blocker because `inputRefs` was empty and no functional or
  non-functional requirements were bound.
- No Implement Task, Runner broker, Runner plan, command, revision, or replay
  was created. A transient Leader message was not accepted as machine proof.
- The exact paused Worker was unpaused before cleanup. The supported uninstall
  again left four exact Worker containers; manual deletion of only those
  resources completed cleanup. Verified zero `agentteams-*` containers,
  networks, and volumes, with no generated Manager environment or install log.

This run is an orchestration/setup failure, not evidence for or against the
Worker→Runner transport hypothesis. It must not be upgraded or reused.

## Stop rule

Any plan failure or uncertain command remains fail-closed. This focused run
stops after the Implementor boundary and cannot claim `DELIVERED`.
