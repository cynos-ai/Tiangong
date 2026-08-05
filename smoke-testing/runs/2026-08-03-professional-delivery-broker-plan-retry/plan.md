# Professional delivery broker-plan retry

> Date: 2026-08-03
> Level: Full real integration continuation
> Status: FAIL (first plan retrieval unavailable; upstream Team deletion defect observed)

## Scope

Retry the fresh AgentTeams v1.2.0 professional delivery run after the prior
attempt was blocked before installation by temporary connectivity failure to the
pinned public installer origin. This run uses commit `87eafe6` and creates a
new stack, Team, Project, Task chain, Runner broker, deployment resources, and
requester report. It must not reuse any prior run state or upgrade the prior
blocked verdict.

The provider/model, prompts, fixture, timeout, isolation policy, and deployment
fault mode remain unchanged: configured `openai-compat` / `deepseek-v4-flash`,
fixed `node probe.mjs` Runner plan, and deployment mode `none`. No exploratory
model command, manual Result, automatic retry, or alternate dependency is
allowed.

## Preconditions

- Deterministic Worker and broker-bound plan tests already passed on this
  source revision.
- Host has no AgentTeams containers, network, or data volume before `make up`.
- Pinned installer checksum gate remains enabled.
- Manager automatic DM-membership recovery is exercised by fresh `make up`, then
  `make verify` must pass before creating a professional Team.

## Required proof

1. Fresh installation succeeds with the immutable public installer and no
   credential leakage.
2. Manager readiness is automatic; `make verify` proves health, identity,
   invitation-bound room membership, roster, and OpenClaw policy.
3. Designer → Implementor → Assessor → Operator → requester reaches only through
   authenticated AgentTeams Project/Task and Matrix state.
4. Implementor and Assessor each retrieve and execute their exact immutable
   broker plan once; the Assessor independently verifies the sealed revision.
5. Release approval, deployment journal/receipt, post-deploy verification,
   release Result, Matrix delivery, and durable requester Evidence all bind the
   same outcome before any `DELIVERED` claim.
6. Exact cleanup removes every run-owned resource. Cleanup failure keeps this
   run red.

## Stop and failure rules

- If install or readiness fails, collect bounded sanitized diagnostics and stop
  before professional Team creation.
- On a second failure of the same class, stop Full smoke and add lower-level
  evidence before another attempt.
- An uncertain Runner or deployment operation is fail-closed and is never
  replayed automatically.
- A partial chain, missing approval, missing durable Evidence, or failed cleanup
  is not `DELIVERED`.

## Ownership and cleanup

The run owns only resources created after its clean precondition: generated
installer cache/config, AgentTeams containers/network/data, uniquely named Team,
Workers, Project/Tasks, Runner/deployment broker resources, target journal,
Evidence, and temporary diagnostics. Credentials and raw logs remain owner-only,
are not copied into Evidence or reports, and are removed during cleanup.

## Result

**FAIL-CLOSED / `DELIVERED` not achieved.**

### Readiness and Team

- Fresh `make up` succeeded from source `87eafe6`; the pinned installer
  checksum was verified and the committed automatic Manager DM recovery ran.
- `make verify` passed all service, Matrix, storage, and Manager readiness
  checks, including `Manager ready and welcome message sent`.
- Team `tg-prof-7df89f` reached `Active` with a six-member Matrix Team room
  (five Workers plus the authenticated `@admin` requester). The effective
  `peerMentions: true` policy converged on the running Leader and Designer
  before the workflow began.
- The initial resource manifest deliberately kept Implementor/Assessor/Operator
  sleeping, but AgentTeams v1.2.0 did not provision credentials for sleeping
  members and first reported the Team `Failed`. No model or Project side effect
  occurred in that state. All five Workers were temporarily made Running to
  provision credentials, the Team became Active, and the three controlled
  members were put back to Sleeping before dispatch. This is recorded as an
  upstream lifecycle/setup deviation, not a delivery success.

### Coordination and fail-closed result

- Project `professional-7df89f` binding digest:
  `eb244537fb3ff92fdc78915f4958489a3f50c604811f9b4803f2ff52c4d77fe1`.
- Design Task `professional-7df89f-design-0` binding digest:
  `cc3c1075ddb81d4c2dde7c79d0beaae79e57c5749a5426ef7725c613e7992342`.
  Its accepted Designer Result digest was
  `2b77f3dde640b541abceb78a9ff3d1ad889080c0604e77a6999be89d62c9482b`.
- Implement Task `professional-7df89f-implement-0` binding digest:
  `05d15b350e6e5608276da1a28426c1f5298ed3c0c607dde504947da1f41ebe3a`.
  The deterministic Runner binding was
  `run-05d15b35-0e6e-4608-a76d-a1a28426c1f5` with immutable plan digest
  `d785ff2bb42bd54ffeae1821ce340d3d94c4cf803baba53fe7cf460aef88b40f`.
- The Implementor made exactly one `run_command` tool attempt with only the
  assigned Task ID. The plan retrieval returned the stable blocker
  `TIANGONG_RUNNER_PLAN_UNAVAILABLE`; no command executed, no revision was
  sealed, no Runner journal was created, and no broker execution request was
  accepted. The Task Result was correctly `blocked` and contained no
  `ChangeRevisionRef` or machine execution Evidence.
- A bounded post-failure probe from the same Worker container retrieved the
  exact plan successfully, while the broker had emitted no rejection or
  execution event. This is direct lower-layer evidence of a first-request
  Worker transport/readiness race or equivalent runtime fetch boundary; it does
  not authorize replay and does not upgrade the failed Task.
- The Leader derived `RECOVERY_REQUIRED` and wrote one immutable terminal report
  for the original authenticated requester. Durable Evidence recorded
  `team.requester.report.delivered` with terminal disposition
  `RECOVERY_REQUIRED`; the authenticated requester’s actual Leader personal
  room contained exactly one matching terminal Matrix event.

### Cleanup

The first supported `agt delete team tg-prof-7df89f` returned success but left
Team state `Active` and all five run-owned Worker resources. Direct Worker
deletes were rejected with the upstream `worker is a member of team` 409. The
confirmed whole-stack uninstall then removed the controller, Manager, data,
network, generated environment, and sensitive install log but left four
run-owned Worker containers; this reproduces the known AgentTeams v1.2.0
member-release/uninstall defect.

Manual cleanup removed only those exact four remaining Worker containers and
verified:

- `runner_broker` and all three run-owned Runner volumes absent;
- zero `agentteams-*` containers;
- no `agentteams-net` or `tiangong-agentteams-data`;
- no generated Manager environment or `/home/sj/agentteams-install.log`.

Final physical cleanup is **PASS**. The overall run remains red because the
functional delivery failed and the supported Team/uninstall path failed before
manual exact cleanup.

Classification: **Worker-side first-plan transport/readiness boundary**, medium
confidence; product fail-closed behavior is correct. No provider, model, prompt,
fixture, timeout, or isolation policy was changed, and no automatic invocation
retry was performed.

Smallest follow-up: add a no-model, same-container plan-readiness diagnostic to
the orchestration boundary and preserve the first stable fetch error class
without replaying the failed Task. Only then consider one fresh Team attempt.
