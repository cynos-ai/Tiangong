# Tiangong

Tiangong is an evidence-backed AI software engineering team built on [AgentTeams](https://github.com/agentscope-ai/AgentTeams).

> [!NOTE]
> v0.4.1 is the latest source release and records the completed OpenClaw runtime migration. Current development has implemented M0–M3 and M5: the coordination foundation, six long-lived Agent packages, capability-bound portable Skills, a chat-first Matrix workbench, and the OpenClaw built-in execution foundation. A disposable local M6 real-project coding vertical has also completed the WorkSpec → Plan/Challenge → Developer Commit → independent Review/Tester → CloseGuard → clean-rerun path; this does not claim production deployment. See the [v0.4.1 release notes](docs/releases/v0.4.1.md), [product MVP](docs/design/product-mvp.zh.md), and [changelog](CHANGELOG.md).
>
> The implementation-independent target is defined by the [team-control design](docs/design/evidence-backed-team-control.md) ([中文](docs/design/evidence-backed-team-control.zh.md)). The first public product slice is specified separately in the [product MVP design（中文）](docs/design/product-mvp.zh.md); it does not claim those capabilities already exist.

## Vision

Tiangong coordinates specialized software-engineering agents while requiring completion claims to be backed by captured evidence, independent verification, and explicit approval for high-risk actions.

## Local AgentTeams quick start

> New to the local stack? Read the [local development guide (中文)](docs/local-development-guide.md) first. It covers environment pitfalls (npm registry mirror, Docker mirror 404s, pinned versions), the Dashboard chat limitation, and the verified message format for talking to Workers.

The bootstrap is pinned to the public AgentTeams `v1.2.2` release and verifies the upstream installer checksum before execution. Container images are still resolved by upstream tags rather than immutable digests, so this is not a fully reproducible or supply-chain-hermetic deployment.

### Prerequisites

- Linux or macOS
- Bash
- Docker with a running daemon
- `curl` and `make`
- An API key for Alibaba Cloud Coding Plan or another OpenAI-compatible LLM provider
- At least 4 CPU cores and 8 GiB of memory recommended for Manager plus a small team

### Configure

```bash
make init
```

Edit the generated `.env` and set at least:

```dotenv
AGENTTEAMS_LLM_API_KEY=your-api-key
```

The defaults use Alibaba Cloud Coding Plan with `glm-5`. Provider credentials and routing are configured through AgentTeams. To use another official AgentTeams provider or model, update `AGENTTEAMS_OPENAI_BASE_URL` and `AGENTTEAMS_DEFAULT_MODEL`, then revise the affected Worker through AgentTeams so Tiangong can bind the new model as a fresh MemberConfig revision.

The configuration parser accepts one `KEY=VALUE` assignment per line; it does not execute shell syntax. Never commit `.env`.

Generated credentials, the Manager workspace, the host-share directory, and the verified installer cache are fixed beneath the ignored `.runtime/agentteams/` directory. AgentTeams also creates the `tiangong-agentteams-data` Docker volume, `agentteams-*` containers, the `agentteams-net` network, and tagged container images outside the repository.

### Start and verify readiness

```bash
make up
make verify
make login
```

Open the Element URL printed by `make login`. The command reports the local generated credential file but does not print the password itself.

Common operations:

```bash
make status
make logs                         # Manager logs
make logs SERVICE=controller      # Controller logs
make stop                         # Preserve data
make start
CONFIRM=delete-tiangong-agentteams-data make uninstall  # Delete the local stack and generated data
```

Run `make help` for the complete command list. Uninstall removes the Tiangong-owned AgentTeams containers, network, Docker volume, and `.runtime/agentteams/` tree after validating their fixed targets; it preserves `.env` and downloaded container images.

### OpenClaw-native Worker image smoke test

The local Worker image extends the public AgentTeams `v1.2.2` Worker image at an immutable digest and retains its pinned Node.js `22.23.2` runtime. All initial professional turns, including Developer coding turns, run through OpenClaw's built-in runtime. Tiangong contributes only its control plugin, Agent/Skill tools, gates, coordination, and direct machine facts.

With AgentTeams running, choose the fast channel smoke or the full approval smoke:

```bash
make test-worker-image-basic  # Gateway, Matrix, persistent session, credential boundary
make test-worker-image        # Also Gate, restart recovery, approval, replay, and Evidence
```

Both levels build `tg-worker:dev`, create a disposable Worker through the AgentTeams declarative API, and use the real Worker-scoped Gateway and Matrix room. The Basic smoke validates a gated `read` through Matrix, an exact nonce response, matching Evidence, and the credential boundary.

The Full smoke additionally exercises a constrained workspace write, approval, Worker restart, replay, and Evidence. Cross-Worker-restart recovery uses a versioned Tiangong pending-operation envelope and does not depend on a Tiangong-owned model transcript.

Cleanup removes the temporary Worker and the exact MinIO prefix owned by the reserved smoke identity. It never operates on another Worker prefix. Provider credentials are not copied into the image, repository, model configuration, session, or Evidence.

The Worker resource retains AgentTeams' supported `openclaw` runtime, Node.js version, entrypoint, and gateway. A narrow `openclaw` command wrapper injects the Tiangong control plugin path into the generated configuration and then delegates to the upstream executable. OpenClaw continues to own Matrix, model turns, configuration retrieval, storage sync, re-login, readiness, channel policy, and reply delivery. Tiangong owns Work/WorkSpec/Plan/Task/Result coordination, bounded execution records, Operation policy, recovery, and its product experience.

Optional, backend-neutral Worker tracing is documented in [`docs/observability.md`](./docs/observability.md). It is disabled by default, exports only allowlisted sanitized OpenTelemetry spans, and remains diagnostic telemetry rather than authorization or hash-chained Evidence. The bounded [`peer transport diagnostic`](./docs/peer-transport-diagnostic.md) keeps exact ping/pong markers in deterministic Worker code while deriving targets only from authenticated effective Matrix allowlists; it is transport-only and is not Team Work or Evidence.

### Chat-first Matrix workbench

The deployment-owned Coordination runtime now serves the M3 workbench at its root URL. A Human signs in with a current Matrix identity; Tiangong keeps the resulting access token only in a bounded in-memory session and returns an HttpOnly, SameSite cookie. Every chat, runtime-fact request, and SSE update rechecks Matrix identity and membership in the configured unencrypted Team Room. Session revocation closes the fact stream, and process restart forgets all Web sessions.

The workbench uses Matrix history/sync/send for the center conversation and never stores message bodies in PostgreSQL. The left rail shows the configured Team/Room and Leader admission backlog. The right panel projects Room Work history, nullable WorkSpec, Plan refs/history, Challenger and other Results, Agent/model/actual Skill use, Tasks, ToolResults, deliverables, and timeline facts. Selecting a Work changes only that panel; the send contract rejects any Work routing field.

Set `AGENTTEAMS_MATRIX_URL` in the Coordination runtime environment to enable Human Web login. `TIANGONG_COORDINATION_MATRIX_TOKEN` remains optional and enables only the deployment-owned outbox sender. HTTPS deployments keep secure cookies enabled; a loopback HTTP development deployment must explicitly set `TIANGONG_WEB_SECURE_COOKIES=0`. Encrypted Rooms fail closed in the first version.

Run the focused deterministic contract with:

```bash
make test-chat-first-web
```

The current runtime is intentionally constrained:

- it claims only the Worker-scoped `agentteams-gateway` provider and disables OpenClaw's fallback to another agent harness;
- provider credentials stay deployment-scoped and are injected by the selected OpenClaw runtime only in memory;
- unapproved OpenClaw extensions, prompt templates, and automatic repository context are disabled;
- one generic `tg-worker` image is configured by authenticated AgentTeams identity, MemberConfig, ControlProfile, and deployment-owned runtime bindings; image names, prompts, and Task text cannot grant a responsibility or capability;
- runtime, current AgentTeams Worker model, Agent package, capability profile, and allowed Skill set are fixed by the current MemberConfig revision and checked before OpenClaw configuration mutation and on each new turn; Provider/model changes use AgentTeams administration rather than Task or prompt input;
- the six initial Agent packages are Leader, Architect, Challenger, Developer, Reviewer, and Tester; Leader uses one logical session per Work and every professional Task receives its own deterministic logical session reference;
- top-level tools are fail-closed from Agent package `toolGroups`: Leader gets coordination plus Skill runtime, while the five professional members get Skill runtime plus the machine-locked OpenClaw workspace tools; deployments remain responsible for each isolated workspace, credential, and network boundary;
- product Skill authority is exactly the digest-locked Agent-package installation intersected with `MemberConfig.allowedSkills`; the Agent selects an enabled Skill through `tiangong_use_skill`, and the bounded ToolResult records its ID/version/content digest without granting capabilities;
- OpenClaw owns its conversation/session persistence; Tiangong coordination and control state uses independent protected storage, so conversation reset cannot erase product facts;
- restartable writes persist a digest-bound operation envelope and a separate mode-`600` content payload under that state directory; raw write content never enters Evidence, but is visible to principals with Worker storage administration access and follows explicit operation retention;
- only gated `read` and path-restricted, atomic `write` are active; `write` requires persisted approval from the same authenticated Matrix sender that requested it, ignores upstream owner assertions for authorization, supports restart recovery, and blocks duplicate execution;
- runtime state, credential-bearing paths, symlink traversal, workspace escape, image input, and unbounded shell access are unavailable to the gated tool surface.

To build and inspect the image without creating a Worker:

```bash
make build-worker-image
docker run --rm --entrypoint openclaw tg-worker:dev --version
```

The active build produces one generic `tg-worker:dev` runtime plus the deployment-owned runner/deployment service images; Codex/OpenCodex auxiliary targets are not built by the product path. It does not build role-specific Worker images. The initial MemberConfig contract routes all six professional Agents through OpenClaw built-in and defaults them to `glm-5`. An administrator may change a specific Worker's Provider/model through AgentTeams; Tiangong accepts the model only when it matches the authenticated Worker projection and records the change as a new MemberConfig revision. A Task, prompt, or Skill cannot change it.

### Interrupted write reconciliation

An interrupted `executing` or `failed` write remains fail-closed until an operator reconciles its observed outcome. The operator-only CLI accepts the user-visible approval identifier or the internal idempotency key:

```bash
docker exec agentteams-worker-<worker> \
  tiangong-reconcile inspect <approval-id-or-idempotency-key>

docker exec agentteams-worker-<worker> \
  tiangong-reconcile resolve <approval-id-or-idempotency-key> \
  --actor <operator-id> --reason-code STALE_WORKER_EXECUTION
```

`resolve` defaults to a five-minute minimum age for `executing` state and never blindly retries. It validates the protected pending payload, workspace scope, current target digest, approved precondition, and rollback snapshot. If the approved content is already present, it records the outcome as completed; if the exact precondition remains, it restores approved state so the original requester can explicitly replay `APPROVE <approval-id>`; any other or invalid observation records a conflict and stays blocked. Reconciliation records separate Evidence events rather than claiming that an execution was observed.

Container execution access is the actual authority for this local command; `--actor` is bounded audit attribution, not an authentication mechanism. The CLI is not exposed to the model because `bash` and external tools remain disabled. Lowering `--minimum-age-seconds` is an explicit operator action and is unsafe unless the prior executor is independently known to be dead.

### Runtime retention

Raw pending write payloads are erased after successful completion, rejection, or an applied reconciliation outcome. Tiangong replaces the synchronized payload object with a zero-length file plus a non-sensitive terminal marker, publishes that erasure through AgentTeams' official MinIO credential layer, and then reasserts the local tombstone rather than relying on directory-deletion propagation. This storage adapter is internal runtime plumbing, not a model tool. Raw content remains available for `pending`, `approved`, `executing`, `failed`, and conflict states because recovery still requires it.

Completed and rejected idempotency metadata has a 90-day exactly-once replay window. State transitions append to a hash-chained journal with in-memory key, invocation, and approval indexes; hot-path transitions do not rewrite the full store. Expiration is never automatic: an operator first reports eligible records, then explicitly confirms compaction. Each removed record is summarized in Evidence before deletion, and that explicit maintenance step rewrites only the active journal state.

```bash
docker exec agentteams-worker-<worker> tiangong-retain report

docker exec agentteams-worker-<worker> tiangong-retain compact \
  --actor <operator-id> --confirm expire-90-day-replay-window
```

Evidence rotates at 16 MiB into ordered segments whose ranges and terminal hashes remain linked to the next active segment; it is not automatically deleted. Session transcripts reject new model turns at 10,000 persisted entries or 32 MiB and require an explicit transcript-only reset. Approval/rejection control commands remain available at that capacity so an outstanding operation is not stranded.

### Local security model

> [!WARNING]
> This bootstrap is not a host security boundary. AgentTeams `v1.2.2` mounts the container-runtime socket into its embedded Controller so it can create the Manager and Workers. Control of that socket is effectively control of the host: a compromised Controller, Agent, tool call, or prompt-injection path may create privileged containers or mount arbitrary host paths. The `host-share` directory limits the ordinary Manager mount; it does not mitigate container-socket authority.

- Web and management ports are forced to bind to localhost.
- Matrix end-to-end encryption is disabled for the local agent collaboration flow.
- Configuration and generated credential files use mode `600`.
- Generated repository-local paths are fixed beneath `.runtime/agentteams/`; uninstall rejects altered generated targets.
- Run untrusted workloads in a disposable VM or against a dedicated rootless/isolated container daemon, not on a sensitive workstation or shared production host.

Do not expose this profile beyond one machine. A multi-user deployment requires a different, deliberately designed identity, TLS, storage, network, secret-management, and container-isolation model.

## Agent and maintainer Skills

Six product Skills under [`worker/skills/`](./worker/skills/) ship in `tg-worker`: `work-coordination`, `work-planning`, `plan-challenge`, `test-driven-development`, `independent-code-review`, and `scenario-testing`. Their packages include trigger truth tables and deterministic success/blocked/cleanup cases. Agent packages under [`worker/agent-packages/`](./worker/agent-packages/) lock each installed Skill version and content digest; MemberConfig enables only a subset.

Portable maintainer Skills under [`.agents/skills/`](./.agents/skills/) remain repository workflows loaded only after project trust and are not Worker product Skills.

Validate both product and maintainer Skill structures, public-safety checks, trigger cases, Agent package locks, and behavior-case shape with:

```bash
make check-skills
make test-product-agent-skills
```

## Development

The repository uses a protected, Git Flow–lite workflow:

- `main` contains release-ready history only;
- `develop` is the integration branch;
- feature work is developed on short-lived branches and merged through pull requests;
- releases follow Semantic Versioning.

See [`AGENTS.md`](./AGENTS.md) for repository instructions, [`CONTRIBUTING.md`](./CONTRIBUTING.md) for contribution workflow, and [`RELEASING.md`](./RELEASING.md) for releases.

## License

Licensed under the [Apache License 2.0](./LICENSE).
