# Implementation rules

> Status: target engineering rules. Existing code may lag behind these rules;
> do not claim compliance without verification.

Use these rules for code, scripts, refactors, and bug fixes.

## Before editing

- Read the relevant implementation, callers, tests, types, and external
  contract. Do not guess behavior that can be verified.
- Search for an existing implementation before adding a helper, abstraction,
  dependency, or configuration path.
- Identify the layer that owns the behavior. Keep Channel Plane concerns in
  OpenClaw integration and Agent Plane concerns in Tiangong.

## While editing

- Change one observable boundary at a time and keep the system runnable between
  increments.
- Solve the requested problem only. Do not combine a fix with unrelated cleanup,
  dependency upgrades, or style rewrites.
- Prefer deletion and direct code over compatibility layers or speculative
  frameworks during initialization.
- Reuse public, maintained dependencies when they satisfy the contract; do not
  recreate a protocol casually.
- Preserve explicit errors. Do not silently swallow failures that affect
  correctness. Best-effort diagnostics may ignore their own failure only when
  the primary operation remains authoritative and the intent is documented.
- Do not leave core behavior as TODOs, mocked success, placeholder output, or
  model-only instructions.
- Before adding a Kernel Gate, field, or state, identify the concrete threat or
  race, why a Skill, MemberConfig, Adapter, or external system is insufficient,
  how code verifies the property, and what friction it adds for agents.

## High-risk changes

For authorization, credentials, persistence, recovery, filesystem writes, dependency resolution, or public contracts:

1. Search all callers and state transitions.
2. Define the fail-closed behavior.
3. Add deterministic positive, negative, and adjacent-path tests.
4. Identify recovery and reconciliation behavior before enabling the side
   effect; treat a later retry or rollback as a new Operation unless the
   immutable request defines immediate compensation.

## Completion

- Re-read the changed files and inspect the final diff.
- Distinguish implemented behavior, target contracts, and known gaps explicitly;
  never present a target design or rule as proof that runtime behavior already
  exists.
- Keep architecture decisions explicit when they become stable public facts.
