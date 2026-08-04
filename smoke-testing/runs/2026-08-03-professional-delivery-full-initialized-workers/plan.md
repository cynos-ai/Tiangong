# Professional delivery with initialized paused Workers

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Runner journal completion / duplicate turn)

## Scope

Fresh Team `tg-del5-05130a`, Project, five-role Designer → Implementor →
Assessor → Operator workflow, closed Runner broker, disposable deployment
target/service/broker, explicit authenticated approval from a requester Matrix
session distinct from the Operator Team-room session, release Result, requester
terminal delivery, and exact cleanup.

This Full attempt follows the focused v3 proof: Implementor, Assessor, and
Operator each receive a bounded setup turn and have a persistent Tiangong
session before their exact container is paused. Each is unpaused at most once,
after its immutable external binding and readiness are machine-proven. The
setup marker is never accepted as functional evidence.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 artifact checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
Worker/Runner/deployment images, valid change specification, fixture, command
`["node","probe.mjs"]`, cwd, timeout `30000`, output limit `65536`, deployment
fault mode `none`, explicit approver, requester identity, and peer policies
remain fixed. Implementor/Assessor tools accept only `taskId`; immutable broker
plans supply execution fields. No exploration, manual Result, target-only
activation, provider/model/fixture/policy substitution, automatic retry, or
replay is allowed.

## Required machine proof

- checksum-verified setup and `make verify` before Team/Project creation;
- Active complete roster, authenticated requester, and peer-policy convergence;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- exactly one plan and execution for each Runner Task, fixed command digest,
  sealed artifact, independent readonly Assessor materialization;
- explicit approval found across Matrix sessions and bound to the exact
  deployment operation digest;
- deployment journal/receipt, healthy post-verification, requester Matrix
  terminal delivery, and durable `DELIVERED` Evidence;
- exact owned cleanup.

## Stop rules

Any blocker, readiness/identity failure, plan or transport failure, evidence
mismatch, approval mismatch, unknown execution result, deployment uncertainty,
or cleanup failure is fail-closed. No failed Task or deployment is replayed.
Model prose cannot establish `DELIVERED`.

## Owned resources

Team `tg-del5-05130a`, its Project/Tasks and five exact Workers; run-labeled
Runner/deployment containers, volumes, and network. Credentials, raw prompts,
responses, and unrestricted logs remain outside this report.

## Result

**FAIL-CLOSED / no `DELIVERED`.**

Checksum-verified setup and `make verify` passed. All five Worker Matrix
channels became ready and the Implementor, Assessor, and Operator each had one
persistent Tiangong session before the exact pause. Project and Designer setup
succeeded; the Leader accepted the Designer Result and dispatched
`professional-del5-05130a-implement-0`. The Implementor broker binding was
registered and `runner_broker_ready=pass` was observed before exactly one
unpause.

The first broker execution did produce the fixed successful machine facts: the
plan digest was `a72313b576ee34cdbde102ccdff62b9b4a4ccf6e821d8a715407cd44f222c1b6`,
command digest was
`6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`, exit
code was 0, stdout was the bounded `runner_probe=pass`, and the broker state
contained the sealed artifact. However, the Worker-local RunnerJournal remained
at status `executing` instead of a completed entry. The Implementor Evidence
then recorded a second `runner.plan.requested` / `runner.plan.received` pair and
one `TIANGONG_RUNNER_OUTCOME_UNCERTAIN` completion with
`RUNNER_EXECUTION_IN_PROGRESS_OR_INTERRUPTED`. The final Implement Result was a
machine blocker with digest
`3a4b8175c3561bee4ba0e3e7e0d02b745105480387616e4ba11d24e4085200a9`, not a
ChangeRevision-bearing success.

Counts before cleanup were: two plan requests, two plan responses, one Runner
tool error, and no accepted Implement Result. The Worker journal was durably
left `executing`; the broker journal had a completed execution and the sealed
revision. This mismatch is fail-closed and unknown from the Worker authority's
perspective. No Assessor Task, deployment broker/target, approval, release
Result, requester delivery, or `DELIVERED` Evidence was attempted.

This is a distinct Runner/Worker journal completion and duplicate-turn boundary,
not proof of a successful delivery. The broker's successful state cannot be
substituted for the Worker journal or Result binding. No journal repair,
re-execution, Task replay, or manual Result was performed. A focused
code-level regression must reproduce the completion path and expose a bounded
stable reason before another Full smoke.

### Cleanup

The exact Runner broker and three run-labeled Runner volumes were removed.
Native Team deletion passed. The supported uninstall again left the four exact
Worker containers; only those exact names were manually removed. Final checks
found zero `agentteams-*` containers, networks, or volumes, zero `del5-05130a`
resources, no generated Manager environment, and no install log. Physical
cleanup is PASS after the known upstream residue.
