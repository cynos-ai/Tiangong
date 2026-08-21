---
name: independent-code-review
description: Independently review a completed software change and its tests against WorkSpec, TaskSpec, Plan, diff, and direct machine observations. Use after an implementation Result exists; do not use to edit code, challenge an unimplemented Plan, run deployment, or approve production.
license: Apache-2.0
metadata:
  version: 1.0.0
  source: tiangong
---

# Independent code review

Review the submitted change without modifying it.

## Inputs

- WorkSpec, current Plan, review TaskSpec, and Developer Result.
- Exact repository and Commit/diff ContentRefs.
- Relevant ToolResults and test observations.

## Output

A Result separating:

- blocking correctness or security findings;
- compatibility and maintainability risks;
- missing tests or requirements;
- non-blocking suggestions;
- the facts inspected and any unavailable evidence.

## Method

1. Confirm that the Developer Result and exact Commit are available.
2. Map WorkSpec `doneWhen` and Task objective to changed behavior and tests.
3. Inspect the diff independently for correctness, error handling, authorization, races, data boundaries, and cleanup.
4. Treat test output as an observation, not proof of untested behavior.
5. Check for unrelated edits, hidden dependencies, credentials, and weakened controls.
6. Run only authorized read-only or test commands when needed.
7. Submit one review Result. The Leader decides follow-up or completion.

## Stop and blocked conditions

- Report blocked when the Commit, diff, WorkSpec, or required ToolResult cannot be read.
- Do not modify the reviewed worktree or silently repair findings.
- Do not approve deployment or production effects.

## Security boundary

This Skill grants no write, merge, push, deployment, approval, credential, network, or Adapter authority. Professional judgment remains distinct from machine facts.
