---
name: work-coordination
description: Coordinate a bounded Tiangong Work when a Leader must form or revise WorkSpec, choose whether to ask a Human, delegate dynamic Tasks, synthesize Results, or complete or stop the Work. Do not use for writing a technical Plan, challenging a Plan, implementing code, code review, or scenario testing.
license: Apache-2.0
metadata:
  version: 1.0.0
  source: tiangong
---

# Work coordination

Coordinate one Work from durable facts. Do not invent progress from chat or model prose.

## Inputs

- Current Work, title, epoch, WorkSpec, Plan reference, Task and Result projections.
- The authenticated Human request and later clarifications from Matrix.
- Enabled MemberConfig summaries and current machine guards.

## Outputs

- A bounded title and complete WorkSpec when the request is sufficiently clear.
- Dynamic TaskSpecs assigned to suitable enabled members.
- A Human clarification question only for material ambiguity.
- A justified `complete-work` or `stop-work` command when machine guards allow it.

## Method

1. Read the current Work projection; do not rely on stale prompt copies.
2. Separate the Human goal, scope, constraints, done conditions, and unresolved assumptions.
3. Form WorkSpec directly when ambiguity is not material. Ask the Human when different answers would change goal, scope, constraints, or acceptance.
4. For software delivery, ensure a current Plan exists before implementation. Use `work-planning` when planning is needed.
5. Create only the next cohesive professional Task. Keep TaskSpec self-contained and include immutable Plan ContentRefs when relevant.
6. Wait for a Developer Result before creating independent Reviewer or Tester Tasks that depend on that change.
7. Compare Results and ToolResults with `doneWhen`. Create a follow-up Task for a real gap; do not edit another member's Result.
8. Complete or stop only through the Leader command after checking all Tasks and machine guards.

## Stop and blocked conditions

- If WorkSpec is null and material meaning is unclear, ask the Human; do not create a Task.
- If an assignee is disabled or lacks the required package/capability, report the gap.
- If an active execution, unresolved Operation/Approval, unreadable ContentRef, or unreported Task blocks closure, leave the Work open.
- Never treat ordinary chat as Approval or as proof of a machine effect.

## Security boundary

This Skill does not grant tools, credentials, paths, network access, deployment rights, or production authority. It cannot change MemberConfig, install Skills, move facts between Works, or bypass CloseGuard.
