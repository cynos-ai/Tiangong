# Phase 5 Run R3 — revision wave and safe rollback

> Date: 2026-08-05
> Level: focused Full AgentTeams/Matrix/Runner/deployment integration
> Status: PARTIAL (revision exhaustion/recovery passed; rollback correctly not attempted)

## Scope

Fresh exact-scope Team `tg-p5r3-08050720`, five role-scoped Workers, fixed
Runner broker, new Project, new Evidence root, and a fault-injected disposable
deployment target. No R2 Task, Result, approval, journal, target, or artifact
is reused. Provider/model and the fixed Runner command remain unchanged.

## New hypothesis

R2 proved the rollback path but its first Assessor accepted revision 0. This
run uses a bounded incomplete-design fixture objective: the Designer must leave
one named acceptance criterion unresolved, and the first Assessor must return a
revision request for that criterion. The Leader must then dispatch a new
Implementor and Assessor wave at revision 1. This is a focused revision-path
check, not permission to fabricate machine state.

The read-only `professional-readiness-probe.sh` must pass before the first
Task notification. A deterministic post-verify fault is configured only after
the final accepted revision is materialized.

## Machine result

The corrected first wave produced the following immutable chain:

- Design revision 0: accepted.
- Implement revision 0: accepted.
- Assessor revision 0: `revision`, with a bound request for the named
  `REVISION_SENTINEL` criterion.
- Implement revision 1: accepted.
- Assessor revision 1: `revision`.
- Implement revision 2: accepted.
- Assessor revision 2: `revision` at the bounded maximum.
- Leader terminal report: `RECOVERY_REQUIRED`, report digest
  `c5a053cf1165b0c95f7e85aa8f8fd8e8df0850220989bf6d8e4396db17bf91b9`.

The independent verifier passed with `taskCount=7`, chain status `blocked` at
Assessor revision 2, and expected disposition `RECOVERY_REQUIRED`; its
sanitized output is `verify.json` in this run directory. No Release
Task, approval, deployment, or rollback was created, which is the required
fail-closed result for an exhausted revision chain.

## Stop and cleanup

Any missing readiness, immutable revision binding, Result, approval,
deployment, rollback, Evidence, requester report, or cleanup fact is
fail-closed. Clean only exact run-owned resources. Preserve AgentTeams-owned
Project/Task records and never uninstall/rebootstrap local AgentTeams.

Cleanup passed: the exact Runner broker and volumes, Team, five Workers,
short-lived cleanup helper, exact Worker containers, and temporary manifests
were absent after cleanup. The seven AgentTeams-owned Project/Task records are
retained under the authority boundary. No deployment target or approval was
created.

This run closes the bounded revision-wave and `RECOVERY_REQUIRED` behavior,
but not the combined revision-plus-`FAILED_SAFE` Full claim. R2 is the
separate safe-rollback result.
