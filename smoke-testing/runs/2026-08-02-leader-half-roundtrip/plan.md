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

- One disposable real AgentTeams Team containing five independently built
  profile images: Leader, Designer, Implementor, Assessor, and Operator.
- All Workers use `runtime: openclaw` and the explicitly configured supported
  `deepseek-v4-flash` model.
- Standalone Workers are created first and observed Running with Matrix
  identities before `spec.workerMembers` binds the Team. The Team must become
  Active and the Leader must observe the full joined Matrix roster before the
  request is sent.
- The Manager sends one personal-room `m.room.message` whose `formatted_body`
  carries the Leader's MXID matrix.to link and whose `m.mentions` lists the
  Leader. Coordination handoffs then use the authenticated Team room.

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
focused smoke may emit `leader_smoke_design_roundtrip=pass` only after a real
Team Matrix handoff, bound ResultEnvelope, and compatible Leader decision. Its
process verdict remains red unless the EXIT cleanup oracle also passes; it
emits an explicit partial Gate 3 marker until requester reporting is proved.

## Fix surfaced by this run

The TeamTaskPort operations called `deps.evidence.record(...)`, but
`EvidenceRecorder` exposes `append`; the optional chain made it a silent
no-op, so coordination Evidence was never written. Fixed: `recordEvidence` is
async + awaited and calls `append`. After the fix the hash-chained Evidence
appears alongside the bindings.

## Follow-up real-Team attempt — BLOCKED, useful evidence

The replacement fixture reached Active with all five Workers. The first
project call raced Matrix membership propagation even though the Team resource
was Active; the channel correctly failed closed before writing a Project. A
manual retry after the full joined roster became observable completed the real
Leader→Designer→Leader Matrix roundtrip, including native Project/Task files,
a profile/Skill-bound ResultEnvelope, an exact-digest Leader accept, and
`team.mention.delivered` / `team.result.notice.delivered` Evidence. The durable
smoke now waits for the Matrix roster instead of treating Team Active as
sufficient readiness.

The continued live flow then exposed a product defect: the Implementor truthfully
submitted a blocker because no controlled implementation tool or artifact
boundary was available, but the Leader was able to record `accept` and dispatch
an Assessor Task. This was not promoted to success. The deterministic decision
gate now requires a blocker ResultEnvelope to receive a digest-bound `blocked`
decision and rejects acceptance; an assessor revision request likewise cannot
be accepted. A fresh-image live rerun is required.

`agt delete team` again returned success while retaining the Team, all five
Worker resources, and their containers. The run's cleanup verdict is failed. A later confirmed
reset removed all resources from the dedicated stack; it does not retroactively
make the run's cleanup pass.

## Known limitations / next

- Upstream v1.2.0 Team deletion still does not release `workerMembers`; exact
  per-run cleanup therefore remains blocked and keeps this smoke red.
- The professional role images currently expose only resolve + submit. A real
  disposable Runner and role-specific design/implementation/assessment/release
  operations are not yet available.
- Requester terminal reporting, `DELIVERED`, revision waves, rollback, and
  `FAILED_SAFE` remain unproven live.
