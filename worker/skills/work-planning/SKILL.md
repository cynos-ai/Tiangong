---
name: work-planning
description: Create or revise a shared Markdown software-delivery Plan from an existing WorkSpec and project facts, including scope, approach, verification, risks, and rollback. Use for planning, not for Work routing, Plan challenge, implementation, code review, or maintaining progress percentages.
license: Apache-2.0
metadata:
  version: 1.0.0
  source: tiangong
---

# Work planning

Produce an immutable Markdown Plan ContentRef. Keep execution state in Tasks and Results, not in the Plan.

## Inputs

- Current WorkSpec and any previous Plan ContentRef.
- Bounded repository, dependency, interface, test, and deployment facts available to the member.
- Prior Challenger Result when revising a candidate Plan.

## Output

A concise Markdown Plan covering:

- goal and non-goals;
- affected boundaries and assumptions;
- proposed approach and ordered implementation slices;
- verification and failure-path checks;
- security, compatibility, recovery, and cleanup risks;
- questions that require Human clarification.

## Method

1. Verify that WorkSpec exists. Stop if goal or done conditions are absent.
2. Inspect only authorized project facts. Mark unverified assumptions explicitly.
3. Prefer the smallest vertical slices that each leave runnable behavior.
4. Distinguish product semantics, machine controls, tests, and rollout concerns.
5. Include exact cheap verification before expensive integration runs.
6. If revising, answer each relevant Challenger finding and identify any new technical route.
7. Write the Plan to an immutable ContentRef. Do not publish `currentPlanRef`; only the Leader does that.

## Stop and blocked conditions

- Ask the Leader to clarify WorkSpec when materially different plans remain plausible.
- Report unavailable repository or test evidence instead of fabricating it.
- Do not publish a major candidate before independent challenge when the Work requires it.

## Security boundary

This Skill is planning guidance only. It grants no filesystem, network, model, tool, credential, Adapter, approval, or publication authority.
