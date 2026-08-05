# Changelog

All notable changes to Tiangong are documented here. Tiangong follows Semantic Versioning and uses `v0.y.z` while public contracts are stabilizing.

## [Unreleased]

## [0.2.0] - 2026-08-05

### Added

- Closed five-role Tiangong delivery runtime: Team Leader, Designer, Implementor, Assessor, and Operator.
- Digest-bound RoleProfiles with code-owned SOUL and Skill resources; environment, prompts, Worker names, and assignment text cannot select authority.
- Role-neutral WorkRun bindings and guarded hash-chained phase journals for Task-local recovery.
- Phase 4 revision, approval, rollback, `FAILED_SAFE`/`RECOVERY_REQUIRED`, idempotency, and Leader restart regressions.
- Evidence-first professional delivery smoke scenario and demo walkthrough with explicit Run S/Run R/clean-rerun gates.
- Deterministic with/without Skill evaluation and a checked five-role, Playbook-lock, and Runner-fixture demo contract.

### Security

- Historical Reviewer and Practice code is not an active runtime path or compatibility shim.
- WorkRun, Evidence, idempotency, pending-operation, and rollback state remain physically separate from pi transcripts; tampering and invalid transitions fail closed.

### Verification

- Worker deterministic suite passes 271/271 after the RoleProfile/WorkRun clean cut and demo-contract check.
- RoleProfile/Skill image checks, TeamPlaybook binding checks, Phase 4 recovery tests, deployment recovery tests, and existing Runner/approval boundaries pass.

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
