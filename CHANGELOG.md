# Changelog

All notable changes to Tiangong are documented here. Tiangong follows Semantic Versioning and uses `v0.y.z` while public contracts are stabilizing.

## [Unreleased]

### Added

- Added durable Room-level Matrix message admission, Leader routing to an open or new Work, bounded backlog metrics, and authenticated association correction without copying Human message bodies.
- Added Work display titles, nullable initial WorkSpec, immutable Plan ContentRefs, and Work/Task/Result projections for the product path.
- Added Leader OpenClaw hooks and tools for routing, WorkSpec/Plan changes, dynamic Tasks, cancellation, and Work completion/stopping.
- Added six versioned long-lived Agent packages for Leader, Architect, Challenger, Developer, Reviewer, and Tester, with fixed runtime/model, capability profile, and one-Work/one-Task logical-session policy.
- Added six portable product Skills with trigger and behavior cases, digest locks, installed ∩ `MemberConfig.allowedSkills` resolution, autonomous `tiangong_use_skill` selection, and bounded ToolResult usage metadata.
- Added read-only runtime projections for configured Agents, active Tasks, logical sessions, enabled Skills, and actually observed Skill use.
- Added the M3 chat-first Web workbench with Matrix login, Room history pagination, live sync, local echo, ordinary Human message send, Team/Room navigation, Leader backlog metrics, and side-by-side Work facts.
- Added bounded Work timeline payload projection plus Plan history, candidate deliverables, Challenger Results, Agent/model/actual Skill use, Task/Result/ToolResult, deliverable, waiting, cancellation, and recovery-state rendering.
- Added an in-memory Matrix Web session gateway with HttpOnly/SameSite cookies, CSRF checks, current `whoami` and bound-Room membership validation, SSE revocation, unencrypted-Room enforcement, strict CSP, and no browser credential storage.

### Changed

- Replaced per-Task acceptance decisions with Result/cancellation projection and machine-fact CloseGuard checks.
- Replaced role-specific Worker image targets with one generic `tg-worker` contract and MemberConfig-bound responsibility/runtime/model/Agent-package routing. All six initial responsibilities now use OpenClaw built-in and default to `glm-5`; AgentTeams remains authoritative for Provider credentials and per-Worker model changes.
- Made the documented Phase C contract entrypoint and nested shell calls repeatable in a Linux tracked checkout.
- Replaced the root runtime-console page with the single M3 Team/Room + Matrix conversation + Work facts workbench; selecting a Work remains view-only and the send API rejects Work routing fields.
- Matrix URL alone now enables Human Web chat; the deployment Matrix token remains optional and enables only the outbox consumer.

### Fixed

- Stopped the active Worker build from building or probing Codex/OpenCodex canary, cache, sidecar, receipt, and adapter images; the initial product runtime is OpenClaw built-in.
- Made Agent package `defaultModel` an initial value rather than a permanent model lock: an AgentTeams-administered per-Worker model change is accepted only through a new MemberConfig revision whose model matches the authenticated `AGENTTEAMS_MODEL`; Task and prompt input remain non-authoritative.
- Made OpenClaw `tool_result_persist` capture synchronous so a denied tool cannot leave an unhandled persistence rejection; the ToolResult store now provides synchronized atomic append while rejecting linked or abnormal state.
- Corrected the Developer injection default capability-cache hostname to the deployment-owned `tiangong-codex-capability-cache` service name.

### Removed

- Removed CoordinationDecision endpoints, store methods, persistence columns, and `accepted`/`blocked` Task states from the active Work path.
- Removed the old role-runtime Docker injection entrypoint and role-specific Docker build targets.

### Verification

- Completed a disposable local M6 real-project delivery run through WorkSpec, candidate Plan and independent Challenge, a signed-off Developer Commit, independent Reviewer and Tester Results, CloseGuard, and a clean rerun; Push, deployment, and production writes remained closed.
- The deterministic Phase C boundary, `387/387` Worker tests, product Agent/Skill package checks, generic demo contract, and six-responsibility MemberConfig injection contract pass.
- The M3 focused App contract passes `18/18`, covering Matrix identity/session containment, CSRF, Room binding, pagination projection, Human sender preservation, response bounds, one active sync, revocation, E2EE denial, strict CSP, and Work fact rendering.
- The full App suite passes `33/33` against an owned disposable PostgreSQL 16 container, including Task SessionRef persistence, Room routing, correction, restart, Web projection, and cleanup; without injected test variables the same four PostgreSQL cases remain explicit skips.
- The deployment-owned Coordination image builds with the M3 assets and gateway; browser inspection confirms the three-column workbench, view-only Work selection, ordinary message send, independent right-panel scrolling, and zero new console errors.
- A disposable unencrypted Synapse `v1.159.0` Basic run verified real Matrix login, joined-Room history/sync/send, preserved `@human:m3.local` sender, Matrix event echo, `workSpec: null` rendering, and exact container/volume/process/state cleanup. This is M3 Web protocol evidence, not the M4 AgentTeams/model/project vertical.

## [0.4.1] - 2026-08-19

### Verification

- Verified the bare official AgentTeams v1.2.2 baseline: Worker readiness,
  Active Team convergence, Team-scoped MinIO access, and Matrix delivery all
  work without Tiangong images or plugins.
- Verified the official-infrastructure plus Tiangong-orchestration canary with
  DeepSeek v4 Flash, including Leader resume, Work/Task/Result, Matrix handoff,
  fail-closed Implementor blocking, requester reporting, and exact cleanup.
- Kept the Phase C deterministic boundary green and documented the remaining
  conservative full-Gate terminal-branch oracle limitation.
- Passed the full Worker and App test suites in the Linux Node 22 release
  environment; disposable PostgreSQL cases remain opt-in when no test database
  is injected.

### Boundaries

- OpenClaw remains the model/session runtime; Codex app-server remains the
  Implementor coding runtime; Tiangong owns only programmatic coordination,
  gates, evidence, recovery, and control tools.
- The historical Tiangong Pi runtime is not restored.

## [0.4.0] - 2026-08-19

### Changed

- DeepSeek-only runtime clean-cut: the Tiangong-owned `tiangong-pi` harness,
  Pi session store, legacy runtime fallback, and Pi package are removed.
  Leader, Designer, Assessor, and Operator use OpenClaw built-in; Implementor
  uses OpenClaw's official Codex app-server with fallback disabled.
- Qwen/Coding Plan and Chat-only bridge remain later optional canaries and do
  not block the current DeepSeek release.

## [0.3.1] - 2026-08-19

### Fixed

- Phase C role-injection contract tests now honor the selected Codex model
  instead of hard-coding `deepseek-v4-pro`; the default remains unchanged and
  explicit `deepseek-v4-flash` canaries are verified correctly.

### Verification

- Real AgentTeams Gate B passed with `deepseek-v4-flash` on the Implementor
  Codex lane, including native Responses, role reinjection after Manager
  restart, Matrix Result/Requester reporting, and exact cleanup.
- Deterministic Phase C, Worker, App, repository, shell, DCO, Gitleaks, and
  Worker package checks passed.

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
