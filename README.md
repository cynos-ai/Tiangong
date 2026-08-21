# Tiangong

**English** | [简体中文](README.zh-CN.md)

Tiangong is an evidence-backed AI software engineering team built on [AgentTeams](https://github.com/agentscope-ai/AgentTeams).

> [!NOTE]
> `v0.5.0` is the latest source release and records the M0–M8 product-foundation milestones as complete under their published acceptance scope: PostgreSQL-backed coordination, six long-lived Agent packages, portable Skills, the chat-first Matrix workbench, one generic OpenClaw Worker image, a disposable local delivery proof with a clean rerun, the M7 product-authority clean-cut, and default-off M8 AgentLoop diagnostics with an isolated cloud acceptance run. This is not a production-deployment claim: Push, CI dispatch, deployment, production credentials, and external-write Adapters remain closed. See the [v0.5.0 release notes](docs/releases/v0.5.0.md), [product MVP](docs/design/product-mvp.zh.md), and [changelog](CHANGELOG.md).
>
> The implementation-independent target is defined by the [team-control design](docs/design/evidence-backed-team-control.md) ([中文](docs/design/evidence-backed-team-control.zh.md)). The first public product slice is specified in the [product MVP design（中文）](docs/design/product-mvp.zh.md), and the current persistence/runtime boundary is recorded in the [M7 product-authority clean-cut](docs/design/m7-product-authority-clean-cut.md).

## Vision

Tiangong is designed to coordinate specialized software-engineering agents while keeping completion claims, model prose, machine state, and machine-captured observations distinct. High-risk external writes are a target contract, not an active `v0.5.0` capability.

## Highlights

- **Chat-first collaboration:** Matrix remains the conversation source while the Web workbench projects Work, Plan, Task, Result, ToolResult, Skill use, and deliverable facts alongside it.
- **A professional six-agent team:** Leader, Architect, Challenger, Developer, Reviewer, and Tester use one generic `tg-worker` image and versioned Agent packages rather than role-specific images.
- **Evidence-bounded delivery:** the recorded M6 acceptance covered an owned disposable project, signed local commits, independent review and testing, CloseGuard completion, cleanup, and a clean rerun.
- **Fail-closed boundaries:** provider/model state stays with AgentTeams; PostgreSQL is the product authority; Workers do not receive the database URL, Matrix deployment token, or AgentLoop credential.
- **Optional diagnostics:** M8 AgentLoop/OpenTelemetry integration is disabled by default and remains non-authoritative for completion and recovery.

## Architecture

```text
Human / Matrix client
        │
        ▼
AgentTeams + Matrix ─────── conversation, identity, provider/model control
        │
        ▼
Coordination runtime ────── Web workbench, bounded Control API, Matrix gateway
        │
        ▼
PostgreSQL ──────────────── Work/Task/Result, admission, replay, wake authority
        │
        ▼
Generic OpenClaw Workers ─ Agent packages, product Skills, workspace tools
        │
        └─ optional credential-free OTLP → isolated Collector / AgentLoop
```

AgentTeams owns team, container, Matrix, and storage integration. Tiangong owns the Worker runtime additions, professional Agent packages, product facts, completion checks, and workbench experience.

## Competition scenario mapping

| Scenario | What can be demonstrated in `v0.5.0` | Boundary |
|---|---|---|
| Multi-agent software delivery | Dynamic professional roles, shared Plan facts, local code change, independent review/test Results | The published end-to-end proof is disposable and local |
| Human-agent collaboration | One Matrix conversation beside Work facts in the three-pane workbench | E2EE Rooms are rejected by the first Web version |
| Trustworthy completion | Result, ToolResult, commit/test references, and CloseGuard facts shown separately from model prose | No claim of production deployment or autonomous external writes |
| Agent observability | Optional Work/Task-correlated AgentLoop metadata and a bounded diagnostics panel | Telemetry may be sampled or absent and never authorizes or completes Work |

## Local AgentTeams quick start

> New to the local stack? Read the [local development guide (中文)](docs/local-development-guide.md) first. It covers environment pitfalls (npm registry mirror, Docker mirror 404s, pinned versions), the Dashboard chat limitation, and the verified message format for talking to Workers.

The bootstrap is pinned to the public AgentTeams `v1.2.2` release and verifies the upstream installer checksum before execution. Container images are still resolved by upstream tags rather than immutable digests, so this is not a fully reproducible or supply-chain-hermetic deployment.

### Prerequisites

- Linux or macOS
- Bash
- Docker with a running daemon
- `curl`, `jq`, `make`, OpenSSL, and Node.js 22 or newer
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

### Run the full stack

The following local-development path was verified command by command on `v0.5.0` sources. It starts AgentTeams, the six-member demo Team, an owned PostgreSQL 16 container, and the Coordination runtime, then exposes the Web workbench only on loopback. It does **not** prove production deployment or automatically inject Tiangong MemberConfig into the six Workers; AgentTeams `v1.2.2` does not expose those binding fields in its public manifest. Until a deployment adapter has injected and verified those fields, use this path to inspect the live Team Room and workbench, not to claim a Tiangong-controlled model delivery turn.

1. Create the private AgentTeams configuration, set the provider key, and start the pinned stack:

   ```bash
   make init
   # Edit .env and set AGENTTEAMS_LLM_API_KEY; never commit .env.
   make up
   make verify
   make login
   ```

2. Build the generic Worker and Coordination images, then create the owned six-member demo Team:

   ```bash
   make build-worker-image
   make build-coordination-image
   ./scripts/tiangong-demo.sh start
   ```

3. Create owner-only runtime files and a network-only PostgreSQL container. The password and Control token below are generated locally, passed through `0600` files, and never written to command arguments:

   ```bash
   if [[ -e .runtime/coordination ]] || \
      docker container inspect tiangong-coordination-postgres >/dev/null 2>&1 || \
      docker volume inspect tiangong-coordination-postgres-data >/dev/null 2>&1; then
     printf 'Refusing to reuse existing Coordination runtime resources.\n' >&2
     exit 1
   fi

   mkdir -p .runtime/coordination
   chmod 700 .runtime/coordination
   umask 077

   DB_PASSWORD="$(openssl rand -hex 24)"
   CONTROL_TOKEN="$(openssl rand -hex 32)"

   cat >.runtime/coordination/postgres.env <<EOF
   POSTGRES_USER=tiangong
   POSTGRES_PASSWORD=${DB_PASSWORD}
   POSTGRES_DB=tiangong
   EOF

   cat >.runtime/coordination/coordination.env <<EOF
   TIANGONG_COORDINATION_DATABASE_URL=postgres://tiangong:${DB_PASSWORD}@tiangong-coordination-postgres:5432/tiangong
   TIANGONG_COORDINATION_CONTROL_TOKEN=${CONTROL_TOKEN}
   AGENTTEAMS_MATRIX_URL=http://agentteams-controller:6167
   TIANGONG_WEB_SECURE_COOKIES=0
   EOF
   unset DB_PASSWORD CONTROL_TOKEN

   docker volume create tiangong-coordination-postgres-data >/dev/null
   docker run --detach --name tiangong-coordination-postgres \
     --label io.tiangong.owner=local-development \
     --network agentteams-net \
     --env-file "$PWD/.runtime/coordination/postgres.env" \
     --mount type=volume,source=tiangong-coordination-postgres-data,destination=/var/lib/postgresql/data \
     postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777

   until docker exec tiangong-coordination-postgres \
     pg_isready -U tiangong -d tiangong >/dev/null 2>&1; do sleep 1; done
   ```

4. Project the live demo Team and Worker identities into a credential-free binding. This binding is runtime configuration, remains ignored under `.runtime/`, and contains no provider, PostgreSQL, Matrix, or AgentLoop credential:

   ```bash
   docker exec agentteams-manager agt get teams tiangong-demo-team -o json \
     >.runtime/coordination/team.json
   for ROLE in leader architect challenger developer reviewer tester; do
     docker exec agentteams-manager agt get workers "tiangong-demo-${ROLE}" -o json \
       >".runtime/coordination/${ROLE}.json"
   done

   node --input-type=module <<'EOF'
   import { readFile, writeFile } from "node:fs/promises";
   import {
     createControlProfile, createMemberConfig,
     createTeamConfig, createTeamRouteBinding,
   } from "./worker/agent/team/coordination-contracts.mjs";

   const dir = ".runtime/coordination";
   const roles = ["leader", "architect", "challenger", "developer", "reviewer", "tester"];
   const now = new Date().toISOString();
   const liveTeam = JSON.parse(await readFile(`${dir}/team.json`, "utf8"));
   const liveWorkers = Object.fromEntries(await Promise.all(roles.map(async (role) => [
     role, JSON.parse(await readFile(`${dir}/${role}.json`, "utf8")),
   ])));
   const profile = createControlProfile({
     profileId: "tiangong-demo-local", revision: 1,
     maxTimelineEntries: 4096, maxOutboxEntries: 1024,
     maxTasksPerWork: 256, toolResultRetentionMs: 2_592_000_000,
   });
   const members = await Promise.all(roles.map(async (role) => {
     const pkg = JSON.parse(await readFile(`worker/agent-packages/${role}/agent.json`, "utf8"));
     const worker = liveWorkers[role];
     return createMemberConfig({
       memberId: worker.name, teamId: liveTeam.name, revision: 1,
       workerName: worker.name, matrixUserId: worker.matrixUserID, role,
       controlProfileId: profile.profileId, enabled: true,
       runtime: "openclaw-built-in", model: worker.model,
       agentPackageId: pkg.packageId, agentPackageVersion: pkg.version,
       allowedSkills: pkg.installedSkills.map(({ skillId }) => skillId), createdAt: now,
     });
   }));
   const team = createTeamConfig({
     teamId: liveTeam.name, revision: 1,
     leaderMemberId: liveWorkers.leader.name,
     memberIds: members.map(({ memberId }) => memberId),
     controlProfileId: profile.profileId, createdAt: now,
   });
   const route = createTeamRouteBinding({
     routeId: "tiangong-demo-matrix", teamId: team.teamId, revision: 1,
     channel: "matrix", roomId: liveTeam.teamRoomID, createdAt: now,
   });
   await writeFile(`${dir}/leader-binding.json`,
     `${JSON.stringify({ team, route, profile, leaderMember: members[0], members }, null, 2)}\n`,
     { mode: 0o600 });
   EOF
   chmod 600 .runtime/coordination/*.env .runtime/coordination/leader-binding.json
   ```

5. Start the Coordination runtime and open the workbench:

   ```bash
   export TIANGONG_LEADER_RUNTIME_BINDING_FILE="$PWD/.runtime/coordination/leader-binding.json"
   export TIANGONG_COORDINATION_ENV_FILE="$PWD/.runtime/coordination/coordination.env"
   export TIANGONG_COORDINATION_HOST_PORT=18780

   make coordination-runtime-start
   make coordination-runtime-status
   curl --fail --silent --show-error http://127.0.0.1:18780/readyz
   ```

   Open <http://127.0.0.1:18780/>. With the default configuration, sign in as `@admin:matrix-local.agentteams.io:18080` using the password stored in the credential file reported by `make login`. The login is accepted only when that current identity is a member of the unencrypted demo Team Room.

The minimum Coordination runtime environment is `TIANGONG_COORDINATION_DATABASE_URL` plus `TIANGONG_COORDINATION_CONTROL_TOKEN`. `AGENTTEAMS_MATRIX_URL` enables Web login; `TIANGONG_WEB_SECURE_COOKIES=0` is required only for this loopback HTTP profile. `TIANGONG_COORDINATION_MATRIX_TOKEN` is optional and is needed only for the deployment-owned wake-outbox sender. Host-side `TIANGONG_LEADER_RUNTIME_BINDING_FILE`, `TIANGONG_COORDINATION_ENV_FILE`, and `TIANGONG_COORDINATION_HOST_PORT` select the two private files and loopback publication; they do not enter `coordination.env`.

| Endpoint | Port | Exposure in this path |
|---|---:|---|
| AgentTeams Gateway / Matrix client API | `18080` | `127.0.0.1` |
| Element Web | `18088` | `127.0.0.1` |
| AgentTeams Dashboard | `13000` | `127.0.0.1` |
| Higress Console | `18001` | `127.0.0.1` |
| Manager Console | `18888` | `127.0.0.1` |
| Coordination runtime / workbench | `18780` → container `8780` | `127.0.0.1` |
| PostgreSQL | container `5432` | `agentteams-net` only; no host port |

To remove only the resources created by this section:

```bash
make coordination-runtime-stop
./scripts/tiangong-demo.sh stop
docker rm --force tiangong-coordination-postgres
docker volume rm tiangong-coordination-postgres-data
rm -rf .runtime/coordination
```

### OpenClaw-native Worker image

The local Worker image extends the public AgentTeams `v1.2.2` Worker image at an immutable digest and retains its pinned Node.js `22.23.2` runtime. All six professional Agents use OpenClaw's built-in runtime. Tiangong contributes its control plugin, Agent packages, portable Skills, coordination tools, and bounded ToolResults.

```bash
make build-worker-image
npm --prefix worker test
```

The active build produces only `tg-worker:dev`. It contains no Codex/OpenCodex, native Runner, deployment service, pending Operation, Approval command, or hash-chain Evidence runtime. External-write Operation and exact Human Approval behavior will be introduced with real Adapters in a later stage rather than retained as inactive placeholders.

Optional AgentLoop/OpenTelemetry diagnostics are documented in [`docs/observability.md`](./docs/observability.md) and the [M8 design](./docs/design/m8-agentloop-diagnostic-integration.md). They are disabled by default. Workers carry no AgentLoop credential: an independently managed Collector injects cloud write headers, while traces remain non-authoritative diagnostic telemetry.

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
