# Worker peer mention focused smoke run

## Scope

- Issue: `#9`
- Branch: `feat/9-worker-peer-mention-smoke`
- Level: focused integration spike following deterministic contract checks
- Scenario: `smoke-testing/scenarios/worker-peer-mentions.md` B1
- Status: PLANNED

## Boundary under test

Prove a real Team Room sequence on the pinned public AgentTeams release:

```text
global Admin @Coordinator
  → Coordinator @Engineer (nonce)
  → Engineer @Coordinator (same nonce)
  → Coordinator terminal marker
```

The required stock platform Leader must emit no response and must have no session-state change. Coordinator and Engineer are fixed transport-test identities using the same `tiangong-worker:dev`; this run does not establish trusted professional Role Profiles.

## Preconditions

1. deterministic contract tests pass;
2. repository/shell and Worker package tests pass at the relevant layer;
3. Docker is available;
4. the locally configured pinned AgentTeams stack passes `make verify`;
5. all exact reserved resources are absent;
6. provider/model remain the configured AgentTeams Gateway and `qwen3.5-plus`.

## Owned resources

- Team: `tiangong-peer-smoke`
- Members/containers:
  - `tiangong-peer-smoke-leader`
  - `tiangong-peer-smoke-coordinator`
  - `tiangong-peer-smoke-engineer`
- Matrix aliases:
  - `#agentteams-team-tiangong-peer-smoke:<configured-domain>`
  - `#agentteams-leader-dm-tiangong-peer-smoke-leader:<configured-domain>`
- Storage prefixes:
  - `agents/tiangong-peer-smoke-leader/`
  - `agents/tiangong-peer-smoke-coordinator/`
  - `agents/tiangong-peer-smoke-engineer/`
  - `teams/tiangong-peer-smoke/`
- Fixed helper copies under `/tmp/tiangong-peer-*` in owned containers.
- Diagnostic OTLP receiver container/network alias: `tiangong-peer-smoke-otel` / `tiangong-otel-collector` on the existing AgentTeams network.
- Diagnostic trace path: `.runtime/peer-smoke-observability/spans.jsonl` (sanitized, run-owned, removed during exact cleanup).

The runner must refuse to replace any existing resource in this set. No cleanup path is derived from model output or user input.

## Required machine observations

- Team `Active`, `leaderReady=true`, and exactly two ready ordinary Workers;
- actual stock Leader image equals the pinned public AgentTeams CoPaw Worker image;
- both ordinary Workers retain `runtime=openclaw`, actual `tiangong-worker:dev`, and platform role `worker`;
- Team Room topology includes global Admin, Leader, Coordinator, and Engineer and excludes Manager;
- four unique ordered event IDs bound to the same nonce;
- ping/pong sender and `m.mentions` facts match the intended peer;
- no Leader Team Room event after the baseline cursor;
- stock Leader session count/digest unchanged across the probe;
- passing Harness marker and nonce-bearing persistent session for each ordinary Worker;
- a completed sanitized Harness root trace correlated by the Admin start, Coordinator ping, and Engineer pong event IDs; on failure, a bounded phase/outcome/error-type summary for the Admin start turn;
- exact cleanup proof for every owned resource, including the receiver container and diagnostic trace path.

## Blocked and failure rules

- Do not modify AgentTeams or use direct CR/config-watcher/unreleased paths.
- Do not send peer messages with the test driver; only global Admin may send the start event.
- Do not weaken sender, mention, nonce, Leader-silence, Harness, or cleanup assertions to accommodate model behavior.
- A timeout is an environment/model or behavior failure, not proof that transport is unsupported.
- On the first failure, classify the failing layer and add the smallest diagnostic.
- On a second failure of the same class, stop before a third real run unless new lower-layer evidence exists.
- OpenTelemetry remains lossy diagnostic telemetry, not authorization or hash-chained Evidence; a UI view is never the pass oracle.
- Cleanup failure keeps the run failed.

## Execution order

```text
make test-peer-mention-smoke-contract
bash -n / shellcheck for changed scripts
./scripts/check-repository.sh
npm test --prefix worker
make verify
make test-peer-mention-smoke
```

Only the final command creates the disposable Team and performs model turns.

## Attempts and current result

### Attempt 1 — FAIL (readiness oracle)

- Team reached `Active`, but the runner checked `openclaw health` before waiting for Worker channel readiness.
- Classification: test-driver/readiness ordering, not product failure.
- Change: runtime identity checks no longer claim health; the existing observable channel-readiness wait proves container, OpenClaw health, Team Room join, and Controller readiness together.
- Exact Team/member/container/alias/storage cleanup was independently rechecked and passed.

