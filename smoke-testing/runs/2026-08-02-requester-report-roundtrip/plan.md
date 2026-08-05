# Focused requester terminal-report roundtrip

> Status: **FUNCTIONAL PASS / OVERALL FAIL (cleanup)** — a fresh real Team
> proved the complete blocked requester-report branch in storage, Matrix, and
> hash-chained Evidence. Upstream Team deletion retained all five Workers, so
> cleanup remains red and this is not Gate 3.
>
> Branch: `feat/43-agentteams-v1.2-and-leader-spike`
>
> Reproduce after the pinned AgentTeams stack is ready:
> `make test-leader-smoke-contract && make test-leader-image-basic`

## Contract and scope

Focused regression for the blocked terminal branch of the Gate 3 contingency
path. It does **not** prove `DELIVERED`, five-role release, revision, rollback,
or `FAILED_SAFE`.

Owning implementation:

- `worker/agent/team/project-chain.mjs` derives `RECOVERY_REQUIRED` only from
  the immutable blocked Task/decision chain.
- `worker/agent/work/leader-tools.mjs` authorizes the exact terminal report and
  exposes the required next action after a blocked decision.
- `worker/agent/team/manifest.mjs` admits all three closed terminal
  dispositions, including `RECOVERY_REQUIRED`.
- `worker/agent/team/channel-adapter.mjs` sends the report to the Project's
  authenticated requester in the Leader personal room and appends durable
  `team.requester.report.delivered` Evidence.
- `smoke-testing/support/run-leader-smoke.sh` observes storage, Matrix,
  Evidence, forbidden progression, and cleanup as separate facts.

## Focused truth table

| Case | Authoritative state | Requested report | Expected result |
|---|---|---|---|
| Intended terminal path | immutable Task decision is `blocked` | `RECOVERY_REQUIRED` | one immutable report, one requester Matrix event, one verified Evidence event |
| Wrong success claim | blocked chain | `DELIVERED` | Gate rejects; no report or Matrix event |
| Premature report | design/implement chain is still active | any terminal disposition | disposition unavailable; no side effect |
| Adjacent release path | release accepted, deploy facts absent | `DELIVERED` or `FAILED_SAFE` | unavailable until independent Operator facts exist |
| Replay | exact report bytes and operation identity | same disposition and summary | same immutable report and deterministic Matrix transaction; no duplicate event |
| Conflict | terminal report already exists | changed disposition or summary | reject; preserve first report |

## Required machine observations

A promotable focused pass requires all of these in one run:

1. AgentTeams Team is `Active`; the Leader and four professional Workers are
   real Team resources.
2. Every heredoc-backed in-container oracle uses `docker exec -i`; otherwise
   the shell or Node process receives no probe and a zero exit is meaningless.
3. The product channel's authenticated roster gate succeeds and real Matrix
   mentions drive Leader → Designer → Leader → Implementor → Leader without a
   manually injected professional turn.
4. The Implementor submits a digest-bound blocker; the authenticated Leader
   records `blocked`; no Assess Task exists.
5. `terminal-report.json` is immutable, digest-valid, requester-bound, written
   by the bound Leader, and has `RECOVERY_REQUIRED`.
6. The authenticated requester sees exactly one durable Leader Matrix event
   for the Project and terminal disposition.
7. A hash-chain-verified Leader Evidence stream contains exactly one delivered
   `team.requester.report.delivered` event for the Project.
8. Exact owned Team, Worker, container, Project, every discovered Project Task,
   and helper resource is removed. Cleanup failure keeps the run red.

Model prose and the existence of `terminal-report.json` alone satisfy none of
Matrix delivery, Evidence integrity, or cleanup.

## Failed discovery attempt

The real Team reached the existing functional markers:

- `leader_smoke_real_team=pass`
- `leader_smoke_design_roundtrip=pass`
- `leader_smoke_matrix_handoff=pass`

