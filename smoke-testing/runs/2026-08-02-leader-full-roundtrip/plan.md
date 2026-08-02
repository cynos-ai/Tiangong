# Focused run — Gate 3 full task roundtrip

> Status: REVOKED — this is NOT architecture Gate 3.
> A review found the claim did not hold: two standalone Workers (no Team),
> each turn operator-driven (not Leader mention waking the Worker), no real
> requester report, no reproducible one-command run, residual Workers left in
> place, and the port layer does not enforce producer/digest/decidedBy binding
> (deterministic negatives ALLOWED). The upstream Project/Task is not driven;
> a second Tiangong coordination-state namespace was created, conflicting with
> the baseline. The dispatch->submit->accept mechanics were observed live, but
> they do not satisfy the contract. Treat as partial evidence only.
> Date: 2026-08-02
> Branch: `feat/43-agentteams-v1.2-and-leader-spike`

## Scope

Architecture gate 3, completed: the `tiangong-leader` and a professional
Worker drive a full Task roundtrip — dispatch -> submit -> accept — through
TeamContextPort + TeamTaskPort on the live AgentTeams stack, grounded on the
closed playbook, immutable manifests, TransitionPolicy, and hash-chained
Evidence. This extends the leader-half run
(`2026-08-02-leader-half-roundtrip`) with the Worker half and cross-worker
shared-FS sync.

## Fixture

Two standalone Workers (no Team: each has its own Matrix room, and the round
turns are driven by the operator, so no inter-worker mention wake is needed):
- `tiangong-fullrt-leader` — `tiangong-worker-leader:dev`.
- `tiangong-fullrt-designer` — `tiangong-worker-member:dev`.
Model: `deepseek-v4-flash` via the AgentTeams gateway.

## Cross-worker shared filesystem

Each Worker's `/root/agentteams-fs/shared` is local-only. Cross-worker sharing
goes through the MinIO `shared/` prefix by explicit push/pull (verified before
the run): the writer `mc mirror`s local `shared/` to MinIO; the reader runs
`agentteams-sync`, which mirrors MinIO `shared/` to local. The TeamTaskPort
sync adapter now does this automatically — `afterWrite` pushes, `beforeRead`
pulls — so the immutable manifests are visible across Workers.

## Observed roundtrip (three driven turns)

1. Leader: `team_create_project` (project `fr-demo`; `team_leader` bound to the
   authenticated Leader identity) + `team_dispatch_task` (design-1@0 ->
   designer; TransitionPolicy gates design as the only valid first step, owned
   by the designer role). Leader pushes the bindings.
2. Designer: pulls, `team_resolve_task` (verifies assignee), then
   `team_submit_result` (producer bound to the authenticated Worker; pushes).
3. Leader: pulls, `team_check_result`, then `team_decide_task` (accept).

## Machine evidence (verified)

Shared FS (Leader view after pull):
- `projects/fr-demo/project-binding.json` — `team_leader = tiangong-fullrt-leader`.
- `tasks/design-1/task-binding.json` — `design@0`, assignee `tiangong-fullrt-designer`.
- `tasks/design-1/result.json` — producer `tiangong-fullrt-designer`, digest
  `e993991a...`.
- `tasks/design-1/decisions/dec-design-1-accept.json` — `accept`, decidedBy
  `tiangong-fullrt-leader`, `resultDigest` == the submitted result digest
  (`assertResultCurrent` accepts the current result, not a stale one).

Leader hash-chained Evidence: `team.project.created` -> `team.mention.queued` ->
`team.task.dispatched` -> `team.task.decision`.

## Known limitations / next

- The Leader and Worker have separate Matrix rooms; turns are operator-driven.
  Deterministic mention emission (the Leader's turn output carrying the
  @mention that wakes the Worker, like peer-transport) is not yet wired.
- The roundtrip uses a generic professional-Worker (team-member) surface
  (resolve + submit). The distinct designer/implementor/assessor/operator work
  tools, the full design->implement->assess->release chain, revision waves,
  and the DELIVERED/FAILED_SAFE end-to-end run are the remaining demo work.
- The idle `tiangong-rt-*` Team Workers (stock leader + leader + designer
  image) from an earlier Team attempt remain until a `make uninstall` reset;
  they are harmless.