### Attempt 2 — FAIL (Controller jq compatibility)

- The event validator used `$label`, which the Controller's jq parser treats as the `label` keyword.
- Classification: test-driver compatibility.
- Change: renamed the variable and executed the positive validator inside the pinned Controller container before another real run.
- Exact cleanup was independently rechecked and passed.

### Attempt 3 — FAIL (initial Matrix wake-up)

- The post-baseline room history contained the Admin start event but no Coordinator or Engineer event; the validator therefore reported zero ping events.
- Sanitized read-only history inspection found no stock Leader response.
- Hypothesis: unlike the already-proven single-Worker helper, the initial event supplied structured `m.mentions` but omitted the visible `formatted_body` Matrix mention expected by the OpenClaw receive path.
- Change before any further run:
  - match the proven Matrix event shape: coordinator-only `m.mentions` plus coordinator-only `matrix.to` formatted mention;
  - add bounded event-count and Harness/session diagnostics on failure without printing message bodies;
  - keep Engineer's full MXID absent from the initial body/formatted body.
- Exact cleanup passed.

### Attempt 4 — FAIL (effective peer allowlist)

- The coordinator-only formatted start mention successfully woke Coordinator.
- Machine observations:
  - one valid Coordinator ping event was emitted with Engineer's full MXID in body, formatted mention, and `m.mentions`;
  - Engineer emitted no pong and persisted no nonce-bearing session;
  - stock Leader emitted no message;
  - Coordinator Harness passed.
- A no-model configuration probe then waited 60 seconds and inspected the effective Worker config. Coordinator had `allowCount=2`, `leaderAllowed=true`, `adminAllowed=true`, `peerAllowed=false`, and `requireMention=true` despite Team `peerMentions: true`.
- Classification: released AgentTeams effective channel-policy boundary, not model wording.
- Change: use the documented public per-Worker `channelPolicy.groupAllowExtra` with the peer Worker name and verify the effective policy before any model turn. This does not modify AgentTeams or manufacture role authority.
- Exact cleanup passed for both the failed peer run and the configuration probe.

### No-model explicit-policy proof — PASS

- With per-Worker `channelPolicy.groupAllowExtra`, both effective configs contained peer, Leader, and Admin with `requireMention=true` before any model turn.
- Team/member/container/alias/storage cleanup passed.

### Attempt 5 — FAIL (online terminal detector)

- Sanitized post-run room history proved all four ordered events existed with correct senders and mentions, both Worker Harnesses passed, both sessions contained the nonce, and the stock Leader emitted no message.
- The online helper failed after the terminal event because jq operator precedence evaluated `.content` against a piped body string.
- Classification: test-driver oracle. The pure terminal-count function now shares the online expression and is executed by deterministic positive/negative contract tests.
- Because the helper exited before the runner compared the stock Leader session snapshots, this attempt is not promoted to PASS.

### Attempt 6 — FAIL (Engineer turn exceeded probe window)

- Effective peer policy and Coordinator ping passed.
- Engineer had one nonce-bearing persistent session file but no completed Harness marker or pong event before the bounded observer expired; Coordinator and stock Leader emitted no unexpected response.
- Classification: environment/model turn timeout or in-flight Harness behavior, not a peer allowlist failure.
- Change: shorten the transport prompt so Coordinator emits a minimal ping, Engineer is asked for one exact pong, and Coordinator retains the terminal instruction in its own room session. No timeout or assertion is weakened.
- Exact cleanup passed.

### Attempt 7 — BLOCKED (model-controlled return addressing)

- Deterministic contracts, effective explicit peer policy, Team Room topology, and both Tiangong Harness turns passed.
- Observed event chain:
  1. Admin start mentioned only Coordinator;
  2. Coordinator ping correctly mentioned Engineer;
  3. Engineer emitted the correct nonce-bearing pong marker;
  4. the pong omitted Coordinator's full MXID and had an empty `m.mentions`, so Coordinator was not awakened and no terminal event occurred.
- Stock Leader emitted zero messages throughout the observed sequence.
- Sanitized room-history inspection confirmed no Leader MXID in peer bodies and no hidden terminal event.
- Classification: current Tiangong/OpenClaw addressing contract gap. The transport can carry peer mentions—the earlier attempt produced a complete four-event loop—but the current model-text-only response contract cannot deterministically preserve the return mention.
- Exact Team/member/container/alias/storage cleanup passed.

### Attempt 8 — FAIL (stacked deterministic target, terminal re-wake risk)

