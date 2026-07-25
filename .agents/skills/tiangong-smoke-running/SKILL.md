---
name: tiangong-smoke-running
description: Plan, execute, diagnose, and report Tiangong smoke runs. Use when running Basic, Full, or focused Worker and Matrix smoke tests; collecting sanitized diagnostics; classifying failures; preserving Evidence; or verifying cleanup.
license: Apache-2.0
compatibility: Requires the Tiangong repository, Docker, jq, curl, and a configured local AgentTeams stack for real integration smoke.
---

# Tiangong smoke running

Act as the orchestrator and evidence reviewer. Do not impersonate the tested Worker or edit product code during an active run to help it pass.

## Before running

1. Read the active scenario or create a focused run plan.
2. Record scope, level, model/provider, target identity, prerequisites, owned resources, timeout, blocked rules, and cleanup.
3. Check the relevant deterministic tests first.
4. Confirm the local AgentTeams stack with `make verify` for integration smoke.
5. Refuse to replace an existing reserved smoke Worker.

## Execution order

Use the cheapest proving layer first:

```text
make check-skills or focused static checks
worker unit/contract tests
shell and workflow checks
make test-worker-image-basic
focused regression phase
make test-worker-image
```

Skip irrelevant layers only when the run plan explains why.

## Failure discipline

- On the first failure, identify the failing layer and write one testable hypothesis.
- On the second failure of the same class, stop and add direct diagnostics or a lower-level regression test.
- Do not launch a third Full smoke without new evidence.
- Change one variable per attempt.
- Do not silently change provider, model, prompt, fixture, timeout, or isolation.
- Keep fail-closed product behavior distinct from test-driver failure. A timeout does not prove unauthorized execution.

## Diagnostics

Capture the smallest sanitized bundle needed to reconstruct the failure:

- image ID and pinned component versions;
- Worker phase and readiness observations;
- Harness status and stable error code;
- current approval ID and non-sensitive state status;
- matching Evidence path, tail hashes, and event counts;
- cleanup result.

Do not capture credentials, raw provider configuration, unrestricted logs, raw write content, or complete session transcripts.

Read facts in this order:

1. machine state and raw Evidence records;
2. current source and deterministic tests;
3. smoke report;
4. model transcript only when behavior, not execution fact, matters.

Classify each issue as product, adapter/host contract, environment/model, scenario, test driver/oracle, readiness, cleanup/ownership, or overfitted expectation before recommending a change.

## Real Worker smoke

- `make test-worker-image-basic` proves the pinned Worker, official Matrix delivery, Tiangong Harness, gated read, persistent session, and credential boundary.
- `make test-worker-image` adds pending write, restart recovery, approval, replay, exactly-once Evidence, and cleanup proof.
- Use only the reserved `tiangong-pi-smoke` identity and its exact storage prefix.
- Treat Worker `Running`, container running, OpenClaw health, and Matrix readiness as separate observations.
- Correlate state and Evidence by the current stable ID.

## Cleanup

Always attempt cleanup, even after failure. Delete only resources recorded as owned by the run. Verify Worker, container, copied helpers, and reserved storage are absent. If cleanup fails, keep the run failed and report the exact residue.

## Report

Record:

- scenario and level;
- commands and any declared deviation;
- provider/model;
- pass/fail/blocked per boundary;
- machine evidence and stable IDs without sensitive payloads;
- failure classification and confidence;
- cleanup proof;
- smallest follow-up action and what not to change.

A report conclusion is a hypothesis until it is re-derived from machine Evidence or source.
