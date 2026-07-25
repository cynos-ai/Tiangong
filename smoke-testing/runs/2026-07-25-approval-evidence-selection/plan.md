# Approval Evidence selection regression run

## Purpose

Diagnose and close the case where Matrix pending, restart recovery, approval, file creation, and replay responses pass, but the final exactly-once Evidence assertion selects the wrong session chain or reports unexpected counts.

## Scope

- Do not change Gate or execution semantics merely to satisfy the smoke.
- Reuse one clean reserved Worker.
- Locate Evidence by the current `approvalId`, never by filesystem traversal order.
- Print execution and replay counts before asserting.
- Preserve only sanitized output; never archive Worker credentials, write content, Matrix access tokens, or unrestricted session transcripts.

## Setup

1. Confirm no `tiangong-pi-smoke` Worker or container exists.
2. Purge and verify empty only the reserved MinIO prefix:
   `agentteams/agentteams-storage/agents/tiangong-pi-smoke/`.
3. Run Worker unit tests and shell syntax checks.
4. Run `make test-worker-image` once.

## Expected observations

- `matrix_write_pending=pass`
- `matrix_write_approve=pass`
- `matrix_write_restart_recovery=pass`
- `matrix_write_replay=pass`
- exactly one `events.jsonl` contains the current approval ID
- `write_execution_count=1`
- `write_replay_count=1`
- `matrix_write_exactly_once=pass`
- no temporary Worker, container, Manager helper, or reserved MinIO prefix remains

## Failure triage

| Observation | Interpretation | Next check |
|---|---|---|
| More than one matching Evidence file | approval identifier collision or stale smoke storage | verify prefix purge and approval ID generation |
| Execution count greater than one | real idempotency failure | inspect idempotency transitions and operation digest before changing test |
| Replay count zero with replay Matrix response | runtime reported replay without recording it, or recorder wrote another chain | inspect approval-specific state and recorder instance |
| Counts correct but assertion fails | shell normalization/selection bug | print quoted values and remove traversal-order assumptions |
| Cleanup fails | smoke ownership failure | leave failure red; do not hide with best-effort cleanup |

## Result

Passed on 2026-07-25 with Node.js `22.23.1`, pi `0.82.0`, and `agentteams-gateway/qwen3.5-plus`:

```text
matrix_write_pending=pass
matrix_write_approve=pass
matrix_write_restart_recovery=pass
matrix_write_replay=pass
write_execution_count=1
write_replay_count=1
matrix_write_exactly_once=pass
```

The failure was in the smoke assertion: it selected the first Evidence file by traversal order. The durable fix locates exactly one chain containing the current approval ID before counting execution and replay events. Separate readiness races were removed by waiting for both OpenClaw health and the Matrix room-join/Worker-ready observations before sending turns.

## Promotion decision

The approval-specific Evidence lookup and printed counts belong in the durable Full scenario because multiple persistent sessions per Worker are normal. This run plan remains as the historical regression procedure.