The smoke then emitted `No valid Implementor Task arrived`. This was a driver
false negative: `project_task_ids` used a heredoc-backed `docker exec` without
`-i`, so the in-container shell received no script. The same defect meant the
roster and peer-policy helper bodies in earlier runs had not executed, even
though the product's own `createProject`/`dispatchTask` channel roster gate and
real Matrix handoffs did execute.

Post-failure machine inspection found the actual Implementor Task and proved:

- producer was the bound Implementor;
- source role was `implementor`;
- a blocker was present;
- the Leader recorded a digest-bound `blocked` decision;
- no terminal report existed.

Leader Evidence showed the blocked decision completed but no `team_report`
tool proposal followed. The run therefore remains a product failure for
requester reporting, not merely a driver failure.

Upstream `agt delete team` again retained the Team and all five Workers, so the
run cleanup verdict is also failed. A later exact dedicated-stack reset removed
all AgentTeams containers, both owned volumes, `agentteams-net`, and
`.runtime/agentteams`; that reset does not upgrade the run verdict.

## Corrections and fresh rerun

The corrected assets first passed the full Worker suite and durable smoke
contract. A later exact-hash download populated the already pinned installer
cache after the direct GitHub route timed out; the normal bootstrap checksum
validation still governed the bytes. A fresh stack then exercised the updated
Leader image
`sha256:8a0db59fa5a1171389ebae8a716bd2abff09c8063bba8a1099fa64becc48d5a1`
with Project `leader-smoke-b1bdaf69`.

Corrections in that run:

- Added `-i` to every heredoc-backed Docker shell/Node probe and a CI contract
  that rejects recurrence.
- Discover all Project Task IDs from immutable bindings, avoiding traversal
  order and cleaning every discovered owned Task.
- Admit `RECOVERY_REQUIRED` in the immutable Project report schema.
- Return `requiredNextTool=team_report` and
  `terminalDisposition=RECOVERY_REQUIRED` from a blocked Leader decision, and
  state the same-turn requirement in the Leader RoleSkill.
- Verify terminal report digest/requester/Leader identity, exactly one Matrix
  report, hash-chain-valid delivery Evidence, and absence of an Assess Task.
- Keep the Gate 3 marker partial: `partial_blocked_terminal_only`.

Fresh-run machine markers:

- `leader_smoke_real_team=pass`
- `leader_smoke_design_roundtrip=pass`
- `leader_smoke_matrix_handoff=pass`
- `leader_smoke_implementor_blocker=pass`
- `leader_smoke_requester_matrix_report=pass`
- `leader_smoke_requester_report=pass`
- `leader_smoke_gate3=partial_blocked_terminal_only`

The Project had exactly design and implement Task bindings; no Assess Task was
created. The terminal report was requester-bound, digest-valid, authored by the
bound Leader, and `RECOVERY_REQUIRED`. The Matrix checker found exactly one
correlated Leader event in the requester room, and the Evidence checker replayed
the hash chain and found exactly one delivered requester-report event.

The command still exited `2`: `agt delete team` returned without releasing the
Active Team or any of its five Running Worker resources. Therefore the overall
smoke verdict is **FAIL** even though the declared functional branch passed. A
subsequent exact dedicated-stack reset removed the retained containers, owned
volumes, network, and runtime directory and was independently verified; it does
not retroactively make cleanup pass.

## Resource ownership and cleanup

Reserved owned resources:

- Team: `tiangong-leader-smoke`
- Workers/containers: the five `tiangong-leader-smoke-*` identities
- Project: random `leader-smoke-<uuid-prefix>`
- Tasks: every Task whose verified binding names that Project
- copied Manager helpers under `/tmp/tiangong-*`
- dedicated stack resources only when exact fallback reset is required:
  `agentteams-*` containers, `tiangong-agentteams-data`,
  `agentteams-dashboard-data`, `agentteams-net`, `.runtime/agentteams`

No raw Matrix credential, model transcript, installer output, or protected
result prose is retained in this run record.
