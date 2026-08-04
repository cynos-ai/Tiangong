# Initialized Worker / Runner broker boundary v3

> Date: 2026-08-03
> Level: focused real AgentTeams/Matrix/Runner integration
> Status: PASS (focused boundary; no Full delivery)

## Purpose

Verify the paused-Worker lifecycle with the missing precondition from the
failed `professional-del4` Full: the exact Implementor must have a durable
Tiangong session before the pause. A fresh Team is used; this is not a replay.
The exact Implementor is paused only after Matrix channel readiness and a
bounded initialization turn create its persistent Tiangong session. The Leader
then creates a valid Project/Designer/Implement Task while the Implementor is
paused. The run-owned immutable Runner broker must be ready before exactly one
unpause. The original Task notification, not a replay, must lead to one
`runner.plan.requested` and one received immutable plan.

The initialization marker is setup-driver evidence only. It cannot prove a
Task, Result, Runner execution, approval, or delivery.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 installer checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
Worker/Runner images, valid change specification, fixture, command
`["node","probe.mjs"]`, cwd, timeout `30000`, output limit `65536`, and peer
policy remain fixed. No exploratory command, manual Result, retry, Task replay,
provider substitution, or Full delivery is allowed.

## Required machine evidence

- `make verify`, Active Team, complete roster, and Matrix readiness;
- exact Implementor persistent Tiangong session before pause;
- durable Project, accepted Designer Result, and Implement Task binding;
- immutable Runner binding and `runner_broker_ready=pass` before unpause;
- exactly one unpause followed by Worker Runner plan evidence or a stable
  sanitized transport failure;
- no replay and exact run-owned cleanup.

## Owned resources

Fresh Team `tg-pause3-587324`, Project, Task, exact Worker containers, Runner
broker, and run-labeled Runner volumes. Credentials and raw transcripts remain
outside this plan.

## Result

**PASS / focused boundary proof; no `DELIVERED`.**

The fixed checksum-verified AgentTeams v1.2.0 artifact was used and `make up`
and `make verify` passed. Fresh Team `tg-pause3-587324` reached Active with all
five Worker Matrix channels ready and `readyWorkers=4`.

The exact Implementor received one bounded setup message in its authenticated
personal room and returned the setup marker. The marker was not accepted as
proof. Before pausing, machine state showed one persistent Tiangong session
JSONL under the Implementor's Worker state root; this is the required
initialization boundary. The exact Implementor container was then paused.

The Leader created Project `professional-pause3-587324` with project binding
digest `94f9658eda42f46692b593bb9992a1e9a8379f09a508c27a7da06069ec2bf140`.
The Designer Result digest was
`182d9b09a445792c38f256967b5191a4ae4719e8ebc001414094517f92206e4c`, and the
native Leader decision was `accept` with decision digest
`4073a6f020a6dfbd7a8bf687d51214a77a8328e4d2accf918545231200c5ddea`. The
Leader dispatched Implement Task `professional-pause3-587324-implement-0`
with immutable binding digest
`8fe44dc4d92ddce6293da080e33ae1ebdf7fa395160ea295813c638e7eafc9a7` while
the initialized Implementor remained paused.

The run-owned Runner broker was registered from that immutable binding and
reported `runner_broker_ready=pass` before exactly one unpause. Machine Worker
Evidence then recorded exactly one `runner.plan.requested`, one
`runner.plan.received`, and zero `runner.plan.failed` events. The received plan
digest was
`f28badb6be39ff2c7ab51aa8983fd8aa29aa8cb151a8a3007adfcb530a3391fb`; its fixed
command digest was
`6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`, with
cwd `scratch/revision`, timeout `30000`, and output limit `65536`. Exactly one
successful `run_command` execution had invocation key
`6711c5c1146bf3fe6dc0d57f753587e22fc2543b336f5d6a4a2ddacdeea9be95`, exit code
0, `runnerReplayed=false`, policy digest
`bc570ec55695250a077c017bbb653df987ed60037fdbcb079e60642542911949`, and
sealed artifact digest
`5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`. The
Implement Result was durable and bound to that artifact and run. No Assessor,
Release, approval, deployment, requester delivery, or `DELIVERED` side effect
was attempted.

This proves that an initialized Worker plus broker readiness before one
unpause prevents the previously observed first-plan transport failure. It
also proves the failed `professional-del4` Full did not test the same boundary,
because its Implementor had no persistent Tiangong session before pause.

### Cleanup

The exact Runner broker and three exact run-labeled Runner volumes were
removed. Native Team deletion passed. The supported uninstall again left the
four exact Worker containers; only those exact names were manually removed.
Final checks found zero `agentteams-*` containers, networks, or volumes, zero
`pause3-587324` resources, no generated Manager environment, and no install
log. Physical cleanup is PASS after the known upstream residue.

## Stop rules

Any blocker, readiness failure, missing session, plan failure, transport
failure, evidence mismatch, uncertainty, or cleanup failure is fail-closed.
This focused run cannot claim `DELIVERED`.
