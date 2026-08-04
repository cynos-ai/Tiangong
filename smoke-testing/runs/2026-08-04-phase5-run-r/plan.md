# Phase 5 Run R rollback smoke attempt

> Date: 2026-08-04
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (bounded Worker ingress did not produce a professional Result; cleanup remained blocked)

## Scope

This attempt reserved a fresh five-role Team and Project for the Run R
revision/approval/rollback contract. It did not reuse the earlier successful
Run S resources, Tasks, Results, approval, deployment target, or journals.

Provider/model was the configured `openai-compat` / `deepseek-v4-flash` pair.
The Runner broker used the pinned local images and the fixed
`runner-isolation` fixture. No credentials, raw model response, transcript, or
unrestricted log was retained in this report.

## Machine facts

- `make verify` passed before and after the attempt.
- Five Worker resources reached `Running`; the Team reached `Active` with
  `readyWorkers=4/4` and `leaderReady=true`.
- The Runner broker reached `runner_broker=ready` with exact run-owned labels.
- The authenticated Leader created Project `p5r-08041721-project` and the
  immutable design Task `p5r-08041721-design-0`; both bindings were present in
  the AgentTeams shared namespace.
- No ResultEnvelope, transition decision, ChangeRevisionRef, Assess Task,
  Release Task, approval, deployment target, or deployment journal was
  created.
- A direct administrator prompt to the Designer was rejected by the
  code-owned Project-Leader actor check. A later replayed Leader dispatch after
  Team readiness was accepted as an idempotent dispatch, but no bounded
  Designer model turn produced a ResultEnvelope.

## Classification

The functional stop is classified as **environment/model/ingress readiness**,
not as a delivery success or a product authorization bypass. The stop occurred
before any professional side effect. Per smoke rules, no third Full run is
launched without a new lower-level hypothesis and regression evidence.

## Cleanup

- The exact Runner broker, volumes, and temporary files were removed.
- Exact run-owned Worker containers were removed after their names were
  verified; no other containers were touched.
- The supported Team deletion command reported deletion, but AgentTeams kept
  the exact Team and five stopped Worker records in its controller state. The
  shared Project/Task records are retained because AgentTeams owns that
  namespace and Tiangong must not erase them as speculative cleanup.
- Overall cleanup is **FAIL** and keeps this run red. This reproduces the
  known upstream Team member-release/deletion boundary; the residue is
  explicitly named and no success claim is derived from the cleanup attempt.

## Stop rule

Do not retry this Full scenario by changing the model, prompt, fixture, or
Task identity. First add a deterministic lower-layer ingress/readiness probe
and obtain an upstream-supported exact Team/Worker cleanup operation. The
successful Run S remains independently recorded at
`smoke-testing/runs/2026-08-04-professional-delivery-full-after-cross-turn-approval-dedupe/plan.md`.
