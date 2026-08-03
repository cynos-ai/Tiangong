# Professional delivery with the fixed Runner fixture contract

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (deployment broker readiness boundary)

## Scope

Fresh Team `tg-del10-294ebc`, Project, and Designer → Implementor → Assessor →
Operator chain. This is independent of the terminally failed del8 and del9
runs; no prior Task, notification, approval, or Runner invocation may be
replayed.

## Lower-layer basis

The code-owned preparation boundary now registers before notification,
selects non-Task ChangeRevision references correctly, and supports historical
bindings for the same Worker/container across revision waves while selecting
execution by the requested Task ID. Deterministic unit tests, the full 307-test
Worker baseline, rebuilt Worker/broker images, and sequential Docker
preparation/broker smokes passed.

## Fixed fixture contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
role images, `smoke-testing/fixtures/runner-isolation`, command
`["node","probe.mjs"]`, role cwd, timeout `30000`, output limit `65536`,
explicit approval subject, requester identity, and deployment fault mode
`none` remain fixed. The fixture's successful stdout contract is exactly
`runner_probe=pass` with exit code 0; no JSON redesign, file substitution,
exploration, extra command, or model-proposed contract extension is permitted.
The Designer, Implementor, and Assessor must describe and verify that existing
machine contract. Implementor/Assessor tools accept only `taskId`; broker plans
remain authoritative.

## Required proof

- checksum-verified setup, `make verify`, Active five-role Team, authenticated
  requester, and converged Matrix peer policies;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- one preparation receipt before each professional notification, one immutable
  fixed plan and one execution per role/wave, exact sealed artifact, and
  read-only independent assessment;
- explicit requester approval bound to the exact operation digest;
- deployment journal/receipt, post-verification, requester delivery, durable
  `DELIVERED` Evidence;
- exact cleanup including known AgentTeams member-release residue.

## Stop rules

Any readiness, preparation, plan, transport, evidence, revision, approval,
deployment, unknown-outcome, notification, or cleanup failure is terminal and
fail-closed. Do not resend mentions, replay Tasks, retry commands, or upgrade a
verdict from model prose or cleanup. No `DELIVERED` claim is valid without all
machine gates.

## Owned resources

Team `tg-del10-294ebc`, its five exact Workers and native/shared Project/Tasks;
fixed shared Runner broker and state; exact deployment broker/service/target
resources; and temporary files carrying this run identity.

## Terminal outcome

The run passed the Active Team boundary, Designer acceptance, one Implementor
preparation/notification/plan/execution, one independent Assessor
preparation/notification/plan/execution, exact sealed artifact binding, and
Assessor acceptance using the fixed `runner_probe=pass` contract. The Leader
created the Release Task, but the Operator's `deploy_release` could not reach
the fixed deployment broker after five bounded attempts. The Leader recorded a
blocked terminal decision with `deployment broker unreachable`; no deployment
stage/activate/verify/rollback, release Result, requester delivery, approval,
or `DELIVERED` Evidence exists. This is an external deployment-preparation
failure, not a successful delivery and not permission to retry the blocked
Release Task.

The required next lower-layer action is to pre-provision the exact deployment
target and fixed `tiangong-deployment-broker` binding, using the Implementor's
sealed ChangeRevision and deterministic Release Task ID, before allowing the
next fresh Release notification. The del10 verdict remains immutable.

Cleanup completed after evidence capture: the fixed Runner broker was stopped
with purge, the Team/data stack was uninstalled, and the four exact Worker
containers left by the known member-release defect were manually removed. The
exact `agentteams-net` residue was removed and verified absent. No `agentteams-*`
or `del10` resources, broker state, generated Manager environment, or install
log remains; the pinned installer cache was restored with its verified
checksum.
