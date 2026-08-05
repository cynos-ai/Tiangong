# Professional Worker ingress readiness probe

> Date: 2026-08-05
> Level: focused lower-layer AgentTeams/Matrix readiness regression
> Status: PASS (readiness only; no model turn)

## Purpose

Exercise the deterministic readiness boundary added after the failed Phase 5
Run R. This probe does not send a model prompt, create a Project or Task, or
claim professional delivery. It verifies only that the exact five Worker
containers, OpenClaw health, Worker room bindings, and authenticated Team-room
membership are ready before a future Full smoke notification.

## Scope

Reserved Team identity: `tg-prp-08050630`.
Reserved Workers: `tg-prp-08050630-{leader,designer,implementor,assessor,operator}`.
The probe uses the existing pinned local Worker images and the configured
`deepseek-v4-flash` model metadata but does not start a model turn.

## Required facts

- `agt` reports one Active Team with `leaderReady=true` and `readyWorkers=4/4`.
- All five exact Worker resources report `Running` with the expected role.
- All five exact Worker containers are running and pass `openclaw health`.
- Each Worker room ID matches its AgentTeams resource and its fixed runtime
  environment.
- Each Worker authenticates to Matrix and sees all five expected Team members
  in the Team room.
- The probe prints only bounded stable status; bearer tokens and Matrix payloads
  are not printed or persisted.

## Result

The probe printed:

```text
professional_readiness=pass team=tg-prp-08050630 workers=5 matrix_members=5
```

No Matrix prompt, Project, Task, ResultEnvelope, Runner invocation, approval,
deployment, or model turn was created. This closes the lower-layer readiness
hypothesis for a future Full smoke; it does not upgrade the failed Run R.

## Cleanup

The exact Team, five exact Worker records, exact containers, and temporary
manifests were removed and verified absent. The supported membership cleanup
required detaching the four Workers and using a short-lived exact-scope helper
to detach the original Leader. No uninstall, rebootstrap, or shared
`projects/`/`tasks/` deletion was performed.
