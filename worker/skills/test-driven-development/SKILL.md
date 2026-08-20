---
name: test-driven-development
description: Implement a bounded software change in an assigned writable workspace by reproducing the failure, adding or selecting a focused test, making the smallest code change, running verification, and creating a local Commit. Do not use for planning, independent review, deployment, push, or production repair.
license: Apache-2.0
metadata:
  version: 1.0.0
  source: tiangong
---

# Test-driven development

Implement only the assigned Task in the prepared execution boundary.

## Inputs

- Immutable TaskSpec, current WorkSpec, and Plan ContentRefs.
- Assigned repository/worktree and allowed local execution tools.
- Existing tests and project contribution rules.

## Outputs

- Reproduction evidence or an explicit reason reproduction is impossible.
- Focused code and test changes.
- Bounded ToolResults for relevant checks.
- One local Commit ContentRef and a Result summarizing changes and limitations.

## Method

1. Confirm repository, exact base commit, worktree, Task, and writable-root ownership.
2. Reproduce the failure with the cheapest deterministic test. Preserve the bounded failing observation.
3. Add or identify a test that fails for the intended reason.
4. Implement the smallest cohesive fix; do not broaden scope opportunistically.
5. Run the focused test, then the required adjacent regression checks.
6. Inspect the diff for generated files, secrets, unrelated edits, and unsafe dependencies.
7. Create a local signed-off Commit only when repository policy requires and allows it. Do not push.
8. Submit a Result citing the Commit and ToolResults. State skipped or unavailable verification explicitly.

## Stop and blocked conditions

- Stop on workspace identity, ownership, path, credential, or network mismatch.
- Do not weaken tests to manufacture success.
- Do not proceed to deployment, production writes, external notifications, or push.
- If the task materially differs from WorkSpec or Plan, report the mismatch to the Leader.

## Security boundary

This Skill cannot grant write access, Bash, network, credentials, package sources, push, deployment, or production authority. Those remain enforced by MemberConfig, ControlProfile, runtime binding, and Adapters.
