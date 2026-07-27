# Worker peer mention smoke scenarios

## Ownership

- Related implementation: `worker/`, `smoke-testing/support/run-peer-mention-smoke.sh`, and the pinned public AgentTeams Team/Matrix contract
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`
- Related state/Evidence: Team/member resources, Team Room events, `m.mentions`, Tiangong Harness markers, Worker sessions, stock Leader session snapshot, and cleanup proof
- Update triggers: changes to AgentTeams peer mentions, Matrix mention extraction, Team Room membership, Worker Harness selection, stock Leader mention gating, Team deletion, or storage prefixes

## Boundary truth table

| Boundary | Intended observation | Rejected shortcut |
|---|---|---|
| Test topology | one stock platform Leader plus two ordinary `tiangong-worker:dev` Workers with explicit released `groupAllowExtra` peer policy | calling a test identity a trusted professional role or assuming an unobserved allowlist |
| Initial routing | global Admin mentions only Coordinator; body contains no full Engineer or Leader MXID | exposing Engineer's full MXID and waking it through fallback text matching |
| Peer ping | Coordinator event contains the nonce, Engineer full MXID, and Engineer in `m.mentions` | test driver sending the ping as Coordinator |
| Peer pong | Engineer event contains the same nonce, Coordinator full MXID, and Coordinator in `m.mentions` | prose claiming Engineer received the event |
| Terminal receipt | Coordinator emits a later terminal marker with the same nonce, does not mention a peer/Leader, and no peer message follows during the bounded grace window | observing only Coordinator's first turn or cleaning up before detecting a reply loop |
| Leader silence | zero post-baseline Leader messages and unchanged stock Leader session snapshot | absence of a specific expected phrase |
| Harness | both peer senders have a post-baseline changed, passing Tiangong Harness marker and persistent nonce-bearing session; on failure, a changed `status=running` marker distinguishes Harness entry from completion | a pre-existing marker, container health, or model self-identification alone |
| Observability | sanitized completed Harness root traces correlate to the three inbound event IDs; a failed run reports only bounded phase/outcome/error-type facts for the Admin start turn | treating a UI screenshot, open span absence, model prose, or lossy trace as Evidence |
| Cleanup | exact Team, three members/containers, two aliases, helper copies, four storage prefixes, OTLP receiver container, and diagnostic trace path are absent | successful delete command alone or broad cleanup paths |

## Basic smoke

### B1: Ordinary Team Workers complete a peer mention loop

- Purpose: Prove that the pinned public AgentTeams release can carry a real Coordinator → Engineer → Coordinator Matrix mention wake-up loop while its required stock Team Leader remains idle.
- Target resources:
  - Team `tiangong-peer-smoke`;
  - stock Leader `tiangong-peer-smoke-leader`;
  - ordinary Workers `tiangong-peer-smoke-coordinator` and `tiangong-peer-smoke-engineer`;
  - their exact member/Team storage prefixes and the Team/Leader-DM aliases;
  - run-owned `tiangong-peer-smoke-otel` receiver and `.runtime/peer-smoke-observability/` trace path.
- Setup:
  1. deterministic peer smoke contract tests pass;
  2. `make verify` passes;
  3. every reserved resource, alias, and storage prefix is absent;
  4. build `tiangong-worker:dev` with the non-secret owned OTLP receiver endpoint and pass its embedded observability contract;
  5. start the bounded receiver on the existing AgentTeams network and prove readiness;
  6. apply `smoke-testing/fixtures/peer-mention-smoke-team.yaml` through the supported public CLI path.
- Prompt:
  - global Admin sends one Team Room event whose structured mention targets only Coordinator;
  - the body supplies Engineer's localpart and domain separately so Coordinator must construct the full MXID without the initial event waking Engineer;
  - peer messages carry one random nonce and bounded transport-only markers.
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
  - Coordinator and Engineer each have a post-baseline changed, passing Tiangong Harness marker and a persistent session containing the nonce;
  - completed sanitized Harness roots correlate to the Admin start, Coordinator ping, and Engineer pong event IDs;
  - cleanup removes only the fixed owned resources and verifies their absence.
- Required evidence:
  - four non-secret Matrix event IDs and `worker_peer_event_chain=pass`;
  - `stock_leader_message_count=0` and `stock_leader_model_turn_count=0`;
  - `peer_coordinator_harness=pass` and `peer_engineer_harness=pass`;
  - `matrix_peer_team_room_topology=pass`, `matrix_peer_channel_policy=pass`, and `matrix_peer_active_channel_stability=pass`;
  - on failure, sanitized target-account visibility facts for the exact Admin start and peer ping sender/nonce/visible MXID/`m.mentions`, without raw bodies or credentials;
  - on failure, whether each Harness marker changed after the nonce baseline and its sanitized lifecycle status (`running`, `pass`, or `error`), without prompt, response, or credential data;
  - `peer_coordinator_start_observability=pass`, `peer_engineer_ping_observability=pass`, and `peer_coordinator_pong_observability=pass` on success; otherwise one bounded sanitized start-event trace summary;
  - alias cleanup observations plus Team/member/container/storage/receiver/trace-path absence.
- Skip/block rules:
  - block if Docker, pinned AgentTeams, Matrix, Gateway model, reserved identity ownership, or public Worker image is unavailable;
  - refuse to replace any existing reserved Team/member/container/alias/storage prefix, receiver container, or diagnostic trace path;
  - fail if the stock Leader sends any post-baseline Team Room message or its session snapshot changes;
  - do not use direct CRs, config watcher publication, modified AgentTeams, unreleased images, or test-driver Worker impersonation;
  - do not call the transport messages formal Assignment/Result envelopes or call the test names trusted Role Profiles;
  - cleanup failure keeps the run red.

## Full smoke

No Full scenario is defined. Role authorization, Work Ledger, formal Assignment/Result, restart recovery, independent review, and failover are outside this transport spike.

## Maintenance notes

- **Current pinned-stack/runtime status (2026-07-27): BLOCKED.** Explicit public `groupAllowExtra` establishes the peer allowlist. Issue #11 / Draft PR #12 added deterministic reply targeting, bounded one-reply correlation, and a pre-turn Harness marker. Attempts 12–13 proved the exact Admin start was readable by Coordinator and reached its Tiangong Harness (`status=running`), but the Coordinator turn did not complete within the unchanged bounded window. Attempt 13's deeper trace was unavailable because the test receiver rejected the valid OTLP JSON `parentSpanId:null` root form; `d985ac8` fixes and directly covers that oracle defect. Earlier complete loops predate bounded terminal correlation or failed terminal quiescence and cannot promote the spike. See `smoke-testing/runs/2026-07-26-worker-peer-mentions/plan.md`.
- This scenario is independent of the blocked custom platform Team Leader boundary. It neither weakens nor satisfies that boundary.
- The stock Leader is intentionally selected by omitting custom Leader runtime/image fields. Both ordinary Workers use the supported inline Worker image/runtime fields.
- On `v1.2.0-beta.1`, `peerMentions: true` on this legacy inline Team path did not appear in the effective Worker `groupAllowFrom`: each Worker retained only Leader and Admin after a bounded convergence wait. The fixture therefore uses the documented public per-Worker `channelPolicy.groupAllowExtra` field with the peer Worker name, and the runner verifies the effective config before any model turn. This is an explicit transport authorization, not a professional Role Profile.
- The global Admin is already a Team Room member under the released Team contract and sends only the initial event. All peer events must be emitted by the tested Worker Harnesses.
- The initial body must not contain Engineer's full MXID because the released Matrix channel also recognizes full-MXID text as a mention fallback.
- Model wording beyond stable markers is not asserted. Event sender, event ID, nonce, structured mentions, Harness markers, session state, and cleanup are separate machine observations.
- Draft PR #12 writes `status=running` before invoking the Tiangong runtime and replaces it with `pass` or `error` at completion. Combined with target-account visibility, this separates Matrix readability, OpenClaw-to-Harness dispatch, and completed Tiangong turns without logging message bodies.
- Custom Harnesses receive OpenClaw's required `timeoutMs`. Tiangong enforces that exact supplied bound and upstream cancellation, but does not override the released AgentTeams `agents.defaults.timeoutSeconds=1800`; smoke reliability must not be manufactured by silently changing either the platform timeout or the observer window.
- Issue #13 / Draft PR #14 adds disabled-by-default, backend-neutral OTLP tracing. The focused smoke uses an explicitly owned non-secret endpoint and a strict test-only receiver as the machine oracle; AgentScope Studio, Jaeger, or another UI remains optional and is never a pass criterion. Trace data is diagnostic and cannot substitute for Tiangong Evidence.
