# Professional delivery broker-plan retry with fresh Worker namespace

> Date: 2026-08-03
> Level: focused real integration continuation
> Status: FAIL-CLOSED (first plan retrieval unavailable; lower-level hypothesis not confirmed)

## Scope

One unchanged professional delivery attempt after the prior run reached the
Worker tool boundary but failed on its first plan retrieval. The previous run's
machine evidence showed that a direct no-model plan read from the same Worker
container succeeded after the failure while the broker accepted no execution;
this retry tests only the lower-level startup hypothesis that the Implementor
was awakened in a previously-created/stopped container before its broker DNS /
network path was ready.

This run uses a fresh AgentTeams stack, Team, Project, Task chain, Runner and
deployment resources. Provider/model, prompts, fixture, fixed plan
`["node","probe.mjs"]`, timeout, output bound, isolation policy, and deployment
fault mode remain unchanged. No automatic retry, exploratory command, manual
Result, provider substitution, or Task reuse is allowed.

## Changed variable and control

- All five Workers first become Running so AgentTeams provisions credentials and
  the Team reaches Active; controlled members are then put to Sleeping before
  task dispatch, as required by the platform lifecycle.
- The Runner broker is started and its exact plan endpoint is ready before the
  Implementor is woken.
- The run records the exact Worker container creation/start state and performs
  only a bounded transport preflight if needed; the model-facing Runner tool
  still has one invocation and the broker plan is immutable.

This is not a product success oracle: direct preflight output cannot substitute
for the official Worker tool, journal, broker execution, revision, or Result.

## Required proof

1. Fresh `make up` and `make verify` prove automatic Manager readiness.
2. Active five-role Team, six-member Matrix room, and effective peer allowlists
   converge before the first requester prompt.
3. Designer Result is accepted and Implement Task binding is immutable.
4. Implementor's first and only `run_command({taskId})` retrieves the exact plan,
   executes exactly once through the closed broker, and seals one revision.
5. Assessor independently materializes that digest and executes its exact plan
   once; then Operator approval/deployment/post-verify/release/requester gates
   are all machine-proven before any `DELIVERED` claim.
6. Exact cleanup removes all resources; any supported Team/uninstall residue is
   recorded and the overall run remains red.

## Stop rules

- A plan/readiness/transport failure is fail-closed; never replay the Task.
- A second failure of the same lower-level class stops further Full attempts until
  new direct evidence or a code-level regression exists.
- Claims, model text, target activation, and user-visible messages cannot replace
  machine Evidence.

## Result

**FAIL-CLOSED / no delivery.** This run is red and must not be replayed.

### Readiness and controlled startup

- Fresh `make up` succeeded from source `8b69b35`; the committed automatic
  Manager DM recovery ran and a separate `make verify` passed.
- Fresh Team `tg-prof-4c3a6b` reached Active with five Running Workers and a
  six-member Matrix room. The public per-Worker `channelPolicy.groupAllowExtra`
  policy was applied and machine-checked: every Worker had allowlist policy and
  all four professional peers plus the authenticated Admin in its effective
  `groupAllowFrom`.
- AgentTeams first created all five Workers Running so credentials were
  provisioned. Implementor, Assessor, and Operator were then put to Sleeping;
  the stopped Implementor container was removed only after verifying it was
  run-owned and exited, so `agt worker wake` had to create a fresh namespace.
- A closed Runner broker was started and emitted `runner_broker_ready=pass` before
  the Implementor wake. It was bound to Task
  `professional-4c3a6b-implement-0`, run
  `run-097763c9-747f-4a9d-8c24-62b6cb9261ed`, and the immutable execution
  plan `["node","probe.mjs"]`, 30000 ms, 65536 bytes.

### Functional result

- Designer completed and the Leader created Implement Task
  `professional-4c3a6b-implement-0`; its immutable binding digest was
  `097763c9747fba9d8c2462b6cb9261ed783b2c241da77e70d8c04e2068e5498f`.
- The Implementor resolved its Task and made exactly one `run_command` tool
  attempt with only the Task ID. Durable Worker Evidence recorded the closed
  sequence `tool.proposed → gate.decided → tool.execution.started →
  tool.execution.completed(error)` with stable error
  `TIANGONG_RUNNER_PLAN_UNAVAILABLE`.
- No command executed, no Runner execution request was accepted, no immutable
  revision or machine execution Evidence was produced, and no Assess/Release,
  approval, deployment, or `DELIVERED` side effect was created. The Task became
  `blocked`; the Leader derived `RECOVERY_REQUIRED` and delivered the terminal
  requester report once.
- The intended no-model preflight was itself invalid because the orchestration
  probe initially failed to pass its Task/run variables into `docker exec`; this
  is test-driver evidence and not a product claim. After the fail-closed Task
  result, a corrected no-model read from the fresh Worker container retrieved
  the exact plan successfully (digest
  `5bd8981489d05c0c68f8d969a9e383a482594914878849c2c39c21bf77ffa599`). It did
  not call `/v1/execute`, create a Worker journal entry, or replay the Task.
  The successful post-failure read confirms endpoint availability later but
  cannot upgrade the earlier failed invocation.

The fresh namespace did not resolve the first plan-retrieval failure. The
remaining boundary is an unresolved first-request Worker/Runner adapter or
readiness race; the product's fail-closed behavior is correct. This is new
lower-level evidence, so no third unchanged Full attempt is authorized.

### Cleanup

The first supported `agt delete team tg-prof-4c3a6b` returned success but left
Team state `Active`; direct Worker deletion returned the known upstream 409
member-release error. Confirmed whole-stack uninstall removed the controller,
Manager, data, network, generated environment, and sensitive install log but
left four exact run-owned Worker containers. Manual removal of only those four
containers completed cleanup.

Final checks passed:

- Runner broker and all three run-owned Runner volumes absent;
- zero `agentteams-*` containers;
- no `agentteams-net` or `tiangong-agentteams-data`;
- no generated Manager environment or `/home/sj/agentteams-install.log`.

Physical cleanup is **PASS after manual exact cleanup**; the supported upstream
Team/uninstall path defect is recorded and the functional run remains red.

### Follow-up

Do not change provider/model, fixture, timeout, or fail-closed semantics. Add a
bounded, machine-only diagnostic at the Worker↔broker boundary that records
whether the first `/v1/plan` request reached the broker and the stable rejection
stage, without automatic retry or command execution. Only after that evidence
exists should one new fresh Team attempt be considered.
