# Professional delivery after broker-ordering fix

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Assessor identity readiness boundary)

## Scope

Fresh five-role Team `tg-full-4392d0`, Project, Task chain, Runner broker,
disposable deployment target/service, deployment broker, approval, requester
identity, and cleanup. This is the first Full attempt after the focused proof
that an initialized Worker succeeds when its run-owned broker is ready before
Task consumption.

The Implementor and Assessor are paused only by the exact smoke driver while
their immutable broker bindings are registered. Each is unpaused once, after
broker readiness. This is orchestration control outside the Worker/model; it
prevents the previously observed Task-dispatch/Runner-registration race and
adds no retry or replay.

## Fixed contract

Provider/model, playbook, valid change specification, Worker and Runner images,
fixture, command `["node","probe.mjs"]`, cwd, timeout `30000`, output limit
`65536`, deployment target/fault mode, explicit approval subject, and Matrix
requester remain fixed. Workers receive only `taskId` for Implementor/Assessor
commands. No manual Result, exploratory command, target-only activation,
provider substitution, or automatic retry is allowed.

## Required machine proof

- pinned checksum-verified AgentTeams setup and `make verify`;
- Active five-role Team, authenticated requester, roster and peer policy;
- Designer Result and accepted Implement Task;
- Implementor first-plan received and exactly one execution with sealed
  `ChangeRevisionRef`;
- independent Assessor plan/materialization/read-only evidence and accepted
  Result;
- explicit subject approval bound to the release operation digest;
- Operator deployment journal/receipt, post-verification, release Result,
  Matrix requester delivery, and durable `DELIVERED` Evidence;
- exact owned resource cleanup, with upstream residue treated as failure.

## Result

**FAIL-CLOSED / no `DELIVERED`.**

Setup used the checksum-verified public AgentTeams v1.2.0 cache with the fixed
checksum `701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`;
`make up` and `make verify` passed. The fresh Team `tg-full-4392d0` reached
Active with the five-role roster and authenticated requester.

The focused broker ordering fix worked for the Implementor:

- Implement Task `professional-full-4392d0-implement-0` was created while its
  initialized Worker was paused;
- broker readiness was observed before one unpause;
- `runner.plan.requested`, sequence 5, hash
  `da2c58346bdfc3d99faa76b33fdc31abc779d7a6fed42ed222329ab4c53f435f`;
- `runner.plan.received`, sequence 6, hash
  `2ee0a778336d52a66b5cc3884b1f1a9bcfd634544427d16e056213daab9b9d9a`;
- plan digest `4f60227afe977f8bd9b9b971b4fcdbdd96672e768a8c2cc6fcb5e07d0a32c754`;
- fixed command digest `6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`;
- one successful execution produced sealed artifact
  `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62` and an
  accepted Implement Result.

The run then failed before Assessor Runner access. After the Leader created
Assess Task `professional-full-4392d0-assess-0`, the paused Assessor's first
`team_resolve_task` failed with the stable Team identity error
`Authenticated AgentTeams Team identity does not match the required role`;
the task entered `blocked` and the Assessor submitted a blocker Result with
no artifact, Evidence, or `ChangeRevisionRef`. No Assessor `/v1/plan`, command,
Release Task, approval, deployment, requester delivery, or `DELIVERED` side
effect occurred. The later no-model `assertTeamIdentity("worker")` probe in
the same container passed, but it was diagnostic only and did not replay or
advance the blocked Task.

This is a new AgentTeams identity/readiness boundary, not Runner evidence and
not a valid delivery. The run is permanently red under the blocker and no
Full retry is authorized until the identity transition has a deterministic
code-level/readiness fix.

### Cleanup

The run-owned Runner broker and exact config, fixture, and state volumes were
removed. Team deletion succeeded. The supported uninstall again left the four
exact Worker containers; only those exact containers were manually removed.
Final checks found zero `agentteams-*` containers, networks, or volumes, zero
`full-4392d0` Runner resources, no generated Manager environment, and no install
log. Physical cleanup is PASS after known upstream residue; functional Full
smoke remains red.

## Stop rules

Any blocker, plan failure, uncertain execution, evidence mismatch, approval
mismatch, deployment uncertainty, or cleanup failure is fail-closed. No task is
replayed and the run cannot claim `DELIVERED` from model text or a manual
Result.
