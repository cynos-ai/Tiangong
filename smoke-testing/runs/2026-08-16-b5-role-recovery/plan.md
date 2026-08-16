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

## Current prerequisite status

The public deterministic route, owner lease, recovery controller, and B4
Codex/Runner/Coordination/WebUI/Matrix seam are implemented. The current local
AgentTeams v1.2.2 `agt` deployment does not inject the B5 role/runtime metadata
(`TIANGONG_ROLE_ID`, required runtime lane, or the native Leader binding) into
Worker containers; its observed demo Workers report `AGENTTEAMS_WORKER_ROLE=standalone`.
Until the deployment template supplies those fields, this run is blocked at
startup by design. Do not weaken the startup gate or repurpose the existing
demo Team; deploy a fresh run-owned Team with the binding injection first.
