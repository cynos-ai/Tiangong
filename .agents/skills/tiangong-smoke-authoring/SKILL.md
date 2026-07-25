---
name: tiangong-smoke-authoring
description: Design or maintain Tiangong smoke scenarios and focused regression plans. Use when writing Basic or Full smoke coverage, truth tables, expected machine evidence, side-effect ownership, cleanup proof, or promotion decisions under smoke-testing/.
license: Apache-2.0
---

# Tiangong smoke authoring

Treat smoke scenarios as versioned test assets. Test observable product risks, not preferred implementation style.

## Required workflow

1. Identify the contract and owning implementation.
2. Read the current code and deterministic tests before writing expectations.
3. Classify the scenario:
   - **Basic**: fast proof of the core real integration path;
   - **Full**: major safety, failure, recovery, and side-effect boundaries;
   - **focused**: one observed regression in `smoke-testing/runs/<date-name>/plan.md`.
4. Write prompts, expected observations, required machine evidence, blocked rules, resource ownership, and cleanup proof.
5. Build a boundary truth table when routing, authorization, Gate, Evidence selection, or recovery changes.
6. Check that every assertion uses a stable identifier or fact.
7. Promote focused coverage only when the risk is durable.

## Scenario shape

Use this structure for durable scenarios:

```markdown
# <Topic> smoke scenarios

## Ownership
- Related implementation:
- Related Skills:
- Related state/Evidence:
- Update triggers:

## Basic smoke
### B1: <name>
- Purpose:
- Setup:
- Prompt:
- Expected observations:
- Required evidence:
- Skip/block rules:

## Full smoke
### F1: <name>
...

## Maintenance notes
```

Do not add a focused section to a durable scenario. Keep one-off regression details in a run plan.

## Coverage rules

For a boundary change, cover the cells that distinguish the risk:

- intended pass;
- intended fail;
- adjacent normal path that must continue to pass;
- tempting weak-evidence or shortcut path;
- replay/retry path when state persists.

Separate these facts:

- user-visible Matrix delivery;
- model prose;
- Gate/state transition;
- backend execution;
- persistent Evidence;
- cleanup.

A model statement that a tool ran is not execution evidence. An agent-loop tool event alone is not proof of a backend side effect.

## Basic and Full limits

Basic smoke should use one or two low-cost scenarios and avoid destructive external effects. It should prove only the minimum official integration path.

Full smoke may use real Matrix, Gateway, restart, approval, or disposable cloud resources when those boundaries are the subject. Run deterministic and Basic checks first.

For external resources:

- use a unique or reserved test identity;
- refuse to replace existing resources;
- state the exact allowed resource scope;
- preserve sanitized evidence before cleanup;
- require cleanup proof;
- keep cleanup failure red.

## Assertion quality

- Correlate Evidence by the current approval, turn, invocation, or operation ID.
- Do not select files by traversal order.
- Do not use fixed sleeps as readiness proof when an observable readiness condition exists.
- Avoid exact model wording unless deterministic code owns the text.
- Include an explicit blocked path instead of fabricating unavailable evidence.
- Record model/provider overrides; do not silently switch to make a run pass.

## Promotion

- Core chain regression: promote to Basic.
- High-value safety or recovery boundary: promote to Full.
- One-off test-driver bug: keep in the run after fixing the durable oracle.
- Historical implementation detail: do not promote.

## Anti-patterns

- Do not rewrite expectations to turn a real failure green.
- Do not require private fixtures or internal repositories.
- Do not make every model mistake a runtime gate.
- Do not run Full smoke to prove a deterministic parser or state-machine fact.
