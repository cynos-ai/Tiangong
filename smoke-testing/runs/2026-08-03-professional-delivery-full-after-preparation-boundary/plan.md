# Professional delivery after code-owned Runner preparation

> Date: 2026-08-03
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: FAIL-CLOSED (Assessor preparation input boundary)

## Scope

Fresh Team `tg-del8-35e1ab`, Project, and fixed Designer → Implementor →
Assessor → Operator delivery chain. This is the first Full attempt after the
code-owned Runner preparation/registration boundary and its real Docker focused
proof. It must not replay any earlier Team, Task, approval, notification, or
Runner execution.

## Fixed contract

Provider/model `deepseek-v4-flash`, pinned AgentTeams v1.2.0 checksum
`701f53c53dc476d8ca7f33428e231c1706d967ac2b517ec4c1c59d742864331d`, fixed
role images, fixture, command `["node","probe.mjs"]`, role cwd, timeout
`30000`, output limit `65536`, deployment fault mode `none`, explicit approval
subject, requester identity, and peer policies. Implementor/Assessor tools
accept only `taskId`; the code-owned shared broker supplies immutable plans.
No exploration, manual Result, target-only activation, provider/model/fixture
substitution, automatic retry, or replay.

## New production boundary

`make start-runner-broker` starts the fixed `tiangong-runner-broker` service and
its preparation-enabled registration state before any professional Task is
dispatched. The Leader's `TeamTaskPort` registers and independently verifies the
exact assignee binding before sending the Matrix mention. The run does not use
Docker pause as a readiness substitute; all Workers remain within the Channel
Plane liveness budget. A preparation failure is terminal for that Task and no
notification or Task replay is permitted.

## Required machine proof

- checksum-verified setup and `make verify` before Team creation;
- Active five-role roster, authenticated requester, and peer-policy convergence;
- accepted Designer, Implementor, independent Assessor, and Release Results;
- one code-owned broker preparation receipt before each Implementor/Assessor
  notification, one immutable plan and one execution per role;
- sealed artifact and read-only independent assessment;
- explicit requester approval bound to the exact operation digest;
- deployment journal/receipt, post-verification, requester terminal delivery,
  durable `DELIVERED` Evidence;
- exact cleanup of Team, Workers, shared broker, broker state, deployment
  resources, and temporary files.

## Stop rules

Any identity/readiness failure, preparation/plan/transport failure, evidence or
approval mismatch, unknown outcome, deployment uncertainty, notification or
cleanup failure is fail-closed. Stop at the first failure. Do not resend a
Matrix mention, replay a Task, retry an execution, or upgrade a failure from
cleanup or model prose. No `DELIVERED` claim is valid without all required
machine facts.

## Owned resources

Team `tg-del8-35e1ab`, its five exact Workers and native/shared Project/Tasks;
fixed shared Runner broker `tiangong-runner-broker`, its config/fixture/state
volumes; exact deployment broker/service/target resources; and temporary
request/diagnostic files. The focused run owns only resources carrying these
identities or explicit run labels.

## Terminal outcome

Setup, the Active five-role Team, Matrix roster/policies, Designer Result, and
one Implementor preparation/notification/execution passed. The Implementor
produced the sealed artifact `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`
with run `run-4b4d2c09-6e10-47df-a41f-fabc3179735a`; its broker preparation
receipt had binding digest `57bf8c9d20e5f6729c54521ddee1b08e04fbf59c13fbf6d0ee6ea0a7b22573b4`.

The Leader created exactly one Assessor Task binding with input references for
the Implement Task and its ChangeRevision artifact. The code-owned preparation
boundary treated the non-Task artifact reference as a missing Task binding and
failed closed with `RUNNER_BROKER_PREPARATION_INPUT_INVALID` before Assessor
notification. The durable dispatch state is `preparation_failed`; no Assessor
plan, execution, Result, approval, deployment, requester delivery, or
`DELIVERED` Evidence exists. Later same-Task dispatch attempts were blocked or
failed and are diagnosis only; no replay is authorized.

Evidence counts at the terminal boundary: one successful Implementor broker
preparation and mention, one Implement Runner plan request/receipt, one
Implement execution/result, and one Assessor preparation failure. This is a
production input-normalization defect, not delivery proof.

Cleanup completed after evidence capture: the fixed Runner broker was stopped
with purge, the native Team/data stack was uninstalled, and the four exact
Worker containers left by AgentTeams uninstall were manually removed. The
owned `agentteams-net` residue was then removed and verified absent. No
`agentteams-*` or `del8` containers, Team/Project/Task storage, broker state,
network, generated Manager environment, or install log remains; the pinned
installer cache was restored with its verified checksum.
