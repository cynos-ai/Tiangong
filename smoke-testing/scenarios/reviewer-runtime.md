# Reviewer runtime smoke scenarios

## Ownership

- Related implementation: `worker/agent/practices/`, `worker/agent/work/`, `worker/agent/artifacts/`, `worker/agent/evidence/projection.mjs`, `worker/agent/runtime.mjs`, and `worker/plugin/openclaw-adapter.mjs`
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`
- Related state/Evidence: fixed Reviewer v2 profile, PracticeRun v2 journal/snapshot/protected claim, CapturedArtifactStore, hash-chained Evidence, transcript-independent ContextPack v3, and authoritative `workStatus`
- Update triggers: profile/kind/tool/schema changes, target capture/consumption, manifest producer, Evidence projection, checkpoint rendering, Matrix Harness integration, state-root layout, restart behavior, model baseline, or cleanup ownership

## Basic smoke

### B1: Directory target completion through Matrix

- Purpose: Prove the minimum official Matrix → OpenClaw → Reviewer image → immutable directory target → bounded inspection → every-member consumption → completion → delivery path.
- Setup: Build the current Reviewer image, refuse an existing reserved Worker/container, empty only its owned storage prefix, and create one nonce-owned directory with `one.txt`, `two.txt`, and an explicit `excluded/ignored.txt` subtree.
- Prompt: One Matrix mention requests exactly one directory target (`include=[.]`, `exclude=[excluded]`), one list, one literal search, complete reads of both manifest members by runtime target ID, and one target-ID claim.
- Expected observations:
  - actual profile is v2 with exactly `file,directory_snapshot` and six tools;
  - Matrix delivers `worker-local / done / checkpoint passed / targets 1 / static-review-only`;
  - one `run.started` binds a canonical manifest Artifact and one runtime target ID;
  - list/search have successful bounded Artifact/Evidence but do not satisfy member coverage;
  - both selected member digests equal independently calculated fixture digests;
  - `run.completed` binds the final scope digest and protected claim target IDs;
  - excluded content is absent from the manifest and no write/edit/bash Evidence exists.
- Required evidence: image/profile/kind/tool identities, Matrix event IDs, journal/Evidence/artifact joins, run/target/snapshot IDs, independent member digests, inspection counts, checkpoint, Harness pass, and exact cleanup.
- Skip/block rules: Block if any machine fact, official delivery, Store join, or cleanup cannot be proven. Model prose is never the oracle.

## Recovery Full smoke

### F1: Append-only directory targets and journal/Store-derived restart recovery

- Purpose: Prove append-only target CAS plus separate journal/manifest recovery without making post-restart model liveness the state oracle.
- Setup: Use a fresh reserved Worker and directory A with two selected members plus an excluded subtree. Create the equivalent directory B only after the first turn.
- Prompt sequence:
  1. start one run with directory target A, consume both members, and leave it active;
  2. append only directory target B in a later Matrix turn and leave it unread;
  3. wait for the current journal in the owned remote prefix, delete only the derived PracticeRun snapshot, restart, and wait for official readiness;
  4. validate/rebuild the same ordered target IDs, snapshot identities, scope digest, and manifest Artifacts without another model turn.
- Expected observations:
  - Matrix transaction replay resolves to one request event per turn;
  - one run ID and unchanged objective/criteria digests span both turns;
  - exactly one `scope.revised` appends B without modifying A;
  - A has two independently digest-matched complete reads while B remains unread;
  - journal and Evidence boundary are unchanged across restart;
  - snapshot is rebuilt from journal and both manifests validate from CapturedArtifactStore, not live recapture;
  - no checkpoint/completion or mutation Evidence exists;
  - Harness and exact cleanup pass.
- Required evidence: Matrix response IDs, run/target/snapshot/scope identities, member digests, journal/Evidence hashes and counts, pre/post journal digest, manifest joins, snapshot rebuild, Harness, and cleanup.
- Skip/block rules: Keep red on a new run, target replacement/reorder, journal or Artifact change, invalid rebuild, Channel Plane substitution, or cleanup residue.

## Journey canary

### C1: Post-restart progression with target-ID guidance

- Purpose: Observe model-driven liveness after F1 when ContextPack v3 identifies unread target B; it is not an authorization, persistence, recovery, or release oracle.
- Prompt sequence: request complete reads for B's two members, verify matching Evidence, then request target-ID completion in a separate turn.
- PASS oracle: both B resources have complete independently matched reads; exactly one final-scope claim/checkpoint and `run.completed` produce done/passed on the original run.
- Non-PASS outcomes: `NO_VALID_READ_EVIDENCE`, `NO_VALID_COMPLETION`, or `INCONCLUSIVE`, with bounded lifecycle counts and unchanged safe state before exact cleanup.
- Rules:
  - deterministic tests, not model behavior, prove `CONSUME_REMAINING_TARGETS` with B's runtime target ID;
  - do not record raw ContextPack, query, manifest, Artifact ref, member content, or transcript as diagnostics;
  - run once per declared image/provider/model artifact; never weaken the PASS oracle;
  - no-progress must not create false consumption/checkpoint Evidence or done state;
  - cleanup failure always remains red.

## Boundary truth table

| Boundary | Hard intended pass | Hard fail/block | Journey observation |
|---|---|---|---|
| image/profile | v2, two kinds, exact six tools | unknown image/kind/tool mismatch | same fixed profile |
| actor/run | one authenticated actor and run | wrong actor/new run | original run remains authoritative |
| target scope | A then append-only B | replacement/reorder/duplicate | final claim uses ordered target IDs |
| manifest/inspection | journal-bound manifest; bounded list/search | missing/tampered/cross-target Artifact | inspection never grants coverage |
| consume Evidence | every A member, correct snapshot/digest | missing/wrong-run/changed A | observe both B members or safe no-progress |
| recovery | unchanged journal/Evidence and same manifest Artifacts | live recapture, snapshot authority, invalid Store join | Context v3 derives B target guidance |
| completion | active/not-run after recovery | false checkpoint/completion | optional exact done/passed oracle |
| cleanup | owned resources absent | any residue | always mandatory |

## Maintenance notes

- Commands: `make test-reviewer-smoke-contract`, `make test-reviewer-image-basic`, `make test-reviewer-image`, and `make test-reviewer-journey-canary`.
- `test-reviewer-image` is the hard Recovery Full gate; Journey remains separate and non-gating.
- Deterministic tests own schema, capture ordering, Evidence/Store joins, coverage, concurrency, limits, privacy, and target-ID mapping.
- Never use unrestricted logs, transcripts, model wording, filesystem traversal order, or raw Artifact refs as an oracle.
- Fixed ownership is Worker `tiangong-reviewer-smoke` and storage `agents/tiangong-reviewer-smoke/` only; every level uses a fresh Worker and independently proves cleanup.
- Historical Reviewer v1 and nextAction canary outcomes remain in their dated run plans; they are not the v2 release oracle.
