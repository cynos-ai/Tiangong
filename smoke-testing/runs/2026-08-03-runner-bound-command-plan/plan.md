# Runner broker-bound command plan regression

> Date: 2026-08-03
> Level: focused deterministic container integration
> Status: PASS

## Scope

Prove the remediation for the failed professional delivery attempt recorded in
`2026-08-03-professional-delivery-recovery-roundtrip`: professional models may
choose only the assigned Task ID, while a closed broker plan fixes argv,
working directory, timeout, and output bounds before the Worker creates its
immutable Runner invocation.

This run does not use a model, Matrix, AgentTeams stack, deployment target, or
external service. It does not claim a professional Team roundtrip or
`DELIVERED`.

## Preconditions

- Full Worker deterministic suite passes.
- Repository and shell checks pass.
- Implementor, Assessor, and Runner broker images are rebuilt from the current
  worktree before execution.
- The smoke helper creates unique names from a random UUID and refuses to
  replace existing containers, network, or state volume.

## Required proof

1. Broker config validates one exact bounded execution plan per Task binding.
2. The authenticated Implementor and Assessor retrieve their plans before
   their Worker journals begin and execute only those exact plans.
3. Execution Evidence binds the immutable plan digest, invocation key, image,
   isolation policy, container configuration, and fixture digest.
4. A changed command request is rejected before broker execution.
5. An unauthorized peer cannot retrieve a plan or consume an invocation.
6. Implementor revision capture, Assessor independent read-only materialization,
   and exact broker replay remain functional.
7. Professional client containers receive no Docker socket.
8. Exact cleanup removes all UUID-owned containers, network, state, and
   temporary config.

## Fail-closed rules

- Plan retrieval failure occurs before the Worker invocation journal exists.
- A model-supplied argv field is absent from the professional tool schema.
- Missing/mismatched plan digest or changed plan is not execution success.
- Timeout or broker execution uncertainty is never automatically retried.
- Cleanup failure keeps the run failed.

## Result

**PASS** at the focused deterministic and real-container layers.

- Full Worker suite: 289/289 passed.
- Repository, shell syntax, JavaScript syntax, and diff checks passed.
- Professional and broker images rebuilt successfully from the changed
  worktree.
- The real broker smoke returned:
  - `runner_broker_plan=pass`, plan digest
    `1517d319421083ba26c0391a0d2a2e2a95acb93957ef95093a1f24a1225b0b77`;
  - `runner_broker_changed_plan_rejected=pass` before execution;
  - authenticated client, revision sealing, exact replay, independent Assessor
    materialization, and read-only checks all passed;
  - invocation key
    `51e0378eae3c5386ddb80846b88dc39ea3dea6afc9654c39eecc00d3d992a1f3`
    and isolation policy digest
    `d0d53c34b2917b732746d1adb44b2349a195920a868d26918772a899bfa91bfb`
    were machine-captured;
  - Implementor and Assessor bound the same artifact digest
    `4c4f11dc044fdbee8440e51becc2dc147c4b297eed02f28a31c070e83312ddc2`;
  - unauthorized plan retrieval was rejected and Worker containers had no
    Docker socket;
  - `runner_broker_cleanup=pass` confirmed exact resource removal.

The professional tool schemas now contain only `taskId`. Plan retrieval is
peer-, Task-, run-, Worker-container-, image-, and network-bound and occurs
before the Worker invocation journal begins. Broker execution revalidates the
exact plan and both broker/Worker machine Evidence carry its digest. A plan
failure therefore cannot consume or poison the immutable command invocation.

This result proves the Runner boundary remediation only. A fresh real
AgentTeams professional Team is still required before claiming the prior model
command-contract failure or full delivery path resolved.
