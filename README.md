# Tiangong

Tiangong is an evidence-backed AI software engineering team built on [AgentTeams](https://github.com/agentscope-ai/AgentTeams).

> [!NOTE]
> The project is being initialized. The current runnable scope bootstraps the upstream AgentTeams collaboration layer and provides a minimal Matrix-to-pi Worker runtime. The broader Tiangong product experience is not implemented yet.

## Vision

Tiangong coordinates specialized software-engineering agents while requiring completion claims to be backed by captured evidence, independent verification, and explicit approval for high-risk actions.

## Local AgentTeams quick start

The bootstrap is pinned to the public AgentTeams `v1.2.0-beta.1` prerelease and verifies the upstream installer checksum before execution. Container images are still resolved by upstream tags rather than immutable digests, so this is not a fully reproducible or supply-chain-hermetic deployment.

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

The defaults use Alibaba Cloud Coding Plan with `qwen3.5-plus`. To use another OpenAI-compatible provider, change `AGENTTEAMS_OPENAI_BASE_URL` and `AGENTTEAMS_DEFAULT_MODEL` as well.

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

### Pi-enabled Worker image smoke test

The local Worker image extends the public AgentTeams `v1.2.0-beta.1` Worker image at an immutable digest, retains its Node.js `22.23.1` runtime, and installs the public MIT-licensed `@earendil-works/pi-coding-agent` package at exactly `0.82.0` from `worker/package-lock.json`.

With AgentTeams running, choose the fast channel smoke or the full approval smoke:

```bash
make test-worker-image-basic  # Gateway, Matrix, persistent session, credential boundary
make test-worker-image        # Also Gate, restart recovery, approval, replay, and Evidence
```

Both levels build `tiangong-worker:dev`, create the reserved temporary Worker `tiangong-pi-smoke` through the AgentTeams declarative API, and use the real Worker-scoped Gateway and Matrix room. The Basic smoke creates a disposable read fixture, requires one gated pi `read` through Matrix, validates an exact nonce response and matching Evidence, verifies persistent pi session creation, and checks that the Worker credential entered neither temporary model configuration nor the session transcript.

The Full smoke additionally asks pi to propose a constrained workspace write, verifies that the file is absent while approval is pending, restarts the Worker, waits for Matrix readiness, approves through a later Matrix turn, checks the written nonce, replays the same approval, and requires approval-specific Evidence to show exactly one execution and one replay. Cross-Worker-restart recovery uses a versioned Tiangong pending-operation envelope and does not depend on pi transcript internals.

Cleanup removes the temporary Worker and the exact MinIO prefix owned by the reserved smoke identity. It never operates on another Worker prefix. Provider credentials are not copied into the image, repository, model configuration, session, or Evidence.

The Worker resource retains AgentTeams' supported `openclaw` runtime, Node.js version, entrypoint, and gateway. A narrow `openclaw` command wrapper injects the Tiangong plugin path into the generated configuration and then delegates to the upstream executable. OpenClaw continues to own Matrix, configuration retrieval, storage sync, re-login, readiness, channel policy, and reply delivery. Tiangong owns the pi harness and its future evidence, approval, Concern, and Gate behavior.

Optional, backend-neutral Worker tracing is documented in [`docs/observability.md`](./docs/observability.md). It is disabled by default, exports only allowlisted sanitized OpenTelemetry spans, and remains diagnostic telemetry rather than authorization or hash-chained Evidence. The bounded [`peer transport diagnostic`](./docs/peer-transport-diagnostic.md) keeps exact ping/pong markers in deterministic Worker code while deriving targets only from authenticated effective Matrix allowlists; it is transport-only and is not Team Work or Evidence.

The current runtime is intentionally constrained:

- it claims only the Worker-scoped `agentteams-gateway` provider and disables OpenClaw's fallback to another agent harness;
- OpenClaw parameters cross a stable Tiangong Turn DTO; provider credentials are non-enumerable request data and are injected into pi only in memory;
- pi extensions, skills, prompt templates, and automatic repository context are disabled;
- the active kernel image loads a strict, digest-bound profile and static methodology from `/opt/tiangong-worker`; environment variables, Worker names, prompts, and tool arguments cannot select or elevate its role;
- transcript files live only under `sessions/<session-hash>/pi/`; Evidence, idempotency, pending payload, and rollback state use independent per-session roots beneath the synchronized state directory, so transcript reset cannot erase business state;
- restartable writes persist a digest-bound operation envelope and a separate mode-`600` content payload under that state directory; raw write content never enters Evidence, but is visible to principals with Worker storage administration access and follows explicit operation retention;
- only gated `read` and path-restricted, atomic `write` are active; `write` requires persisted approval from the same authenticated Matrix sender that requested it, ignores upstream owner assertions for authorization, supports restart recovery, and blocks duplicate execution;
- runtime state, credential-bearing paths, symlink traversal, workspace escape, image input, and `bash` are unavailable.

To build and inspect the image without creating a Worker:

```bash
make build-worker-image
docker run --rm --entrypoint pi tiangong-worker:dev --version
```

The build also produces `tiangong-worker-reviewer:dev` with the fixed Reviewer profile and an exact five-tool surface: `start_work`, `extend_scope`, scoped text `read`, `check_completion`, and `abandon_work`. Deterministic tests and image checks cover the Worker-local PracticeRun, file-version Evidence, checkpoint, ContextPack, and machine-status contracts. The real Reviewer Matrix Basic/Full smoke and release gate remain pending, so this is not yet a public Reviewer availability claim.

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
> This bootstrap is not a host security boundary. AgentTeams `v1.2.0-beta.1` mounts the container-runtime socket into its embedded Controller so it can create the Manager and Workers. Control of that socket is effectively control of the host: a compromised Controller, Agent, tool call, or prompt-injection path may create privileged containers or mount arbitrary host paths. The `host-share` directory limits the ordinary Manager mount; it does not mitigate container-socket authority.

- Web and management ports are forced to bind to localhost.
- Matrix end-to-end encryption is disabled for the local agent collaboration flow.
- Configuration and generated credential files use mode `600`.
- Generated repository-local paths are fixed beneath `.runtime/agentteams/`; uninstall rejects altered generated targets.
- Run untrusted workloads in a disposable VM or against a dedicated rootless/isolated container daemon, not on a sensitive workstation or shared production host.

Do not expose this profile beyond one machine. A multi-user deployment requires a different, deliberately designed identity, TLS, storage, network, secret-management, and container-isolation model.

## Maintainer Skills

Portable project Skills under [`.agents/skills/`](./.agents/skills/) guide Skill authoring and the design and execution of Tiangong smoke tests. They are maintainer workflows loaded only after project trust; they are not yet product Worker Skills.

Validate their structure, public-safety checks, and trigger cases with:

```bash
make check-skills
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
