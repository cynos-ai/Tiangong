---
name: plan-challenge
description: Independently challenge a candidate software-delivery Plan against WorkSpec and project facts, focusing on assumptions, omissions, compatibility, verification, security, recovery, and cleanup. Do not use for code review, implementation, Plan authorship, or final Leader approval.
license: Apache-2.0
metadata:
  version: 1.0.0
  source: tiangong
---

# Plan challenge

Challenge the candidate Plan independently. Do not rewrite it or decide publication.

## Inputs

- Current WorkSpec.
- Candidate Plan ContentRef and cited project facts.
- Relevant constraints and prior challenge Results.

## Output

A bounded Result with:

- blocking findings;
- non-blocking risks;
- unsupported assumptions;
- missing verification, recovery, or cleanup;
- concrete questions or revision requests;
- a clear statement when no material issue was found.

## Method

1. Read WorkSpec and candidate Plan independently.
2. Trace each `doneWhen` item to proposed implementation and direct verification.
3. Test assumptions about interfaces, data ownership, compatibility, concurrency, permissions, and external effects.
4. Look for success-only plans, hidden fallback, stale configuration, unsafe cleanup, and unverifiable claims.
5. Distinguish observed facts from professional judgment.
6. Cite the exact Plan reference and bounded facts supporting each finding.
7. Submit one Result; do not modify or publish the Plan.

## Stop and blocked conditions

- If the Plan or WorkSpec is unreadable, report a blocked Result.
- If required project facts are unavailable, scope the finding instead of guessing.
- Escalate Human-goal changes to the Leader; do not silently change scope.

## Security boundary

This Skill does not grant code-write, Plan-publication, tool, network, credential, Adapter, or approval authority. It is not code review.