- Stacked Issue #11's deterministic reply target onto this unchanged fixture.
- The complete four-event loop passed with unique event IDs, correct nonce, both real Tiangong Harness turns, exact pong `m.mentions`, and zero stock Leader messages/model turns.
- Sanitized post-run history showed that the generic reply-to-group-only-sender rule also mentioned Engineer on Coordinator's terminal event. No later message was observed before cleanup, but the terminal event could wake Engineer again.
- Classification: product routing-state gap. A successful transport loop is insufficient if terminal delivery can start another peer turn.
- Change: add a bounded per-session expected-peer set. An explicit outbound peer MXID records one expected response; receiving that authenticated sender consumes the expectation and suppresses automatic return mention. Only Matrix IDs are retained, not model prose.
- Exact cleanup passed.

### Attempt 9 — BLOCKED (released peer wake intermittency)

- The bounded correlation contract passed all deterministic tests.
- Coordinator emitted a valid nonce-bearing ping with Engineer's exact visible MXID and `m.mentions`.
- Engineer did not process that event during the bounded window and had no nonce-bearing session. Stock Leader emitted no message. This is the previously observed intermittent released Matrix/OpenClaw peer-wake boundary; the new correlation code is downstream of the missing Engineer ingress.
- The generic Harness marker contained `status=pass` but no nonce-bearing session existed, so it could not prove this event's turn. The runner now snapshots each Worker marker before the nonce and requires its metadata to change, while retaining nonce persistence as a separate assertion.
- The next failed run, if new lower-layer evidence justifies one, will also query the room through Engineer's own official Matrix credential and emit only whether the exact sender/nonce/visible MXID/`m.mentions` ping is readable. This separates account-visible delivery from OpenClaw filtering/queueing without printing message content or credentials.
- Released OpenClaw source shows that raw `groupAllowFrom` changes are dynamically read, while the simultaneously published Matrix `groups` mention policy can hot-restart the channel. The old readiness check could observe the initial join/ready logs and static file before that restart completed. The runner now requires the official `channels.status` projection to remain running, connected, healthy, non-restarting, and on one `lastStartAt` across a ten-second stable policy interval before the nonce baseline. This is a source-backed readiness hypothesis, not a passing real-smoke claim.
- No immediate model retry followed. Exact cleanup passed and the AgentTeams stack was stopped with data preserved.

### Attempt 10 — FAIL (scenario did not relay Engineer's response contract)

- After the source-backed readiness change, the no-model configuration run passed the new official `channels.status` stability boundary for both Workers.
- The focused stacked real run then proved that both channels were stable before the nonce. Coordinator emitted one valid ping, Engineer's own account could read that exact ping, Engineer's Harness marker changed, and Engineer persisted the nonce. Both channels remained running, connected, healthy, and on the same pre-probe `lastStartAt`; stock Leader emitted zero messages.
- Engineer emitted one message, but it did not contain the required `TG_PEER_PONG` marker, so the observer recorded three total events, zero pong events, and zero terminal events.
- Classification: scenario instruction gap, not the previous wake boundary. The Admin instruction required Coordinator's output to be only the ping while separately telling Coordinator how Engineer should respond; that response instruction was therefore not present in the message Engineer actually received.
- Change: require Coordinator's first reply to contain exactly two sentences: the addressed ping and the exact addressed pong instruction. This preserves the sender/mention/nonce oracle and still requires both messages to come from real Harness turns.
- Exact cleanup passed.

### Attempt 11 — BLOCKED (Admin → Coordinator wake intermittency)

- The corrected relay instruction was the only scenario change. Both official Matrix channels again passed the post-policy stability boundary before the nonce.
- Only the Admin start event appeared during the bounded window. Coordinator emitted no message, neither Worker had a post-baseline Harness marker or nonce-bearing session, and stock Leader emitted zero messages.
- Both channels remained running, connected, healthy, non-restarting, and on their pre-probe `lastStartAt` after the timeout.
- The existing target-account diagnostic could only check a downstream peer ping, which did not exist. It has now been generalized to check the exact Admin start through Coordinator's own official Matrix credential as well as the exact peer ping through Engineer's credential, emitting only sanitized pass/fail facts.
- Classification: released OpenClaw/Matrix wake boundary. Official channel health and stable lifecycle are necessary but do not prove that a specific visible mentioned event reached the Harness.
- Exact cleanup passed. No further real-model run is permitted on this implementation without new lower-layer evidence.

### Lower-layer source diagnosis after Attempt 11

Read-only inspection of the pinned OpenClaw Matrix monitor narrows the unresolved interval:

1. account visibility only proves the event is readable through the target account's Matrix credential;
2. before dispatching to an Agent Harness, the monitor applies startup, dedupe, room, sender, bot, command, and mention filters and awaits Matrix room/member state lookups;
3. the inspected call sites do not add a local timeout around those state lookups, while channel health is driven by the independent sync lifecycle;
4. therefore a running, connected, healthy channel can coexist with a dropped event or a handler awaiting pre-Harness work. This is a candidate boundary, not a proven root cause.

