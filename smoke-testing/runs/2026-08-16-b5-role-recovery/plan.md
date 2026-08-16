# B5 role routing, restart recovery, and coding A/B

## Scope

This focused run is the deployment-level proof for the B5 contract. It must
use one fresh AgentTeams Team, one Leader, one Designer, one Implementor, one
Assessor, and one Operator, while retaining AgentTeams Matrix and WebUI as the
official Channel Plane. The same repository commit, Task binding, model,
budget, prepared workspace, and capability binding must be used for both
runtime lanes.

## Required route facts

- Leader, Designer, Assessor, and Operator start with
  `openclaw-built-in`, `coding=false`, and `fallback=none`.
- Implementor starts with `codex-app-server`, `coding=true`, and
  `fallback=none`.
- A mismatched role/runtime or any non-`none` fallback fails before the
  Gateway session starts.
- The route record contains only bounded role/runtime metadata and its digest;
  no provider key or Matrix credential is recorded.

## Vertical slice

1. Human Matrix event enters one Work and one current WorkSpec.
2. Native Leader session creates immutable Project/Task facts.
3. Member Gateway/session resolves the exact Task.
4. Designer/Implementor perform prepared local work; Implementor records a
   ToolResult-backed Result and exact local commit.
5. Kill the Implementor after `executing` is durably recorded. A replacement
   Worker must observe `recovery_required`, not retry or submit a duplicate
   Result.
6. An authenticated recovery controller performs read-only reconciliation and
   `resume`; the new owner continues to verification and Result submission.
7. Leader reads the durable Result, decides the Task, and closes Work only
   after all machine closure checks pass.

## Coding A/B

Run the same bounded coding Task twice: once through the pinned OpenClaw
built-in lane and once through restricted Codex app-server, with the same
repo/commit/model/budget/environment/capability. Compare tests, hidden tests,
regressions, smallest diff, security violations, and blind maintainability.
A model's self-evaluation or one successful response is not evidence.

## Evidence and cleanup

Capture only sanitized image digests, route digests, Work/Task/Result/ToolResult
references, WorkRun phase sequence, owner/recovery codes, local commit IDs,
Matrix event IDs/digests, WebUI readiness, and exact run-owned cleanup. Never
capture provider keys, raw Matrix payloads, raw prompts, unrestricted logs, or
full model transcripts.

## Deployment prerequisite status

The public deterministic route, owner lease, recovery controller, and B4
Codex/Runner/Coordination/WebUI/Matrix seam are implemented. AgentTeams v1.2.2
still has no manifest fields for the B5 role/runtime metadata. The deployment
adapter `scripts/inject-b5-role-runtime-docker.sh` now provides the narrow
escape hatch: it accepts one explicit role, recreates only the supported
single-auth-volume Worker topology, preserves its security flags, and verifies
the route from inside the new container. Its deterministic contract is covered
by `make test-b5-role-runtime-injection-docker`.

For a fresh Worker only, the deployment owner invokes it with
`TIANGONG_B5_WORKER_CONTAINER=agentteams-worker-<name>` and
`TIANGONG_B5_ROLE_ID=leader|designer|implementor|assessor|operator`.
The adapter must run after `agt apply` reports the Worker `Running` and before
any Matrix/model turn. A failed route check rolls the exact old container name
back; it never falls through to a different Harness.

The current local AgentTeams deployment has not been mutated: its observed demo
Workers report `AGENTTEAMS_WORKER_ROLE=standalone`, and the existing demo is not
owned by this run. The full smoke requires a fresh run-owned Team, per-Worker
injection (plus the separate native Leader binding), and direct
WebUI/Matrix/Task/Result/restart facts. Do not weaken the startup gate or
repurpose the existing demo Team.

## Attempt A: real startup route gate (2026-08-16)

Run-owned Team `tiangong-b5-route-20260816-a` was applied against the local
AgentTeams v1.2.2 stack using the five role images. After the deployment adapter
injected the routes, the Team reached `phase=Active`, `leaderReady=true`, and
`readyWorkers=4/4`. The direct container facts were:

| role | runtime | fallback | result |
| --- | --- | --- | --- |
| leader | `openclaw-built-in` | `none` | pass |
| designer | `openclaw-built-in` | `none` | pass |
| implementor | `codex-app-server` | `none` | pass; shared capability cache hit |
| assessor | `openclaw-built-in` | `none` | pass |
| operator | `openclaw-built-in` | `none` | pass |

The five route records and image digests were captured from the Worker startup
lines; no provider, Matrix, or raw prompt data was retained. The exact Team,
Workers, containers, volumes, and manager manifest files were then removed and
absence was verified. This closes the real B5 startup-routing gate only. The
full run remains pending the separate native Leader binding and the actual
Matrix → Work → Project/Task → ToolResult/Result → restart/recovery → closure
slice, followed by the same-input coding A/B.
