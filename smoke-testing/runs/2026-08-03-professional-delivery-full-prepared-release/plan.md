# Professional delivery with pre-provisioned release boundary

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (cross-session approval lookup)

## Scope

Fresh Team `tg-del3-a13aa9`, Project, five-role Task chain, Runner broker,
disposable deployment target/service/broker, approval, requester binding, and
exact cleanup. This run uses the code-owned bounded Team identity gate and the
focused broker-ready ordering proof.

Implementor, Assessor, and Operator are paused only by the exact smoke driver
while their run-owned external binding is prepared. The Operator is paused
before Release Task notification so the deployment target/broker are ready
before its first model turn; it is then unpaused exactly once and receives the
original Leader-authenticated assignment. No requester continuation or Task
replay is used.

## Fixed contract

Provider/model, playbook, fixture, Worker/Runner images, command
`["node","probe.mjs"]`, cwd, timeout `30000`, output limit `65536`, deployment
fault mode `none`, approval subject, requester identity, and peer policy remain
fixed. Implementor/Assessor tools receive only `taskId`; execution fields are
immutable broker authority. No exploratory command, manual Result, provider
substitution, target-only activation, or automatic retry.

## Required machine proof

- checksum-verified setup and `make verify`;
- Active five-role Team, complete roster, authenticated requester and peer
  policies;
- accepted Designer, Implementor, and independent Assessor Results;
- explicit subject approval bound to the exact deployment operation digest;
- deployment journal/receipt, post-verification, release Result, Matrix
  requester delivery, and durable `DELIVERED` Evidence;
- exact owned resource cleanup.

## Result

**FAIL-CLOSED / no `DELIVERED`.**

Setup used the fixed checksum-verified AgentTeams v1.2.0 artifact
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`; `make up`
and `make verify` passed. Fresh Team `tg-del3-a13aa9` reached Active.

The pre-task identity and Runner boundaries passed:

- Implement Task `professional-del3-a13aa9-implement-0` received one immutable
  plan and executed once, run `run-c9506916-7685-4f2c-96f2-f81092df5afa`, plan
  digest `6a9b0ce5ee99032a1742bce058b3b254cfd019c58fc5b7e7997123883220355a`,
  fixed command digest `6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`,
  artifact `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`;
- Assessor Task `professional-del3-a13aa9-assess-0` received one immutable
  plan and independently verified the same sealed artifact read-only, run
  `run-23270d9e-168d-495b-a943-6e20aa89cce4`, plan digest
  `9548103a72f5874281ca554d3353544bb681aa27eb5bcfc644756c351fa9a0d5`;
- Release Task `professional-del3-a13aa9-release-0` was created with the
  accepted assessment input, and exact deployment target/broker readiness
  passed before the paused Operator was unpaused.

The Operator resolved the Release Task and called `deploy_release`; machine
Evidence reached the explicit approval gate with approval ID
`approval-1ddbcb8d87ee8382d2363f6f` and operation digest
`3b0a6f4b2a40a21c1ac0644b7fcd2afb06b70686d481167c9b424811c7755b12`. The
requester sent the exact `APPROVE` command from the authenticated Admin DM,
but the runtime returned the deterministic error `Approval request not found`.
The pending approval belonged to the Operator's Team-room Matrix session,
while the requester approval opened a different Matrix session and the
runtime searched only that session's idempotency store. No deployment service
stage/activate/verify/rollback, receipt, release Result, requester terminal
report, or `DELIVERED` Evidence occurred.

This is a code-owned cross-session approval persistence/lookup defect. The
approval and deployment were not retried; the Project remains permanently red.
The next fix must make pending idempotency and payload state Worker-scoped (or
perform a bounded durable lookup across session roots) while preserving the
exact operation digest, requester subject, and fail-closed behavior.

### Cleanup

The exact Runner broker, deployment broker/service, and all six exact Runner /
deployment volumes were removed. Team deletion succeeded. The supported
uninstall again left four exact Worker containers; only those exact containers
were manually removed. Final checks found zero `agentteams-*` containers,
networks, or volumes, zero `del3-a13aa9` resources, no generated Manager
environment, and no install log. Physical cleanup is PASS after known upstream
residue.

## Stop rules

Any blocker, identity/readiness failure, plan failure, uncertain execution,
evidence mismatch, approval mismatch, deployment uncertainty, or cleanup
failure is fail-closed. No failed Task is replayed and no model text proves
`DELIVERED`.
