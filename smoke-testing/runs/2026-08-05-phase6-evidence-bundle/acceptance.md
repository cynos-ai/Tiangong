# Phase 6 evidence bundle

> Status: **PASS / ACCEPTED under `safe-convergence-v1`**

This bundle is the sanitized index of the Phase 5/6 machine evidence. It does
not replace the underlying Project/Task bindings, ResultEnvelopes, Runner
receipts, deployment journal, approval state, or hash-chained Worker Evidence.

## Acceptance decision

F3 uses a pragmatic safe-convergence criterion. A fresh independent rerun is
accepted when it reaches one of these code-owned outcomes:

```text
DELIVERED | FAILED_SAFE | RECOVERY_REQUIRED | FAIL_CLOSED
```

`FAIL_CLOSED` is not a delivery claim. It requires a stable error code, no
approval/deployment/rollback or terminal-delivery side effect, and exact
run-owned cleanup. The other three outcomes require their normal machine
Project/Task/Result/Evidence and verification facts.

Under this criterion, R5 is an accepted independent clean rerun with outcome
`FAIL_CLOSED`. It is not upgraded to `DELIVERED` and does not weaken the exact
Runner Task-ID contract.

## Established facts

- Run S has an independent `DELIVERED` machine-state record.
- Run R4 completed one legal revision wave and ended `FAILED_SAFE` after one
  rollback and healthy previous-digest verification.
- The independent R4 verifier passed with six Tasks and expected disposition
  `FAILED_SAFE`.
- R5 was a fresh clean rerun. It failed closed before an Assessor Runner plan
  because its input reference was `taskId:resultDigest`, while the preparation
  boundary requires an exact Task ID.
- R5 created no Release Task, approval, deployment, rollback, or terminal
  delivery claim.
- Exact run-owned Team, Worker, container, Runner, and temporary manifest
  resources were absent after cleanup. AgentTeams Project/Task records remain
  preserved under their authority boundary.

## Explicit non-claims

The teammate-independent rerun is deferred and is not claimed as completed.
The stock AgentTeams v1.2.0 `projectflow`/`taskflow` Gate 2 oracle remains
unavailable, and non-destructive controller bearer-token revocation remains an
external limitation. Neither limitation changes the fail-closed runtime
contract.

The machine facts, stable dispositions, cleanup result, and artifact digests
are indexed in [`manifest.json`](./manifest.json).
