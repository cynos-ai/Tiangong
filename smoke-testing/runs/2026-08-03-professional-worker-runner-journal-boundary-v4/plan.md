# Worker RunnerJournal completion boundary v4

> Date: 2026-08-03
> Level: focused real AgentTeams/Matrix/Runner integration
> Status: FAIL-CLOSED (runtime sync overwrote journal)

## Scope

Fresh Team `tg-pause4-834457` covered the cross-session path after the
Worker-scoped RunnerJournal change: Implementor initialization DM, exact pause,
Leader Project/Designer/Implement Task dispatch, immutable broker readiness,
exactly one unpause, Runner execution, and bound Result submission.

## Fixed contract

Pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`,
`deepseek-v4-flash`, fixed fixture, command `["node","probe.mjs"]`, timeout
`30000`, output limit `65536`, fixed images, no exploration, replay, retry,
manual Result, or Full delivery.

## Result

**FAIL-CLOSED / no `DELIVERED`.**

`make up` and `make verify` passed. The exact Implementor had one persistent
Tiangong session before pause. Project and accepted Designer setup succeeded;
the Implement Task was dispatched while paused. The broker reported ready
before exactly one unpause.

Worker Evidence recorded exactly one plan request, one plan response, zero
plan failures, and one successful `run_command` completion. The fixed command
and sealed artifact were produced. However, the Worker RunnerJournal remained
`executing`, and `team_submit_result` could not bind the returned
ChangeRevision: `ChangeRevision is not bound to a completed Runner invocation`.
No accepted Implement Result was produced.

The observed source-level cause is the active `TeamSync.beforeRead` whole
workspace mirror. It can pull a stale remote `.tiangong/runtime` tree before
Result validation and overwrite the just-completed local RunnerJournal. The
Worker-scoped journal change alone therefore did not close this boundary.
The code fix is in the working tree but was not part of this run; it must be
tested before any Full retry.

No Assessor, release, approval, deployment, requester delivery, or
`DELIVERED` side effect occurred. No journal repair or command replay was
performed.

### Cleanup

The exact Runner broker and three exact Runner volumes were removed. Native
Team deletion passed. The supported uninstall again left the four exact Worker
containers; only those exact names were manually removed. Final checks found
zero `agentteams-*` containers, networks, or volumes, zero `pause4-834457`
resources, no generated Manager environment, and no install log. Physical
cleanup is PASS after known upstream residue.

## Follow-up

Rebuild and rerun the focused boundary with the shared-only `beforeRead`
synchronizer. Require the Worker journal to be `completed` and the accepted
Implement Result before authorizing another Full smoke.
