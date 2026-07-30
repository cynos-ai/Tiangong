# Reviewer runtime smoke scenarios

## Ownership

- Related implementation: `worker/agent/practices/`, `worker/agent/work/`, `worker/agent/evidence/projection.mjs`, `worker/agent/runtime.mjs`, and `worker/plugin/openclaw-adapter.mjs`
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`
- Related state/Evidence: fixed Reviewer profile, PracticeRun journal/snapshot/protected claim, hash-chained Evidence, transcript-independent ContextPack, and authoritative `workStatus`
- Update triggers: Reviewer profile/tool/schema changes, PracticeRun transitions, Evidence projection, completion rendering, Matrix Harness integration, state-root layout, restart behavior, or cleanup ownership

## Basic smoke

### B1: One-file Reviewer completion through Matrix

- Purpose: Prove the minimum real official Matrix → OpenClaw → Reviewer image → PracticeRun → scoped read → completion → delivered machine-status path.
- Setup:
  - local AgentTeams readiness passes;
  - build `tiangong-worker-reviewer:dev` from the current tree;
  - refuse an existing reserved `tiangong-reviewer-smoke` Worker or container;
  - empty only that identity's reserved storage prefix;
  - create one nonce-bound UTF-8 text fixture in the temporary Worker's workspace.
- Prompt: The Manager sends one visible Matrix mention directing the Reviewer to start one review with one criterion and the exact fixture scope, read the complete file once, and submit one static-review completion claim. The versioned prompt is owned by `matrix-reviewer-roundtrip.sh`.
- Expected observations:
  - the running container uses the locally built Reviewer image ID and fixed Reviewer profile digest;
  - the profile and materialized tool surface are exactly `start_work`, `extend_scope`, `read`, `check_completion`, `abandon_work`;
  - Matrix delivers a response with the code-rendered `worker-local / done / checkpoint passed / static-review-only` status;
  - the PracticeRun journal validates with exactly one `run.started` and one `run.completed`;
  - one successful complete read is bound to the same run and its file digest equals an independent fixture digest;
  - protected completion scope equals final run scope and no `write` or `bash` Evidence exists.
- Required evidence: image ID, profile digest, Matrix request/response event IDs, validated journal and Evidence terminal hashes, run ID/revision, fixture digest match, checkpoint/final-scope match, Harness pass, and exact cleanup pass.
- Skip/block rules: Block if the profile/image, required tools, validated state/Evidence, Matrix delivery, or cleanup cannot be proven. Model prose is never the read or completion oracle.

## Full smoke

### F1: Append-only scope and journal-derived restart recovery

- Purpose: Prove that a later Matrix turn appends file B to the same review, restart recovery comes from the validated PracticeRun journal rather than a snapshot or transcript claim, and final completion binds A+B.
- Setup: Use a fresh reserved Worker and file A. Create file B only after the first turn completes.
- Prompt sequence:
  1. start one run scoped to A, read A completely, and leave the run active;
  2. in a later Matrix event, append only B and leave the run active without reading B or checking completion;
  3. wait until the current journal is durable in the owned storage prefix, delete only the derived PracticeRun snapshot, restart the Worker, validate/rebuild state from the journal, and wait for official Matrix readiness;
  4. request one complete B read, verify the run remains active with complete A+B Evidence, then use a separate final Matrix turn to submit completion against scope A+B.
- Expected observations:
  - every Matrix PUT is replayed with the same transaction ID and resolves to one request event;
  - one run ID and unchanged objective/criteria digests span all phases;
  - exactly one `scope.revised` appends B and scope revision becomes 2;
  - the verified PracticeRun journal is byte-identical across snapshot deletion and restart;
  - the deleted snapshot is rebuilt from that journal and recovered active state has A+B before the post-restart turn;
  - A and B each have one complete same-version read execution with independently computed digests;
  - exactly one `run.completed` binds the protected claim to the final scope digest;
  - Matrix delivers the terminal `worker-local / done / checkpoint passed / static-review-only` status;
  - no write/bash event exists and cleanup is exact.
- Required evidence: four Matrix response event IDs, duplicate-transaction facts, one run ID, objective/criteria/scope digests, journal/Evidence hashes and transition counts, pre/post-restart journal digest, both file digests, terminal status, Harness pass, and cleanup pass.
- Skip/block rules: Keep the run red if restart creates a new run, journal validation/rebuild fails, scope is replaced/reordered, read Evidence is missing/mixed/partial, completion is duplicated, the official Channel Plane is replaced, or cleanup leaves residue.

## Boundary truth table

| Boundary | Intended pass | Intended fail or blocked | Adjacent fact | Replay/recovery fact |
|---|---|---|---|---|
| image/profile | actual Reviewer image ID and exact five tools | kernel/unknown image or capability mismatch | kernel Gate/approval smoke remains separate and must pass | restart retains the same profile digest |
| actor/run | authenticated Manager actor owns one run | wrong actor or new run after restart | direct prose cannot create state | one run ID spans later turns |
| scope | A then append-only B | replacement, reorder, duplicate, or omitted B | objective/criteria stay unchanged | duplicate Matrix transaction does not duplicate `scope.revised` |
| read Evidence | complete A/B versions with independent digests | missing, partial, mixed, wrong-run, or prose-only read | no write/bash Evidence | A Evidence remains valid across restart |
| completion | protected claim scope equals final scope and `run.completed` is unique | failed checkpoint, wrong scope, or prose-only completion | status is rendered from `TurnResult` machine state | duplicate transaction does not duplicate completion |
| recovery | deleted snapshot is rebuilt from the unchanged journal | snapshot/transcript claim used as authority or journal changes | deterministic reset tests separately prove transcript/business-root isolation; official OpenClaw readiness is re-established | recovered ContextPack resumes the active run |
| cleanup | only run-owned Worker/container/helpers/mirrors/prefix are absent | any residue keeps the smoke red | built image remains as a developer artifact | cleanup runs after success or failure |

## Maintenance notes

- Commands: `make test-reviewer-smoke-contract`, `make test-reviewer-image-basic`, and `make test-reviewer-image`.
- The runner never reads unrestricted logs or transcripts as a pass oracle. Failure diagnostics must remain bounded to stable status, IDs, digests, counts, and Harness state.
- The fixed test identity and storage ownership are `tiangong-reviewer-smoke` and `agents/tiangong-reviewer-smoke/` only.
- Basic and Full must run as separate fresh-resource executions so each has exactly one PracticeRun and independently proves cleanup.
- **Current status (2026-07-30):** Basic passed with the machine oracle and exact cleanup. Full proved append-only scope plus journal/snapshot restart recovery, but is BLOCKED after two fresh model-controlled sequences omitted a required post-restart Work/check tool. Do not retry for a favorable model sample or infer Full from deterministic coverage.
