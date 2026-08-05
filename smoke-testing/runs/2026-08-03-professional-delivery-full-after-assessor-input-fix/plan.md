# Professional delivery after Assessor artifact-input fix

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (revision-wave broker registration boundary)

## Scope

Fresh Team `tg-del9-f71ae0`, Project, and fixed Designer → Implementor →
Assessor → Operator chain. This run is independent of the terminally failed
`tg-del8-35e1ab` attempt and must not replay its Team, Tasks, notification, or
Runner execution.

## New lower-layer evidence

The previous Full run proved code-owned preparation and Implementor execution,
but exposed that Assessor `inputRefs` legitimately contain both the Implement
Task ID and its immutable ChangeRevision artifact reference. The preparation
boundary incorrectly treated the artifact reference as a missing Task and
failed with `RUNNER_BROKER_PREPARATION_INPUT_INVALID`. Production code now
selects exactly one matching Implement Task binding, ignores absent non-Task
artifact references, and still fails closed on malformed/unreadable Task state.
The deterministic regression is in `worker/test/team-task-port.test.mjs` and
passes; the full Worker suite and sequential Docker preparation/broker smokes
also pass after rebuilding the image.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
role images, isolation fixture, command `["node","probe.mjs"]`, role cwd,
timeout `30000`, output limit `65536`, deployment fault mode `none`, explicit
approval subject, requester identity, and peer policies. Implementor/Assessor
tools accept only `taskId`; immutable broker plans supply all command and
execution bounds. No exploration, manual Result, provider/model/fixture
substitution, automatic retry, replay, Docker pause, or target-only activation.

## Ordering and required proof

Start the fixed shared Runner broker before Team creation. For each Implementor
or Assessor Task, code-owned preparation and exact endpoint verification must
complete before the Matrix notification. Require Active roster and policy
convergence, accepted Designer/Implementor/Assessor/Release Results, one
immutable plan and execution per role, sealed artifact and independent
assessment, explicit requester approval, deployment receipt, post-verification,
requester delivery, durable `DELIVERED` Evidence, and exact cleanup.

## Stop rules

Any readiness, preparation, plan, transport, evidence, approval, deployment,
unknown-outcome, notification, or cleanup failure is terminal and fail-closed.
Do not resend a mention, replay a Task, retry an execution, or upgrade the
verdict from model prose or cleanup. `DELIVERED` is invalid unless every
machine gate agrees.

## Owned resources

Team `tg-del9-f71ae0`, its five exact Workers and native/shared Project/Tasks;
fixed shared Runner broker and its state; exact deployment broker/service/target
resources; and temporary files carrying this run identity. Cleanup must verify
all owned resources are absent, including known AgentTeams member-release
residue.

## Terminal outcome

The fresh run passed setup, the Active Team, Designer acceptance, one
Implement@0 preparation/notification/execution, and one Assessor preparation/
notification. The Assessor independently executed the fixed command once and
correctly returned a revision request because the existing fixture emits
`runner_probe=pass` rather than the Designer's required JSON schema. That
assessment was machine-recorded as a revision decision; it is not delivery.

The Leader then created the immutable Implement@1 revision Task. Preparation
failed before its notification with `RUNNER_BROKER_PREPARATION_REJECTED`. The
broker already held valid bindings for Implement@0 and Assessor@0, but its
registry still required globally unique Worker/container identities, so a
legitimate next revision for the same Implementor could not register. The
Task has durable `status=preparation_failed` and no Implement@1 plan,
execution, Result, approval, deployment, requester delivery, or `DELIVERED`
Evidence. No retry or replay is authorized.

The observed binding/fixture facts are preserved in the broker-owned state and
Worker Evidence until cleanup; the immutable verdict remains fail-closed.

Cleanup completed after evidence capture: the fixed Runner broker was stopped
with purge, the AgentTeams data stack was uninstalled, and the four exact
Worker containers left by the known member-release defect were manually
removed. The exact `agentteams-net` residue was removed and verified absent.
No `agentteams-*` or `del9` resources, broker state, generated Manager
environment, or install log remains; the pinned installer cache was restored
with its verified checksum.
