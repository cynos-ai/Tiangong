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
- exact cleanup proof for every owned resource.

## Blocked and failure rules

- Do not modify AgentTeams or use direct CR/config-watcher/unreleased paths.
- Do not send peer messages with the test driver; only global Admin may send the start event.
- Do not weaken sender, mention, nonce, Leader-silence, Harness, or cleanup assertions to accommodate model behavior.
- A timeout is an environment/model or behavior failure, not proof that transport is unsupported.
- On the first failure, classify the failing layer and add the smallest diagnostic.
- On a second failure of the same class, stop before a third real run unless new lower-layer evidence exists.
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
- No model retry followed. Exact cleanup passed and the AgentTeams stack was stopped with data preserved.

### Final result

**BLOCKED.** Phase 0B is not promoted on either a lucky model-formatted address or an earlier successful transport run when the final bounded implementation did not complete.

Issue #11 / Draft PR #12 now provide the smallest deterministic target and one-reply correlation contract without modifying AgentTeams. The real released path must still pass the strengthened sender/mention/nonce/terminal/Leader-silence oracle on the final revision. No additional real-model retry is permitted without new lower-layer evidence for the intermittent Engineer wake failure.
