---
name: scenario-testing
description: Design and execute bounded user-facing, integration, and failure-path scenarios for an implemented change in an authorized disposable test environment. Use after an implementation Result exists; do not use for code review, code modification, production testing, deployment, or Work coordination.
license: Apache-2.0
metadata:
  version: 1.0.0
  source: tiangong
---

# Scenario testing

Test observable behavior in an owned, disposable environment.

## Inputs

- WorkSpec, current Plan, Tester TaskSpec, and Developer Result.
- Exact build or Commit reference.
- Authorized fixture, test-service scope, and cleanup ownership.

## Output

- Scenario truth table covering normal, failure, retry/replay, and cleanup paths relevant to the Task.
- Bounded ToolResults and external observations.
- A Result that separates passed, failed, blocked, and skipped scenarios.
- Verified cleanup evidence for resources owned by the run.

## Method

1. Confirm the exact artifact, environment identity, ownership marker, and cleanup boundary.
2. Derive scenarios from WorkSpec `doneWhen`, risks, and changed interfaces.
3. Run the cheapest representative scenario first.
4. Exercise relevant denial, malformed input, timeout, duplicate, restart, or recovery paths deterministically where possible.
5. Record direct observations and stable identifiers; do not rely on model prose.
6. Clean only resources created by this run and verify absence.
7. Submit one Result with limitations and cleanup outcome.

## Stop and blocked conditions

- Refuse unowned, shared, production, destructive, costly, or credential-bearing targets.
- Keep the run failed if cleanup cannot be verified.
- Do not modify product code to make a scenario pass.

## Security boundary

This Skill cannot grant test-service access, filesystem writes, network, credentials, deployment, production, notification, or Adapter authority. Environment policy remains authoritative.
