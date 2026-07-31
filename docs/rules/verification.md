# Verification rules

Use these rules for tests, CI, smoke scenarios, external resources, and cleanup.

## Test order

Start with the cheapest layer that can prove the claim:

1. syntax, schema, and static policy checks;
2. focused unit and deterministic contract tests;
3. package or container checks;
4. Basic smoke for the core real integration path;
5. focused regression run for one observed failure;
6. Full smoke for milestone, release, or relevant safety-boundary changes.

Do not use a real model or Matrix turn to prove a state-machine fact that a deterministic fixture can establish.

## Failure discipline

- First failure: classify the failing layer and form a testable hypothesis.
- Second failure of the same class: add direct diagnostics or a lower-level regression test.
- Do not run a third expensive Full smoke without new evidence.
- Change one variable per debugging attempt.
- Preserve sanitized evidence before cleanup when it is needed to diagnose a failure.

## Smoke assets

- `smoke-testing/scenarios/` contains durable Basic and Full scenarios.
- `smoke-testing/runs/` contains focused, one-off regression plans and results.
- `smoke-testing/support/` contains test-only drivers; it is not a public runtime API.
- `smoke-testing/fixtures/` contains clearly owned, disposable fixtures.
- Promote a focused test only when it represents a durable product risk.
- Assert observable behavior and stable identifiers, not filesystem traversal order, timing luck, model prose, or unrelated implementation details.

## External resources and cleanup

- Use a unique or explicitly reserved test identity.
- Refuse to replace an existing resource unless the scenario explicitly owns it.
- Record the exact resources created by the run.
- Clean only those resources and verify their absence afterward.
- Never broaden cleanup paths from user-controlled input.
- A cleanup failure keeps the run red.

## Evidence

A passing smoke must identify the machine facts that prove it. Keep model responses, persistent state, tool execution evidence, and user-visible delivery distinct. A report is a summary, not a substitute for the underlying facts.
