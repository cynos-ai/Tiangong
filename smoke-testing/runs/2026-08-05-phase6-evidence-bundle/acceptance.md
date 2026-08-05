# Phase 6 evidence bundle

> Status: **BLOCKED / NOT ACCEPTED**

This bundle is the sanitized index of the Phase 5/6 machine evidence. It is
not a replacement for the underlying Project/Task bindings, ResultEnvelopes,
Runner receipts, deployment journal, approval state, or cleanup checks.

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

## Acceptance decision

Do not promote this bundle as complete Phase 5/6 acceptance. The missing
teammate-independent clean rerun remains open. The next run is permitted only
after a lower-level contract decision or regression result resolves the R5
input-reference mismatch; changing model prose or retrying the same Full smoke
is not evidence.

The machine facts, stable dispositions, cleanup result, and artifact digests
are indexed in [`manifest.json`](./manifest.json).
