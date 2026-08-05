# Diagnostic-enabled professional delivery attempt

> Date: 2026-08-03
> Level: Full real integration continuation
> Status: FAIL-CLOSED (Worker first-plan network boundary)

## Scope

One fresh professional delivery attempt after the first-plan Evidence diagnostic
was implemented and verified. This run is authorized by new lower-layer
Evidence and tests; it does not replay either failed Project/Task. It uses a new
AgentTeams stack, Team, Project, Task chain, Runner broker, and deployment
resources.

Provider/model, prompts, fixture, command plan `["node","probe.mjs"]`, timeout,
output bound, isolation policy, and deployment fault mode are fixed and
unchanged. No exploratory command, manual Result, automatic invocation retry,
or provider substitution is allowed.

## Required proof

1. Fresh `make up` automatically recovers Manager readiness; `make verify`
   passes before Team creation.
2. Five-role Active Team, complete Matrix roster, and explicit effective peer
   allowlists converge before the requester prompt.
3. Designer → Implementor → Assessor → Operator → requester proceeds only via
   immutable Project/Task/Result/Evidence bindings.
4. Implementor and Assessor each produce `runner.plan.requested` followed by
   `runner.plan.received` and one exact broker execution; any
   `runner.plan.failed` is machine-classified and stops the run.
5. Revision, independent Assessor materialization, explicit approval,
   deployment journal/receipt, post-deploy verification, release Result, Matrix
   delivery, and durable requester Evidence all agree before `DELIVERED`.
6. Exact cleanup succeeds; upstream Team/uninstall residue remains a red
   cleanup observation even if manually removed.

## Stop rules

- A plan or execution uncertainty is fail-closed and never replayed.
- A second failure of the same diagnostic class stops further Full attempts.
- Model text and Matrix output are not machine Evidence.

## Result

**FAIL-CLOSED / no professional delivery.**

### Readiness and Team

- Fresh `make up` from source `1fa9495` succeeded. The committed Manager
  admin-DM recovery ran automatically, and a separate `make verify` passed.
- Team `tg-prof-91c0af` reached Active with all five Workers and explicit public
  per-Worker peer policies. Before the requester prompt, each effective
  `groupAllowFrom` contained the four other Team Workers and the authenticated
  Admin; the Team room was not used as a substitute for durable coordination
  state.
- Implementor/Assessor/Operator were put to Sleeping only after all credentials
  were provisioned. The stopped Implementor container was removed after an
  exact run-ownership/state check, so the later wake created a fresh Worker
  namespace.

### Machine result

- Project `professional-91c0af` reached the Designer stage and created
  Implement Task `professional-91c0af-implement-0`.
- Closed broker readiness passed before wake. The immutable binding used
  `run-29fff67a-74b9-42c2-8358-55f5db6423fd`, Runner image
  `sha256:819967bbede7e0c2e05aff91f812c82c4bc5c4feff0da5ccd769bc5029927617`,
  and execution plan `["node","probe.mjs"]`, 30000 ms, 65536 bytes.
- The Implementor made exactly one `run_command` attempt with only the
  assigned Task ID. New durable Evidence recorded:
  - `runner.plan.requested`, sequence 8, hash
    `8fb4aff8e42a2bbbe61669fec58e3bb239de3ba2e5976b2924f0aa3f5e6f6e6b`;
  - `runner.plan.failed`, sequence 9, hash
    `131312134cd706287420b5e5db237c4b65f2e5c715c632dae4f890d9f1f05f1a`,
    stable code `RUNNER_BROKER_PLAN_NETWORK_ERROR`;
  - `run_command` completion, sequence 10, hash
    `c06ec70a142dbfe30d9b8b7258261653269790b66e84f619bbe5aff7f19af01`.
- The broker emitted only its ready marker and no execution or rejection event;
  no command, Runner journal, revision, Assessor/Release Task, approval,
  deployment, or `DELIVERED` side effect occurred. The Task became `blocked`
  and the Leader produced the required `RECOVERY_REQUIRED` terminal report.
- A corrected no-model read from that same fresh Worker after the blocker
  successfully retrieved the exact plan (digest
  `13657baa1c5ac9eb34bf09bff636d040821db07fc0354fdec91ae2be4fe5b8be`). It did
  not call `/v1/execute`, create a Runner journal entry, or replay the Task.

The fresh namespace did not change the outcome. Combined with the previous
run's identical post-failure behavior, the evidence now isolates an unresolved
first Worker→broker transport/readiness boundary: the Worker-side fetch fails
before a usable plan response, then the same endpoint is reachable later. The
exact DNS/TCP cause is intentionally not inferred from the stable sanitized
code. Product fail-closed behavior is correct. This is the second failure of
this diagnostic class; no further Full smoke is authorized without a code-level
transport fix or direct lower-layer reproduction.

### Cleanup

The supported `agt delete team tg-prof-91c0af`/uninstall path again left
run-owned Worker containers after reporting success. Manual deletion of only
those exact four remaining Workers completed final cleanup. Verified:

- Runner broker and all three run-owned Runner volumes absent;
- zero `agentteams-*` containers;
- no `agentteams-net` or `tiangong-agentteams-data`;
- no generated Manager environment or `/home/sj/agentteams-install.log`.

Physical cleanup is **PASS after exact manual cleanup**. The upstream Team
member-release/uninstall defect is recorded; the functional run remains red.

### Follow-up

Do not change provider/model, fixture, timeout, command plan, or fail-closed
semantics. The next work item is a deterministic lower-layer reproduction and
code-owned transport readiness fix (or a public AgentTeams lifecycle fix) that
prevents the first Worker plan fetch from racing network availability, without
retrying a failed Task or executing a probe outside the immutable plan.
