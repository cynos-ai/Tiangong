# Changelog

All notable changes to Tiangong are documented here. Tiangong follows Semantic Versioning and uses `v0.y.z` while public contracts are stabilizing.

## [Unreleased]

### Added

- Progressive Pi-to-OpenClaw migration lane: B5 Worker injection now defaults
  to the OpenClaw native hook/tool surface, while the legacy Tiangong harness
  remains an explicit rollback lane. Native runtime selection fails closed
  unless the role-routing gate is present.

## [0.3.0] - 2026-08-17

### Added

- OpenClaw-first five-role delivery path with the built-in OpenClaw runtime for
  Leader, Designer, Assessor, and Operator, and Codex app-server for the
  Implementor coding lane.
- AgentTeams v1.2.2 coordination control API, PostgreSQL-backed Work/Task/
  Result/ToolResult records, Matrix wake delivery, WebUI-visible Team state,
  and fail-closed Leader admission/resume boundaries.
- Shared Codex capability detection, native Responses routing, explicit
  OpenCodex Chat bridge routing, and deployment-owned sidecar lifecycle
  receipts with generation rotation, drain, recovery, and cleanup.
- Fixed role images and authoritative AgentTeams `team_leader` role inference;
  deployment injection remains explicit where the upstream REST surface omits
  Worker environment fields.

### Security

- Disposable Runner containers now clear Worker role identity as well as
  runtime/provider environment, preventing professional-role authority from
  crossing into command execution.
- Provider keys, Worker consumer tokens, Matrix credentials, and sidecar
  secrets remain deployment-scoped and are not stored in source, images,
  receipts, ToolResults, or logs.

### Verification

- Worker package CI: **406/406** tests passed; production dependency audit,
  image build, Docker executor isolation, Runner broker, and deployment service
  checks passed.
- Phase B/C DeepSeek route and sidecar lifecycle evidence passed, including
  native Codex success, OpenClaw-versus-Codex A/B, restart/recovery, rotation,
  WebUI/Matrix seams, and exact cleanup.

### Known limitations

- AgentTeams v1.2.2 `agt`/REST does not preserve the Worker `env`/role binding
  fields required by Tiangong, so production deployments must inject the
  reviewed role, Coordination endpoint/token, and sidecar receipt through the
  deployment-owned adapter.
- The current local AgentTeams gateway catalog does not admit Qwen Coding Plan
  `qwen3.7-plus`; the direct upstream route is separate evidence and this
  release does not claim a formal Qwen Team ToolResult green path.
- AgentTeams does not provide a native OpenCodex sidecar lifecycle manager;
  sidecar provisioning and rotation remain deployment-owned.

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
