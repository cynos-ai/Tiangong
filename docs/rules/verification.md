# Verification rules

> Status: target engineering rules. Existing code may lag behind these rules;
> do not claim compliance without verification.

Use these rules for tests, CI, smoke scenarios, external resources, machine-fact
proof, and cleanup.

## Test order

Start with the cheapest layer that can prove the claim:

1. syntax, schema, and static policy checks;
2. focused unit and deterministic contract tests;
3. package or container checks;
4. Basic smoke for the core real integration path;
5. focused regression run for one observed failure;
6. Full smoke for a milestone, release, or relevant safety-boundary change.

Do not use a real model or Matrix turn to prove a state-machine, authorization,
idempotency, concurrency, or recovery fact which a deterministic fixture can
establish.

## Contract coverage

- For each hard control, test the allowed path, denied path, and nearest
  race/replay/revocation path.
- Prove facts from their direct source: Work timeline and projection, Result,
  ToolResult, ContentRef, Operation and its events, current configuration, or
  external-system observation.
- Do not require a generic Evidence object, evidence chain, machine-evidence
  wrapper, fixed Assessor, verification Result subtype, or model verdict.
- Keep Human or Leader statements, model prose, machine state, tool
  observations, and external postconditions distinct in fixtures and reports.
- Test UI states as projections of source facts rather than as an independent
  Task workflow state machine.
- When implementation lags behind a target rule, report the gap explicitly. A
  target design, test plan, or skipped test is not proof of implementation.

## External-effect and recovery proof

- Verify that immutable Operation creation, exact Approval when policy requires
  it, execution start, Adapter invocation, and terminal or unresolved events
  occur in the required order.
- Prove that ordinary chat, stale policy, changed request content, expired
  Approval, duplicate commands, and late events cannot authorize an effect.
- Prove that execution start is durable before the external call and that a
  started Operation is never blindly replayed.
- Require Adapter-observed postconditions for success and confirmed absence of
  unresolved lasting effects for safe failure. Transport success alone is not
  sufficient.
- Exercise timeout or lost-response paths as uncertainty. Verify that
  uncertainty blocks conflicting writes and Work termination until privileged
  read-only reconciliation or a controlled recovery Operation resolves it.
- Treat every later retry or rollback as a new Operation unless the original
  immutable request and preview fully specify immediate compensation.

## Execution-boundary proof

- Verify effective authority against current identity/route, ControlProfile,
  MemberConfig, and runtime binding at activation, new turn, local tool call,
  and Adapter call boundaries.
- Test actual mount, writable-root, cwd, network, and credential isolation, not
  only requested configuration or prompt instructions.
- Verify that child processes inherit the same path, resource, credential, and
  egress restrictions as the parent Bash process.
- Prove one active execution owner per Task and one active writer per writable
  root, including cancellation and replacement races.
- Test that cancellation and budget termination stop the complete process tree
  and do not hide a started unresolved Operation.

## Failure discipline

- First failure: classify the failing layer and form a testable hypothesis.
- Second failure of the same class: add direct diagnostics or a lower-level
  regression test.
- Do not run a third expensive Full smoke without new evidence.
- Change one variable per debugging attempt.
- Preserve bounded sanitized source records needed for diagnosis before
  cleanup. Do not preserve secrets or unrestricted payloads as proof.

## Smoke assets

- `smoke-testing/scenarios/` contains durable Basic and Full scenarios.
- `smoke-testing/runs/` contains focused, one-off regression plans and results.
- `smoke-testing/support/` contains test-only drivers; it is not a public
  runtime API.
- `smoke-testing/fixtures/` contains clearly owned, disposable fixtures.
- Promote a focused test only when it represents a durable product risk.
- Assert observable behavior and stable identifiers, not filesystem traversal
  order, timing luck, model prose, or unrelated implementation details.
- Use review, challenge, testing, or other professional Tasks only when the
  scenario needs them. Do not make a fixed multi-role workflow the smoke
  harness's universal success condition.

## External resources and cleanup

- Use a unique or explicitly reserved test identity.
- Refuse to replace an existing resource unless the scenario explicitly owns
  it.
- Record the exact resources created by the run.
- Clean only those resources and verify their absence afterward.
- Never broaden cleanup paths from user-controlled input.
- A cleanup failure keeps the run red.

## Completion report

A passing check must identify the direct machine facts which prove its claim.
Keep model responses, persistent coordination facts, ToolResults, external
observations, and user-visible delivery distinct. A report summarizes those
facts; it is not a substitute for them.
