# Changelog

All notable changes to Tiangong are documented here. Tiangong follows Semantic Versioning and uses `v0.y.z` while public contracts are stabilizing.

## [Unreleased]

### Added

- Reviewer ContextPack v2 with a structured advisory `nextAction` derived from the active PracticeRun and validated read Evidence.
- One practice-owned read-coverage projection shared by completion checkpoint and next-action guidance.
- Non-model CapturedArtifactStore v1 infrastructure with exact practice-target bindings, canonical envelopes, kernel-locked atomic persistence, bounded replay/read joins, quotas, tamper checks, and a transcript-independent state root.
- Reviewer v2 with clean-cut append-only `file` and `directory_snapshot` targets, immutable-at-admission snapshots, target-bound reads, canonical directory manifests, and bounded list/literal-search inspection.
- PracticeRun/journal/claim v2, checkpoint `review-v2`, ContextPack v3 target guidance, target-count status/telemetry, and durable Artifact/Evidence replay across restart.

### Security

- Captured Artifact bytes remain outside Evidence and model-visible metadata. They are visible to Worker/storage administrators, have no v1 purge or end-to-end-encryption claim, and grant no authority without the exact current journal/Evidence binding join.
- Directory admission rejects workspace escape, symlinks, hardlinks, sensitive paths, unsupported text, unstable captures, infeasible coverage, and quota overflow; source change, Artifact tamper, cross-target reuse, stale revision, or lifecycle-lock failure remains fail closed.

### Verification

- Deterministic next-action, fail-closed Evidence, checkpoint regression, restart reconstruction, Reviewer Basic, image/profile, and exact cleanup checks passed.
- CapturedArtifactStore schema/golden identity, text policy, permission, symlink/tamper, replay/conflict, quota, temporary cleanup, restart/reset, cross-process kernel lock, ID collision, privacy, retention-isolation, and Worker-image lock-binding checks passed.
- Reviewer v2 deterministic target admission, atomic extension, scope CAS, directory ordering/selection, read/inspection replay, coverage, checkpoint, source-race, Artifact-authority, lifecycle-cap, restart, privacy, and old-schema rejection checks passed.
- Reviewer v2 fixed image/profile/kind/tool checks, official Matrix directory Basic, append-only journal/Store-derived Recovery Full, Harness, machine oracle, and exact cleanup passed.
- The one declared focused Journey canary safely returned `NO_VALID_READ_EVIDENCE`: the model reread A instead of B without false B Evidence, checkpoint, completion, mutation, or a new run.

## [0.1.0] - 2026-07-31

### Added

- A public AgentTeams/OpenClaw Worker runtime with pinned public dependencies, a Worker-scoped gateway boundary, and official Matrix delivery.
- Gated workspace reads and approval-bound atomic writes with durable pending state, requester authorization, restart recovery, exactly-once replay, rollback, reconciliation, payload erasure, Evidence rotation, and explicit retention.
- Sanitized OpenTelemetry turn diagnostics and bounded deterministic peer-transport probes that do not claim Team Work.
- Fixed digest-bound role profiles backed by closed role, practice, tool, Gate, and methodology registries.
- Reviewer v1 for Worker-local, static-only review of explicit bounded UTF-8 workspace files.
- Append-only PracticeRun scope, hash-chained journals, rebuildable snapshots, protected claims, file-version read Evidence, deterministic completion checkpoints, and machine-rendered work status.
- Official Matrix Reviewer Basic and Recovery Full smoke gates, a non-gating model-liveness Journey canary, exact resource cleanup, and public smoke evidence.

### Security

- Transcript reset is physically isolated from PracticeRun, Evidence, idempotency, pending-operation, and rollback roots.
- Authorization, actor binding, scope restrictions, idempotency, Evidence selection, path safety, recovery, and cleanup are enforced in code rather than prompts.
- Claims, model prose, machine state, Machine Evidence, and telemetry remain separate facts.

### Known limitations

See [`docs/releases/v0.1.0.md`](docs/releases/v0.1.0.md). Reviewer v1 does not inspect directories, git diffs, commits, branches, or pull requests; execute tests or commands; mutate the workspace; or claim immutable freshness or Team verification. Post-restart model-driven progression depends on the configured model, while no-progress remains safely active without false Evidence or completion.

### Compatibility

This is the first public Tiangong release. There are no prior public versions or migration requirements.
