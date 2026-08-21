# Tiangong

Tiangong is an evidence-backed AI software engineering team built on [AgentTeams](https://github.com/agentscope-ai/AgentTeams).

> [!NOTE]
> v0.4.1 is the latest source release and records the completed OpenClaw runtime migration. Current development has implemented M0–M3 and M5–M7: the coordination foundation, six long-lived Agent packages, portable Skills, a chat-first Matrix workbench, the OpenClaw built-in execution foundation, a disposable local M6 delivery proof, and the M7 PostgreSQL/legacy-runtime clean-cut. This does not claim production deployment. See the [v0.4.1 release notes](docs/releases/v0.4.1.md), [product MVP](docs/design/product-mvp.zh.md), and [changelog](CHANGELOG.md).
>
> The implementation-independent target is defined by the [team-control design](docs/design/evidence-backed-team-control.md) ([中文](docs/design/evidence-backed-team-control.zh.md)). The first public product slice is specified in the [product MVP design（中文）](docs/design/product-mvp.zh.md), and the current persistence/runtime boundary is recorded in the [M7 product-authority clean-cut](docs/design/m7-product-authority-clean-cut.md).

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

### OpenClaw-native Worker image

The local Worker image extends the public AgentTeams `v1.2.2` Worker image at an immutable digest and retains its pinned Node.js `22.23.2` runtime. All six professional Agents use OpenClaw's built-in runtime. Tiangong contributes its control plugin, Agent packages, portable Skills, coordination tools, and bounded ToolResults.

```bash
make build-worker-image
npm --prefix worker test
```

The active build produces only `tg-worker:dev`. It contains no Codex/OpenCodex, native Runner, deployment service, pending Operation, Approval command, or hash-chain Evidence runtime. External-write Operation and exact Human Approval behavior will be introduced with real Adapters in a later stage rather than retained as inactive placeholders.

Optional tracing is documented in [`docs/observability.md`](./docs/observability.md). It is disabled by default and remains diagnostic telemetry rather than authorization or a product fact.

### Chat-first Matrix workbench

The deployment-owned Coordination runtime now serves the M3 workbench at its root URL. A Human signs in with a current Matrix identity; Tiangong keeps the resulting access token only in a bounded in-memory session and returns an HttpOnly, SameSite cookie. Every chat, runtime-fact request, and SSE update rechecks Matrix identity and membership in the configured unencrypted Team Room. Session revocation closes the fact stream, and process restart forgets all Web sessions.

The workbench uses Matrix history/sync/send for the center conversation and never stores message bodies in PostgreSQL. The left rail shows the configured Team/Room and Leader admission backlog. The right panel projects Room Work history, nullable WorkSpec, Plan refs/history, Challenger and other Results, Agent/model/actual Skill use, Tasks, ToolResults, deliverables, and timeline facts. Selecting a Work changes only that panel; the send contract rejects any Work routing field.

Set `AGENTTEAMS_MATRIX_URL` in the Coordination runtime environment to enable Human Web login. `TIANGONG_COORDINATION_MATRIX_TOKEN` remains optional and enables only the deployment-owned outbox sender. HTTPS deployments keep secure cookies enabled; a loopback HTTP development deployment must explicitly set `TIANGONG_WEB_SECURE_COOKIES=0`. Encrypted Rooms fail closed in the first version.

Run the focused deterministic contract with:

```bash
make test-chat-first-web
```

The current runtime is intentionally constrained:

- AgentTeams controls Provider credentials and each Worker's current model; Tiangong accepts only the current authenticated projection and has no fallback runtime;
- one generic `tg-worker` image is configured by AgentTeams identity, MemberConfig, ControlProfile, Agent package, and deployment-owned bindings;
- Leader receives coordination and Skill tools; the five professional members receive Skill tools plus the pinned OpenClaw workspace tool set;
- effective Skills are the digest-locked package installation intersected with `MemberConfig.allowedSkills`;
- PostgreSQL is the sole Work/Task/Result, Matrix admission, request replay, and wake-outbox authority; Workers access it only through the bounded Control API;
- Matrix admission backlog and internal wake outbox remain separate tables and processing contracts;
- no Push, CI dispatch, deployment, production credential, or external-write Adapter is active.

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
