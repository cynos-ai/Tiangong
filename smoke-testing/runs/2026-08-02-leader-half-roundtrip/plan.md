# Focused run — Gate 3 Leader-half roundtrip

> Status: HISTORICAL PARTIAL — leader-half only (create + dispatch).
> NOT architecture Gate 3. The original standalone reproduction and second
> coordination namespace were removed. `make test-leader-image-basic` now
> targets a disposable real Team and a Matrix Leader→Designer→Leader design
> roundtrip; that replacement must produce its own run record before it is
> evidence. Producer/digest/decidedBy, unified Gate wrapping, native
> Project/Task records, and Matrix delivery are now deterministic code gates,
> but requester reporting and terminal delivery are still unproven live.
> Date: 2026-08-02
> Branch: `feat/43-agentteams-v1.2-and-leader-spike`
> Reproduce: `make test-leader-image-basic`

## Scope

Architecture gate 3: the `tiangong-leader` Worker image completes a real
Matrix -> pi coordination turn through TeamContextPort + TeamTaskPort, grounded
on the closed `software-change-delivery` playbook, immutable manifests, and the
deterministic TransitionPolicy. This run proves the **Leader half**: create a
project bound to the Leader identity and dispatch the first design task. The
professional-worker half (implementor/assessor/operator response, submit,
accept) and cross-worker `agentteams-sync` are out of scope here.

## Fixture

- `tiangong-worker-leader:dev` — the leader multi-stage image
  (leader RoleProfile + SOUL + closed coordination tool surface).
- A disposable standalone Worker `tiangong-leader-smoke`
  (`runtime: openclaw`, `model: deepseek-v4-flash`).
- The Manager sends one Team-Room `m.room.message` whose `formatted_body`
  carries the Leader's MXID matrix.to link and whose `m.mentions` lists the
  Leader (the OpenClaw wake format; a plain body without the link does not
  wake the Worker).

## Observed contract

- The Leader's Matrix channel wakes on the formatted-body mention; OpenClaw
  invokes the `tiangong-pi` runtime, which assembles the leader RoleProfile +
  the five coordination tools.
- The model (deepseek-v4-flash) calls `team_create_project` then
  `team_dispatch_task` and replies `LEADER_DONE`.
- `team_create_project` binds `team_leader` to the **authenticated Worker
  identity** (`tiangong-leader-smoke`), not model input; the four professional
  slots come from the prompt.
- `team_dispatch_task` reconstructs the project decision chain and enforces
  `assertTransitionAllowed`: design@0 is the only valid first step, owned by
  the designer role.

## Machine evidence (verified by the smoke)

- Historical, now-removed project binding at
  `shared/tiangong/projects/<id>/project-binding.json` — `team_leader` =
  `tiangong-leader-smoke`, `playbookId=software-change-delivery@1.0.0`,
  content digest valid.
- Historical, now-removed design task binding at `shared/tiangong/tasks/design-1/...` —
  `taskKind=design`, `revisionIndex=0`, `assignee=tiangong-designer-smoke`,
  `playbookStepId=software-change-delivery-transition-v1:design`, digest valid.
- Hash-chained coordination Evidence under the Worker's
  `.tiangong/runtime/evidence/<hash>/events.jsonl`:
  `team.project.created` -> `team.mention.queued` -> `team.task.dispatched`.

Those historical verdict lines were over-broad and are revoked. The current
focused smoke emits `leader_smoke_design_roundtrip=pass` only after a real Team
Matrix handoff, bound ResultEnvelope, Leader accept, and exact cleanup; it
still emits an explicit partial Gate 3 marker until requester reporting is
proved.

## Fix surfaced by this run

The TeamTaskPort operations called `deps.evidence.record(...)`, but
`EvidenceRecorder` exposes `append`; the optional chain made it a silent
no-op, so coordination Evidence was never written. Fixed: `recordEvidence` is
async + awaited and calls `append`. After the fix the hash-chained Evidence
appears alongside the bindings.

## Known limitations / next

- Mention emission is the Leader's model turn output carried by OpenClaw; the
  channel adapter records the queued mention as Evidence but does not yet
  deterministically emit the mention text (like peer-transport) or map the
  assignee to a full MXID.
- Cross-worker `agentteams-sync` (Leader reading a Worker-submitted result) is
  a tolerant no-op on the Leader write path; it is wired with the full
  multi-turn roundtrip (worker submit -> Leader accept).
- The professional workers (designer/implementor/assessor/operator) and the
  success + revision/rollback end-to-end run are the remaining gate-3 work.
