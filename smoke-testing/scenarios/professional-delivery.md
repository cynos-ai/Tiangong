# Professional delivery smoke scenarios

## Ownership

- Related implementation: `worker/agent/team/`, `worker/agent/work/`,
  `worker/agent/runner/`, and `worker/agent/deployment/`.
- Related Skills: the five fixed role Skills under `worker/skills/`.
- Related state/Evidence: AgentTeams Project/Task records, Tiangong binding
  manifests, WorkRun journals, Runner/deployment journals, approval state, and
  hash-chained Worker Evidence.
- Update triggers: changes to role/profile loading, TeamTaskPort,
  ResultEnvelope, ChangeRevisionRef, Runner preparation, deployment approval,
  rollback, requester reporting, or run-owned cleanup.

## Basic smoke

### B1: five-role Team and controlled Worker boundary

- **Purpose:** prove the pinned v1.2 stack can start the five fixed role images
  and expose only the expected role-scoped tools.
- **Setup:** run `make verify`, build the Worker images, and use a unique
  disposable Team with one `team_leader` and four professional Workers.
- **Prompt:** the authenticated requester asks the Leader to create one bounded
  design Task; the Leader dispatches it through `TeamTaskPort`.
- **Expected observations:** the Team is Active, each Worker has a distinct
  authenticated identity, the Project/Task binding is immutable, and no
  Worker receives a Docker socket or unbounded tool surface.
- **Required evidence:** image/profile digests, Team/Worker readiness, Project
  and Task binding digests, role/tool registry facts, and exact cleanup.
- **Skip/block rules:** a stock Leader is an oracle only; missing readiness,
  ambiguous identity, or cleanup failure is red. Model prose cannot prove a
  Project or Task mutation.

## Full smoke

### F1: Run S — accepted change delivery

- **Purpose:** prove Designer → Implementor → Assessor → Operator coordination,
  explicit approval, exactly-once deployment, post-verify success, requester
  delivery, and `DELIVERED`.
- **Setup:** use a fresh five-role Team, a run-owned fixed Runner broker and
  fixture, and a run-owned disposable deployment target initialized with a
  previous digest. The configured provider/model and runner command remain
  fixed for the run. Before the first Task notification, run the read-only
  `smoke-testing/support/professional-readiness-probe.sh` and require its
  `professional_readiness=pass` result; it verifies AgentTeams phase/roster,
  Worker containers, OpenClaw health, Worker room bindings, and authenticated
  Team-room membership without exposing bearer tokens.
- **Prompt sequence:** the requester starts one Project; the Leader dispatches
  the design, implementation, assessment, and release Tasks. The authenticated
  explicit subject approves the one pending operation; replaying the same
  approval is part of the scenario.
- **Expected observations:** accepted Results bind one final
  `ChangeRevisionRef`; Implementor and Assessor consume the same artifact
  digest; the target journal has one stage, one activation, and one healthy
  verification; the approval/idempotency journal has one operation identity;
  the terminal report and requester delivery both say `DELIVERED`.
- **Required evidence:** Project/Task/Result/WorkRun bindings, Runner plan and
  invocation receipts, deployment receipt and target journal, approval and
  Evidence digests, requester event ID digest, and cleanup proof.
- **Current recorded run:**
  `smoke-testing/runs/2026-08-04-professional-delivery-full-after-cross-turn-approval-dedupe/plan.md`.
- **Blocked claims:** a native AgentTeams status, model text, or one successful
  tool event is not a Tiangong delivery claim.

### F2: Run R — revision and safe rollback

- **Purpose:** prove that an independent assessment can open a new revision,
  approval remains pending until the exact subject approves, post-verify
  failure invokes the pre-authorized rollback once, and only a verified
  previous digest yields `FAILED_SAFE`.
- **Setup:** use a new Team, Project, target, approval identity, and Evidence
  root. Use a deterministic fault mode in the disposable deployment service;
  do not ask a model to invent a failure. Run the read-only
  `smoke-testing/support/professional-readiness-probe.sh` after all five
  Workers and the Team report ready and before the first Task notification.
- **Prompt sequence:** the first Implementor/Assessor wave reaches
  `REVISION_NEEDED`; the Leader creates a new Implementor and Assessor Task
  with a new revision index and digest; the final release enters approval;
  unauthorized and duplicate approval attempts are denied; the authorized
  approval runs once and the injected post-verify failure rolls back.
- **Expected observations:** old Tasks and Results remain immutable; the final
  Assessor and Operator bind the new digest; target state ends at the previous
  digest; previous-digest verification is healthy; the terminal Project report
  says `FAILED_SAFE` and explicitly says the new change was not delivered.
- **Required evidence:** revision transition decision, both immutable revision
  references, approval denial and approval identity, one deploy/rollback
  journal, previous verification, terminal report, hash-chain Evidence, and
  exact cleanup.
- **Negative path:** rollback failure or previous verification failure must
  yield `RECOVERY_REQUIRED`, never `FAILED_SAFE`.

### F3: independent clean rerun

- **Purpose:** demonstrate reproducible safety invariants and safe convergence,
  rather than requiring a non-deterministic model to repeat one nominal
  success path.
- **Setup:** after F1 and F2 cleanup, start from a clean AgentTeams state and
  create new run-owned identities. Do not reuse Tasks, approvals, journals,
  artifacts, or target state. Run the same read-only readiness probe before
  the first Task notification.
- **Expected observations:** each fresh run reaches an explicitly authorized
  safe outcome: `DELIVERED`, `FAILED_SAFE`, `RECOVERY_REQUIRED`, or a bounded
  `FAIL_CLOSED` refusal at a code-owned boundary. The first three outcomes
  require their normal Project/Task/Result/Evidence facts. `FAIL_CLOSED`
  requires a stable error code, no downstream approval/deployment/rollback or
  terminal-delivery side effect, and exact cleanup. Artifact digests and model
  prose may differ between runs.
- **Acceptance meaning:** F3 proves that success, safe rollback, recovery
  uncertainty, and invalid-input refusal remain fail-closed machine outcomes;
  it does not claim that every model-driven rerun reaches `DELIVERED`.
- **Required evidence:** separate run plans, command results, independent
  state verification, stable refusal or terminal dispositions, and cleanup
  proofs.
- **Stop rule:** a second failure of the same class requires a lower-level
  diagnostic or product fix; do not run a third expensive Full smoke.

## Truth table

| Boundary | Pass fact | Fail-closed fact |
|---|---|---|
| Role/Task identity | authenticated assignee and exact binding | forged sender, role, or Task is rejected |
| Revision | new Task and new artifact digest | stale Result or digest is not reusable |
| Assessment | independent Runner sees the exact accepted digest | missing or changed input blocks handoff |
| Approval | exact explicit subject and operation digest | other subject or duplicate pending approval is denied |
| Deployment | one stage/activate/verify with bound receipt | precondition or target mismatch blocks side effect |
| Rollback | previous digest is restored and verified | rollback/verify uncertainty is `RECOVERY_REQUIRED` |
| Report | accepted machine Result and Evidence refs | model prose cannot produce a terminal claim |
| Cleanup | only recorded run-owned resources disappear | any residue keeps the run red |

## Maintenance notes

- Run deterministic Worker tests, static checks, image checks, and `make verify`
  before any Full smoke.
- Preserve only bounded, sanitized evidence. Never commit credentials, raw
  Matrix payloads, raw transcripts, raw model responses, or unrestricted logs.
- Dashboard and Collector traces are diagnostic and cannot replace Project,
  Result, approval, deployment, or hash-chained Evidence.
