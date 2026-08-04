# Professional delivery after identity-readiness gate

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Operator release boundary)

## Scope

Fresh Team `tg-del2-3b8a7f`, Project, five-role Task chain, run-owned Runner
broker, deployment target/service/broker, explicit approval, requester
binding, and exact cleanup. This run follows the code-owned bounded
pre-task `waitForTeamIdentity` gate and the focused broker-ordering proof.

Implementor and Assessor containers are paused only by the exact smoke driver
while immutable Runner bindings are registered. Each is unpaused once after
broker readiness. This is orchestration control, not a model capability and
not a Task retry.

## Fixed contract

Provider/model, playbook, fixture, Worker/Runner images, command
`["node","probe.mjs"]`, cwd, timeout `30000`, output limit `65536`, deployment
fault mode, approval subject, requester identity, and peer policy remain fixed.
Implementor/Assessor tools receive only `taskId`; all execution fields come
from the immutable broker plan. No exploratory command, manual Result,
provider substitution, target-only activation, or automatic replay is allowed.

## Required machine proof

- checksum-verified setup and `make verify`;
- Active five-role Team, roster, authenticated requester, and peer policy;
- accepted Designer and Implement Results;
- first plan received and exactly one execution for both Implementor and
  Assessor, with sealed artifact and independent read-only materialization;
- explicit approval bound to the exact release operation digest;
- deployment journal/receipt, post-verification, release Result, Matrix
  requester delivery, and durable `DELIVERED` Evidence;
- exact owned cleanup.

## Result

**FAIL-CLOSED / no `DELIVERED`.**

Setup used the exact checksum-verified AgentTeams v1.2.0 artifact
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`; `make up`
and `make verify` passed. Fresh Team `tg-del2-3b8a7f` reached Active.

The identity and Runner boundaries passed in this fresh run:

- Designer Result was completed and accepted;
- Implement Task `professional-del2-3b8a7f-implement-0` produced one received
  immutable plan and one exact successful execution, with run
  `run-4d9adfc6-bc2e-4223-8419-e3004f12a1d0`, plan digest
  `521abf8816fd802b5c2332a3065a5cd91c84a1d74e5ba23c8a7708f32e6993dd`, fixed
  command digest `6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`,
  and sealed artifact `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`;
- Assessor Task `professional-del2-3b8a7f-assess-0` passed the bounded identity
  gate, received one exact plan, independently materialized the sealed
  artifact read-only, and produced an accepted Result with run
  `run-b8f36342-e09c-40cf-9b80-8380c11d909b` and plan digest
  `b8dd6f70060a7fcde6cf6ce776b6a917a3925ff06dbdd82c0a093f004bb6a8d2`.

The run stopped at the Operator release boundary:

- the Leader durably created Release Task `professional-del2-3b8a7f-release-0`;
- the Operator's first turn resolved it successfully but did not call
  `deploy_release`, so no approval or external side effect occurred;
- after the exact deployment target and broker were ready, one explicit
  requester continuation was sent to the same assigned Task. Its next
  `team_resolve_task` failed closed before deployment; the later no-model
  identity probe passed, but no Task/Result/Runner replay was performed;
- no `approval.requested`, approval, deployment journal/receipt,
  post-verification, release Result, requester delivery, or `DELIVERED` Evidence
  exists.

A target-service startup permission error was corrected before the Operator
boundary by chowning only the exact run-owned state volume; this setup fix did
not change any Task or deployment contract. The functional Full run remains
red and cannot be upgraded from model text.

### Cleanup

The exact Runner broker, deployment broker/service, and all six exact Runner /
deployment volumes were removed. Team deletion succeeded. The supported
uninstall again left four exact Worker containers; only those exact containers
were manually removed. Final checks found zero `agentteams-*` containers,
networks, or volumes, zero `del2-3b8a7f` resources, no generated Manager
environment, and no install log. Physical cleanup is PASS after known upstream
residue.

The next allowed work is deterministic Operator-turn diagnosis or a code-owned
release readiness fix. Do not replay this Release Task or launch another Full
attempt from this failed Project.

## Stop rules

Any identity/readiness failure, blocker, plan failure, uncertain execution,
evidence mismatch, approval mismatch, deployment uncertainty, or cleanup
failure is fail-closed. No failed Task is replayed and no model text can prove
`DELIVERED`.