Draft PR #12 now writes a non-secret `status=running` Harness marker immediately on Harness entry, before awaiting the Tiangong turn, then replaces it with `pass` or `error`. The existing failure bundle already reports marker change and sanitized status. On a future evidence-justified run, the combined interpretation is:

- target account cannot read the exact event: Matrix visibility/lower transport failure;
- target account can read it, marker unchanged: OpenClaw filtering or pre-Harness handling boundary;
- target account can read it, marker changed to `running`: Harness dispatch succeeded and the Tiangong/model turn remains in flight;
- marker reaches `pass` or `error`: Harness completion is established separately from room delivery and nonce persistence.

No Matrix trace flag, temporary image, or prompt change was used to manufacture this distinction.

### Attempt 12 — BLOCKED (Coordinator turn remained in flight)

- This was the single evidence-driven run authorized after adding the pre-turn Harness marker; the fixture, prompt, model, timeout, sender/nonce oracle, and Leader-silence boundary were unchanged.
- Coordinator's official Matrix account could read the exact Admin start event, and Coordinator's nonce-baselined Harness marker changed to `status=running`.
- Therefore official OpenClaw dispatched this event into the Tiangong Harness. The previous account-visible-versus-ingress ambiguity is closed for this attempt.
- Coordinator produced no ping and no nonce-bearing persistent session before the bounded observer expired. Engineer had no turn marker because no peer ping existed. Both Matrix channels remained running, connected, healthy, non-restarting, and on the same `lastStartAt`; stock Leader emitted zero messages.
- Classification: Tiangong/model turn remained in flight beyond the bounded probe window. This is not a Matrix visibility, mention-filter, peer-allowlist, or pre-Harness dispatch failure. The marker does not identify whether the delay is session setup, Gateway/model execution, or another operation inside `runtime.runTurn`.
- Follow-up source analysis found that OpenClaw's public custom Harness params require `timeoutMs`; its built-in Harness schedules that timeout internally, while the Tiangong adapter previously forwarded only the external `abortSignal`. Released AgentTeams generates `agents.defaults.timeoutSeconds=1800`, which is longer than this unchanged observer window. Draft PR #12 now enforces the exact supplied timeout through a linked abort signal, preserves an earlier upstream abort, and rejects invalid timeouts. It does not shorten the platform timeout or convert this run into success.
- No retry followed. The failed run cleaned its exact Team/member/container/alias/storage resources. A subsequent no-model configuration run passed the reserved-resource precondition, channel-policy/stability boundary, and exact cleanup, after which the AgentTeams stack was stopped with data preserved.

### Observability gate before another real run

- Issue #13 / Draft PR #14 adds an optional sanitized OTLP boundary rooted at the Harness attempt, immediate correlated phase checkpoints, runtime/Gateway/session/pi/model/retry/tool spans, and stable complete/error/timeout/upstream-abort outcomes. It remains disabled by default and rejects ambient credential/header/certificate channels.
- The focused runner builds the same `tiangong-worker:dev` code with one non-secret owned receiver endpoint, starts a bounded test-only OTLP JSON receiver on the existing AgentTeams network, and validates three completed inbound-turn roots on success.
- The receiver persists only allowlisted span names, digested correlation identifiers, phases, outcomes, stable error types, and status codes. It rejects unknown attributes, content-bearing events/links, unbounded bodies, and wrong service/scope identities.
- Contract tests prove positive OTLP receipt, rejection of an unallowlisted prompt attribute, exact receiver ownership, and trace cleanup. This deterministic lower layer justifies at most one unchanged real-model attempt after the stacked code is built; it does not itself promote Phase 0B.

### Current result

**BLOCKED.** Attempt 12 proves Admin → Coordinator account visibility and official OpenClaw-to-Tiangong Harness dispatch on the instrumented revision, but the Coordinator turn did not complete within the unchanged bounded window. Earlier complete loops remain insufficient because they predate bounded terminal correlation or failed terminal quiescence.

Issue #11 / Draft PR #12 provide the deterministic target, one-reply correlation, and pre-turn Harness ingress marker without modifying AgentTeams. Issue #13 / Draft PR #14 and the owned receiver oracle now provide the lower-layer phase trace required before another attempt. Repeated model retries, longer observation windows, or prompt tuning must not be used to manufacture reliability. One unchanged real-model run may be considered only after all stacked deterministic, image, receiver, and cleanup contracts pass; Phase 0B remains red until the complete strengthened oracle passes.
