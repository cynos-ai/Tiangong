# Worker RunnerJournal completion boundary v5

> Date: 2026-08-03
> Level: focused real AgentTeams/Matrix/Runner integration
> Status: PASS (focused boundary; Full delivery authorized)

## Scope

Fresh Team `tg-pause5-6af688` covered the cross-session path after the
shared-only `TeamSync.beforeRead` fix: Implementor initialization DM, exact
pause, valid Leader Project/Designer/Implement Task flow, immutable broker
registration/readiness, one unpause, Runner execution, Worker journal
completion, and bound Implement Result submission.

## Fixed contract

Pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`,
`deepseek-v4-flash`, fixed fixture, command `["node","probe.mjs"]`, timeout
`30000`, output limit `65536`, fixed images, no exploration, replay, retry,
manual Result, or Full delivery during this focused run.

## Result

**PASS / Full delivery boundary authorized.**

`make up` and `make verify` passed. The exact Implementor had one persistent
Tiangong session before pause. Project and accepted Designer setup succeeded;
the Implement Task was dispatched while paused. The run-owned broker reported
`runner_broker_ready=pass` before exactly one unpause.

Worker Evidence recorded exactly one `runner.plan.requested`, one
`runner.plan.received`, zero plan failures, and one successful `run_command`
completion. The received plan digest was
`d58a519d4c53c89cb07a8e53edb780edb9e41bc86f8b56d7e39a77c0c5104b03`, command
digest was
`6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`, and
execution used the fixed plan. The Worker-scoped RunnerJournal contained the
same invocation in `executing` then `completed` records. The sealed artifact
digest was
`5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`, with
ChangeRevision content digest
`db4e273287b747e53a29a0cf7e66c92f2c68911935cbbd195d1045f698d315c4` and
invocation key
`4fd4b61df5018fdda944c0d246c2e35129ab53399e17db4a281c432cefc9cca7`.
The Implement Result was durable, non-blocked, and bound to that ChangeRevision.

This reproduces and closes the v4 failure: `team_submit_result` can now read
the completed Worker journal because `beforeRead` synchronizes only the fixed
AgentTeams `shared/` coordination root and cannot overwrite Worker-owned
`.tiangong/runtime` state with a stale remote mirror. No Assessor, release,
approval, deployment, requester delivery, or `DELIVERED` side effect was
attempted in this focused run.

### Cleanup

The exact Runner broker and three exact Runner volumes were removed. Native
Team deletion passed. The supported uninstall again left the four exact Worker
containers; only those exact names were manually removed. Final checks found
zero `agentteams-*` containers, networks, or volumes, zero `pause5-6af688`
resources, no generated Manager environment, and no install log. Physical
cleanup is PASS after the known upstream residue.

## Next step

Run exactly one fresh Full professional delivery with the same fixed contract;
the cross-session Runner completion boundary is now machine-proven.
