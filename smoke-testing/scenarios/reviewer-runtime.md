# Reviewer runtime smoke scenarios

## Ownership

- Related implementation: `worker/agent/practices/`, `worker/agent/work/`, `worker/agent/evidence/projection.mjs`, `worker/agent/runtime.mjs`, and `worker/plugin/openclaw-adapter.mjs`
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`
- Related state/Evidence: fixed Reviewer profile, PracticeRun journal/snapshot/protected claim, hash-chained Evidence, transcript-independent ContextPack v2 with advisory `nextAction`, and authoritative `workStatus`
- Update triggers: Reviewer profile/tool/schema changes, PracticeRun transitions, Evidence projection, completion rendering, Matrix Harness integration, state-root layout, restart behavior, model baseline, or cleanup ownership

## Basic smoke

### B1: One-file Reviewer completion through Matrix

- Purpose: Prove the minimum official Matrix → OpenClaw → Reviewer image → PracticeRun → scoped read → completion → delivered machine-status path.
- Setup: Build the current Reviewer image, refuse an existing reserved Worker/container, empty only its owned storage prefix, and create one nonce-bound UTF-8 fixture.
- Prompt: One Matrix mention requests exactly one start, one complete scoped read, and one static-review completion claim.
- Expected observations:
  - actual image/profile and materialized tools are the fixed Reviewer values;
  - Matrix delivers `worker-local / done / checkpoint passed / static-review-only`;
  - one valid `run.started`, complete read, and `run.completed` bind the same run;
  - selected read digest equals the independently calculated fixture digest;
  - protected claim scope equals final scope and no write/edit/bash Evidence exists.
- Required evidence: image/profile digests, Matrix event IDs, journal/Evidence hashes, run ID/revision, digest and checkpoint matches, Harness pass, and exact cleanup.
- Skip/block rules: Block if any required machine fact, official delivery, or cleanup cannot be proven. Model prose is never the oracle.

## Recovery Full smoke

### F1: Append-only scope and journal-derived restart recovery

- Purpose: Prove the release-critical multi-turn scope and recovery safety boundary without making post-restart model liveness the state oracle.
- Setup: Use a fresh reserved Worker and file A. Create B only after the first turn.
- Prompt sequence:
  1. start one run scoped to A, read A completely, and leave it active;
  2. append only B in a later Matrix turn and leave the run active;
  3. wait for the current journal in the owned remote prefix, delete only the derived snapshot, restart, and wait for official readiness;
  4. validate/rebuild the same active A+B state without another model turn.
- Expected observations:
  - Matrix transaction replay resolves to one request event;
  - one run ID and unchanged objective/criteria digests span both turns;
  - exactly one `scope.revised` appends B; A has one complete digest-matched read;
  - journal bytes and Evidence boundary are unchanged across restart;
  - snapshot is rebuilt from the journal and active A+B state is recovered;
  - no checkpoint/completion or write/edit/bash Evidence exists;
  - Harness and exact cleanup pass.
- Required evidence: two Matrix response IDs, duplicate-transaction facts, run/objective/criteria/scope digests, journal/Evidence hashes and counts, pre/post journal digest, snapshot rebuild, Harness, and cleanup.
- Skip/block rules: Keep red if a new run appears, scope changes incorrectly, journal/Evidence validation fails, snapshot is not rebuilt, the official Channel Plane is replaced, or cleanup leaves residue.

## Journey canary

### C1: Post-restart model progression with machine-derived guidance

- Purpose: Observe model-driven liveness after F1 when ContextPack v2 deterministically identifies unread B; it is not an authorization, persistence, recovery, or release oracle.
- Setup: Repeat F1 with a separate fresh Worker, then continue after recovery.
- Prompt sequence: request one complete B read, verify active A+B Evidence, then request completion in a separate turn.
- PASS oracle: B has at least one complete independently matched read; exactly one final-scope claim/checkpoint and `run.completed` produce terminal done/passed status on the original run.
- Non-PASS outcomes: `NO_VALID_READ_EVIDENCE`, `NO_VALID_COMPLETION`, or `INCONCLUSIVE`, with bounded lifecycle counts and unchanged safe state recorded before exact cleanup.
- Rules:
  - deterministic tests, not model behavior, prove that the recovered A+B run derives `READ_REMAINING_SCOPE` for `scope-file-2`;
  - do not record the raw ContextPack or paths as smoke diagnostics, and do not infer guidance injection from assistant prose;
  - run once per declared image/provider/model artifact; do not sample until green;
  - never weaken the PASS oracle or infer execution from prose;
  - a no-progress turn must not create false read/completion Evidence or advance done;
  - canary failure is reported as model/integration liveness only after machine Evidence excludes product/oracle failure;
  - cleanup failure always remains red.

## Boundary truth table

| Boundary | Hard intended pass | Hard fail/block | Journey observation |
|---|---|---|---|
| image/profile | actual Reviewer image and exact five tools | unknown image/capability mismatch | same fixed profile |
| actor/run | one authenticated actor and run | wrong actor/new run | original run remains authoritative |
| scope | A then append-only B | replacement/reorder/duplicate | final claim, if any, uses A+B |
| read Evidence | complete A, correct digest | missing/mixed/wrong-run A | observe complete B or safe no-progress |
| recovery | unchanged journal/Evidence rebuild active A+B | journal change, snapshot authority, invalid rebuild | model receives recovered active context with advisory guidance |
| completion | active/not-run after recovery | false checkpoint or completion | optional exact done/passed oracle |
| cleanup | owned resources absent | any residue | always mandatory |

## Maintenance notes

- Commands: `make test-reviewer-smoke-contract`, `make test-reviewer-image-basic`, `make test-reviewer-image`, and `make test-reviewer-journey-canary`.
- `test-reviewer-image` is the hard Recovery Full gate; the journey command is intentionally separate and non-gating.
- Raw ContextPack inspection is not a smoke oracle. Focused deterministic tests own schema, Evidence-bound coverage, fail-closed projection, and `scope-file-N` mapping.
- Never read unrestricted logs or transcripts as an oracle. Diagnostics remain bounded to state, stable IDs/digests, lifecycle counts, and Harness status.
- The fixed ownership is Worker `tiangong-reviewer-smoke` and storage `agents/tiangong-reviewer-smoke/` only.
- Every level uses a separate fresh Worker and independently proves cleanup.
- **Release baseline (2026-07-30):** Basic and Recovery Full hard gates passed. The single qwen3.5-plus Journey run returned `NO_VALID_READ_EVIDENCE`: it safely reread A instead of B, stayed active, and cleanup passed.
- **nextAction focused run (2026-07-31):** deterministic ContextPack v2 guidance, image/profile, Reviewer Basic, and exact cleanup passed. The one declared Journey canary again returned `NO_VALID_READ_EVIDENCE`: the model safely reread A despite machine-derived guidance for B; no false B Evidence, checkpoint, completion, mutation, or new run appeared.
