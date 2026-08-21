# M7 product authority clean-cut

Status: implemented on the current development branch.

## Product authority

PostgreSQL is the only product runtime authority for Work, WorkSpec, Plan references, Task, Result, Matrix message admission/binding, request replay, and wake outbox state. `app/coordination/runtime-server.mjs` is the product entrypoint and requires `TIANGONG_COORDINATION_DATABASE_URL` when a store is not explicitly injected by a test.

`app/server.mjs` has no file-store fallback. Without a PostgreSQL store it reports `postgres-not-configured`; it does not read or reconstruct product state from a local file. Pure record constructors and validators live in `worker/agent/team/coordination-contracts.mjs` and contain no persistence behavior.

Workers never receive the database connection. Leader and member Workers use the bounded Coordination Control API and current deployment binding.

## Queue boundaries

Two PostgreSQL-backed queues remain deliberately separate:

- Matrix admission stores inbound Human event references, Room ordering, lease/retry state, current Work association, and correction facts. It does not copy message bodies.
- Wake outbox stores internal `leader-resume`, `human-reply`, `task-assignment`, and `result-notification` delivery state with claim/ack semantics.

They have different actors, ordering rules, retry behavior, and payloads. Sharing PostgreSQL transactions does not make them one domain object.

## Removed runtime

M7 deletes inactive implementations rather than preserving compatibility shims:

- file-backed CoordinationStore;
- Codex/OpenCodex runtime, cache, sidecar, probes, binaries, dependencies, and image targets;
- native Runner, broker, preparation, Docker executor, and journals;
- old deployment/recovery service and receipts;
- pending Operation stores, operation digests, Approval commands, and reconciliation/retention CLIs;
- fixed RoleProfile/Playbook runtime and WorkRun/ResultEnvelope paths;
- hash-chain Evidence recorder and the smoke/tests that asserted it.

The active Worker image has one `tg-worker` target and delegates all model turns to OpenClaw built-in. Matrix event IDs, PostgreSQL records, Results, ToolResults, and ContentRefs remain distinct direct facts; PostgreSQL transactions are not described as tamper-evident Evidence.

The current local-delivery CloseGuard checks Task terminal facts, active execution ownership, writer release, and readable deliverables. It has no always-empty Operation or Approval placeholders. A future external-write milestone must introduce its typed Operation model, Adapter, exact Human Approval, recovery, and CloseGuard checks together.

## Verification

Deterministic checks cover:

- absence of file fallback and obsolete runtime modules/targets;
- separate admission and wake schemas/contracts;
- Worker and App unit/contract suites;
- PostgreSQL Work/Task/Result closure, duplicate ingress, association correction, request replay conflict, CloseGuard, and cancellation guard behavior against an explicitly disposable PostgreSQL instance.
