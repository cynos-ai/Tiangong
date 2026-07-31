# Changelog

All notable changes to Tiangong are documented here. Tiangong follows Semantic Versioning and uses `v0.y.z` while public contracts are stabilizing.

## [Unreleased]

### Added

- Reviewer ContextPack v2 with a structured advisory `nextAction` derived from the active PracticeRun and validated read Evidence.
- One practice-owned read-coverage projection shared by completion checkpoint and next-action guidance.

### Verification

- Deterministic next-action, fail-closed Evidence, checkpoint regression, restart reconstruction, Reviewer Basic, image/profile, and exact cleanup checks passed.
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
