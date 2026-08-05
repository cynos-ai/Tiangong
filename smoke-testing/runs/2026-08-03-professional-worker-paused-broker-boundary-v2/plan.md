# Pre-initialized Worker / broker-boundary proof v2

> Date: 2026-08-03
> Level: focused real AgentTeams/Runner integration
> Status: PASS (focused boundary; no Full delivery)

## Purpose

Reproduce the remaining first `/v1/plan` boundary with one controlled ordering
variable. A fresh five-role Team is started. The exact Implementor container is
observed Running with an initialized session and stable `agentteams-net` address,
then paused by the smoke driver. The real Leader creates a valid design and
Implement Task while that Worker cannot consume the Matrix notification. The
run-owned immutable broker is then created and must report ready before the
Worker is unpaused.

This is a fresh Team/Project/Task and is not a replay. Docker pause is only a
bounded test-driver control on the exact run-owned Worker; it is not a Worker
or model capability.

## Fixed contract

Provider/model, playbook, valid change specification, fixture, Runner image,
command plan `["node","probe.mjs"]`, timeout, output bound, peer policy, and
role tools remain fixed. The model may call the Implementor `run_command` once
with only the assigned Task ID. No exploratory command, manual Result, retry,
or Full delivery is permitted.

## Required machine evidence

- `make verify` before Team creation and Active complete five-role roster;
- initialized Implementor session and stable network address before pause;
- durable Project, successful Designer Result, and durable Implement Task before
  unpause;
- immutable broker binding and `runner_broker_ready=pass` before unpause;
- Worker `runner.plan.requested` followed by `runner.plan.received` or a stable
  sanitized transport classification; no execution replay;
- exact run-owned cleanup and explicit upstream residue result.

## Result

**PASS / focused boundary proof; no Full delivery.**

The first setup attempt was blocked by the pinned installer origin. The run
then used the exact local installer artifact whose SHA-256 matched the fixed
repository checksum `701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`;
no source, version, or checksum was changed. `make up` and `make verify` passed.

Fresh Team `tg-pause2-d19799` reached Active. The Implementor had an
initialized session and stable address `172.22.0.7` before the exact container
was paused. The Leader created Project `professional-pause2-d19799`, the
Designer completed the bound design Task, and the Implement Task
`professional-pause2-d19799-implement-0` was durably assigned while the
Implementor remained paused. The run-owned broker was then started with the
immutable binding and reported `runner_broker_ready=pass` before unpause.

After exactly one unpause, machine Evidence proves the boundary succeeded:

- run ID: `run-8414ade1-c65a-4c08-9bee-13227e8f9397`;
- `runner.plan.requested`, sequence 13, hash
  `d42cd96179749204567c2313550bd301785a09c1db14543e59b9ab4bfb35aacb`;
- `runner.plan.received`, sequence 14, hash
  `15e7b0b3fbb43c9d174dd8e5d43f370c969813c73de5bc02fc4ace81fa4c6ecf`;
- immutable plan digest
  `8199b835be2bbeb77535f84307e51733c83688b818f7c63a802756e99c05ac79`;
- fixed command digest
  `6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`;
- plan: `["node","probe.mjs"]`, `scratch/revision`, `30000`, `65536`;
- one successful Runner journal execution with invocation key
  `caf310fca31fdcc443dfe702c6c2d5457d2acd0bea7e56062d52a91f35593acb`;
- sealed artifact digest
  `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`;
- Implement Result references that run and artifact; no Assessor, Release,
  deployment, requester delivery, or `DELIVERED` claim was attempted.

This isolates the earlier failure class to task consumption before broker
registration/readiness. A pre-initialized Worker with the broker ready before
consumption does not reproduce the first-plan failure. The current code's
fail-closed plan diagnostics remain unchanged; this focused result is the
lower-layer ordering evidence needed before a future Full attempt.

### Cleanup

The run-owned broker `tiangong-runner-broker-pause2-d19799` and exact config,
fixture, and state volumes were removed before stack teardown. The supported
Team delete succeeded. The upstream uninstall again left the four exact
run-owned Worker containers; deleting only those exact names completed the
cleanup. Final checks found zero `agentteams-*` containers, zero
`agentteams-*` networks, zero `tiangong-agentteams-*` volumes, no generated
Manager environment, no install log, and no `pause2-d19799` Runner resources.
Physical cleanup is PASS after the known upstream residue; the focused result
remains non-DELIVERED.

## Stop rule

Any plan failure or uncertain command is fail-closed. This focused run cannot
claim `DELIVERED` and must not advance the professional chain beyond the
Implementor boundary.
