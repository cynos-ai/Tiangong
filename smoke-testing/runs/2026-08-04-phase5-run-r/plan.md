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
- The first supported Team deletion attempt reported deletion, but AgentTeams
  kept the exact Team and five stopped Worker records in its controller state.
  The shared Project/Task records are retained because AgentTeams owns that
  namespace and Tiangong must not erase them as speculative cleanup.

### Post-attempt exact-scope remediation

After the failed smoke was preserved, the supported AgentTeams membership
operation was diagnosed without changing the functional verdict: the Team was
updated to an empty Worker roster, the four detached Workers were deleted, a
short-lived exact-scope cleanup Leader was assigned so the original Leader
could be detached and deleted, and the helper was then deleted. No local
AgentTeams uninstall, volume deletion, or rebootstrap was performed.

Final machine facts after remediation:

- Team record `tg-p5r-08041721`: absent.
- Worker records with prefix `tg-p5r-08041721`: absent, including the cleanup
  helper.
- Exact run-owned Worker containers: absent.
- Runner broker and volumes: absent.
- AgentTeams-owned Project/Task records: retained by boundary.

The original cleanup failure remains part of the run history, but the exact
Team/Worker residue is now cleared. The overall run remains **FAIL-CLOSED**
because no Designer ResultEnvelope or terminal delivery evidence was ever
created.

## Stop rule

Do not retry this Full scenario by changing the model, prompt, fixture, or
Task identity. First add a deterministic lower-layer ingress/readiness probe
and obtain an upstream-supported exact Team/Worker cleanup operation. The
successful Run S remains independently recorded at
`smoke-testing/runs/2026-08-04-professional-delivery-full-after-cross-turn-approval-dedupe/plan.md`.
