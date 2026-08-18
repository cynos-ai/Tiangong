# Worker peer mention smoke scenarios

## Ownership

- Related implementation: `worker/`, `smoke-testing/support/run-peer-mention-smoke.sh`, and the pinned public AgentTeams Team/Matrix contract
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`
- Related state/Evidence: Team/member resources, Team Room events, `m.mentions`, Tiangong control markers, ToolResult/Evidence state, stock Leader state, and cleanup proof
- Update triggers: changes to AgentTeams peer mentions, Matrix mention extraction, Team Room membership, Worker control hooks, stock Leader mention gating, Team deletion, or storage prefixes

## Boundary truth table

| Boundary | Intended observation | Rejected shortcut |
|---|---|---|
| Test topology | one stock platform Leader plus two ordinary `tiangong-worker:dev` Workers with explicit released `groupAllowExtra` peer policy | calling a test identity a trusted professional role or assuming an unobserved allowlist |
| Initial routing | global Admin mentions only Coordinator; body contains no full Engineer or Leader MXID | exposing Engineer's full MXID and waking it through fallback text matching |
| Peer ping | Coordinator OpenClaw control hook deterministically emits the nonce, authorized Engineer full MXID, and Engineer in `m.mentions` | test driver sending the ping as Coordinator or model prose selecting an unauthorized target |
| Peer pong | Engineer OpenClaw control hook deterministically replies with the same nonce, authenticated Coordinator full MXID, and Coordinator in `m.mentions` | prose claiming Engineer received the event |
| Terminal receipt | Coordinator emits a later terminal marker with the same nonce, does not mention a peer/Leader, and no peer message follows during the bounded grace window | observing only Coordinator's first turn or cleaning up before detecting a reply loop |
| Leader silence | zero post-baseline Leader messages and unchanged stock Leader session snapshot | absence of a specific expected phrase |
| Control state | both peer senders have post-baseline ToolResult state and a persistent nonce-bearing session; on failure, the changed state timestamp distinguishes control entry from completion | a pre-existing state file, container health, or model self-identification alone |
| Observability | sanitized completed control root traces and `peer.transport.start/ping/pong` phases correlate to the three inbound event IDs; a failed run reports only bounded phase/outcome/error-type facts for the Admin start turn | requiring model spans for deterministic controls or treating a UI screenshot, open span absence, model prose, or lossy trace as Evidence |
| Cleanup | exact Team, three members/containers, two aliases, helper copies, four storage prefixes, OTLP receiver container/volume, and diagnostic trace path are absent | successful delete command alone or broad cleanup paths |

## Basic smoke

### B1: Ordinary Team Workers complete a peer mention loop

- Purpose: Prove that the pinned public AgentTeams release can carry a real Coordinator → Engineer → Coordinator Matrix mention wake-up loop while its required stock Team Leader remains idle.
- Target resources:
  - Team `tiangong-peer-smoke`;
  - stock Leader `tiangong-peer-smoke-leader`;
  - ordinary Workers `tiangong-peer-smoke-coordinator` and `tiangong-peer-smoke-engineer`;
  - their exact member/Team storage prefixes and the Team/Leader-DM aliases;
  - run-owned `tiangong-peer-smoke-otel` receiver, `tiangong-peer-smoke-otel-data` volume, and `.runtime/peer-smoke-observability/` trace path.
- Setup:
  1. deterministic peer smoke contract tests pass;
  2. `make verify` passes;
  3. every reserved resource, alias, and storage prefix is absent;
  4. build `tiangong-worker:dev` with the non-secret owned OTLP receiver endpoint and pass its embedded observability contract;
  5. verify the run-owned OTLP receiver volume is absent, create it through the Docker API, and start the bounded receiver as the invoking UID/GID, retaining a read-only root filesystem, all capabilities dropped, and no-new-privileges, then prove readiness;
  6. apply `smoke-testing/fixtures/peer-mention-smoke-workers.yaml` through the supported public CLI path, then wait for all three standalone Workers to reach `Running` with their remote Matrix credentials present;
  7. apply `smoke-testing/fixtures/peer-mention-smoke-team.yaml` through the supported public CLI path.
- Prompt:
  - global Admin sends one Team Room event whose structured mention targets only Coordinator;
  - the body contains only the strict `TG_PEER_START` control and random nonce; it contains no Engineer/Leader identity or model instructions;
  - Tiangong derives the one outbound peer from the authenticated effective group-only allowlist and owns the bounded ping/pong/terminal text.
- Expected observations:
  - Team reaches `Active` with one stock Leader and two ordinary Workers;
  - both ordinary Worker resources and actual containers retain `runtime=openclaw` and `tiangong-worker:dev`;
  - Team Room contains global Admin, Leader, Coordinator, and Engineer, but not Manager;
  - effective `groupAllowFrom` on each ordinary Worker contains its peer, Leader, and Admin before the probe;
  - each official OpenClaw Matrix channel remains running, connected, healthy, non-restarting, and on one `lastStartAt` across the bounded post-policy stability interval;
  - the four correlated events occur in order: Admin start, Coordinator ping, Engineer pong, Coordinator terminal;
  - ping and pong carry the expected full-MXID `m.mentions` and never mention the stock Leader;
  - terminal contains no Engineer/Leader MXID or mention, and no Worker/Leader message follows during the bounded grace window;
  - stock Leader emits no Team Room message and its session-file count/digest does not change;
  - Coordinator and Engineer each have post-baseline changed ToolResult state and a persistent session containing the nonce;
  - completed sanitized control roots plus `peer.transport.start`, `peer.transport.ping`, and `peer.transport.pong` correlate to the Admin start, Coordinator ping, and Engineer pong event IDs; no model operation is expected for these deterministic controls;
  - cleanup removes only the fixed owned resources and verifies their absence.
- Required evidence:
  - four non-secret Matrix event IDs and `worker_peer_event_chain=pass`;
  - `stock_leader_message_count=0` and `stock_leader_model_turn_count=0`;
  - `peer_coordinator_control=pass` and `peer_engineer_control=pass`;
  - `matrix_peer_team_room_topology=pass`, `matrix_peer_channel_policy=pass`, and `matrix_peer_active_channel_stability=pass`;
  - on failure, sanitized target-account visibility facts for the exact Admin start and peer ping sender/nonce/visible MXID/`m.mentions`, without unrestricted bodies or credentials;
  - on failure, whether each ToolResult marker changed after the nonce baseline, without prompt, response, or credential data;
  - `peer_coordinator_start_observability=pass`, `peer_engineer_ping_observability=pass`, and `peer_coordinator_pong_observability=pass` on success; otherwise one bounded sanitized start-event trace summary plus fixed boolean peer-transport/pi-turn/request/response/progress/retry/terminal activity facts;
  - alias cleanup observations plus Team/member/container/storage/receiver/receiver-volume/trace-path absence.
- Skip/block rules:
  - block if Docker, pinned AgentTeams, Matrix, Gateway model, reserved identity ownership, or public Worker image is unavailable;
  - refuse to replace any existing reserved Team/member/container/alias/storage prefix, receiver container/volume, or diagnostic trace path;
  - fail if the stock Leader sends any post-baseline Team Room message or its session snapshot changes;
  - do not use direct CRs, config watcher publication, modified AgentTeams, unreleased images, or test-driver Worker impersonation;
  - do not call the transport messages formal Assignment/Result envelopes or call the test names trusted Role Profiles;
  - cleanup failure keeps the run red.

## Full smoke

No Full scenario is defined. Role authorization, Work Ledger, formal Assignment/Result, restart recovery, independent review, and failover are outside this transport spike.

## Maintenance notes

- **Historical pinned-stack status (2026-07-27): PASS.** The dated attempts in `smoke-testing/runs/2026-07-26-worker-peer-mentions/` used the pre-clean-cut control marker and are retained as history only. Current runs use the OpenClaw control plugin, `openclaw.turn.start`, `tiangong.control.attempt`, and bounded ToolResult state; old Pi marker names are not a supported deployment contract.
- **AgentTeams v1.2.0 clean migration run (2026-08-04): PASS.** Separate standalone Worker provisioning, asynchronous readiness, explicit peer/DM policy, real Matrix Coordinator→Engineer→Coordinator delivery, stock Leader silence, three correlated OTLP control phases, and exact Team/Worker/container/volume/storage/alias cleanup all passed. No model or raw payload content is retained as Evidence.
- The receiver uses a run-owned Docker volume because Docker Desktop may not expose arbitrary repository-local paths to its daemon; the shell-side trace copy remains under `.runtime/peer-smoke-observability/` and the run removes both exact resources.
- This scenario is independent of the blocked custom platform Team Leader boundary. It neither weakens nor satisfies that boundary.
- AgentTeams v1.2 separates Worker provisioning from Team membership. The smoke applies three standalone Worker CRs first: the Leader explicitly pins the stock CoPaw runtime/image, while both ordinary Workers pin the supported OpenClaw runtime and local Tiangong image; the Team then references those CRs through `spec.workerMembers`.
- The fixture uses the documented public per-Worker `channelPolicy.groupAllowExtra` and `dmAllowExtra` fields. Group policy grants the peer, stock Leader, and Admin ingress; the Leader is also marked as a DM-allowed identity so Tiangong's peer authority contains exactly the authenticated ordinary peer. The runner verifies the effective config before any control turn. This is explicit transport authorization, not a professional Role Profile.
- The global Admin is already a Team Room member under the released Team contract and sends only the initial event. All peer events must be emitted by the tested OpenClaw control hooks.
- The initial body must not contain Engineer's full MXID because the released Matrix channel also recognizes full-MXID text as a mention fallback. It contains no target fragments or model instructions; runtime authority comes only from the effective Matrix allowlists.
- Exact transport markers are owned by deterministic Tiangong control code, not model wording. Event sender, event ID, nonce, structured mentions, ToolResult state, session state, and cleanup are separate machine observations.
- The control hook records bounded ToolResult state around deterministic transport work. Combined with target-account visibility, this separates Matrix readability, OpenClaw dispatch, and completed Tiangong turns without logging message bodies.
- OpenClaw receives the released AgentTeams timeout and cancellation contract. Tiangong does not override `agents.defaults.timeoutSeconds=1800`; smoke reliability must not be manufactured by silently changing either the platform timeout or the observer window.
- The transport observer uses 36 incremental Matrix sync windows with a server timeout of 10 seconds. A correlated `openclaw.turn.start` plus `status=running` when that shorter observer ends proves only that the turn had not completed within the smoke window; it is not evidence that the provider call would never terminate.
- Issue #13 / Draft PR #14 adds disabled-by-default, backend-neutral OTLP tracing. Its model activity phases separate pi turn start, provider request readiness, response receipt, stream start, bounded real stream progress, and session auto-retry. A local timer heartbeat is not treated as provider progress, and missing telemetry remains unknown. The focused smoke uses an explicitly owned non-secret endpoint and a strict test-only receiver as the machine oracle; AgentScope Studio, Jaeger, or another UI remains optional and is never a pass criterion. Trace data is diagnostic and cannot substitute for Tiangong Evidence.
