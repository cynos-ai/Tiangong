# Specialist-to-Leader Matrix handoff P0 probe

## Scope

- Level: focused P0 capability probe
- Public baseline: `origin/develop@36d8c4b47ff43dfc7c0783ed31e0314059b50de3`
- Related design: `docs/design/matrix-specialist-handoff.md`
- Reused durable scenario: `smoke-testing/scenarios/worker-peer-mentions.md` B1
- Product code enabled by this run: none
- Provider/model: AgentTeams Gateway / fixture-pinned `qwen3.5-plus`; deterministic peer controls dispatch no model request
- Status: PASS for the explicit Worker-to-Worker Matrix transport prerequisite; target Work/outbox handoff remains unimplemented

## Decision under test

The first target runtime keeps `requireMention:true` for every professional
Worker. A directly mentioned specialist will use a visible rich Matrix mention
to hand the request to the Leader instead of relying on passive Leader room
observation.

This run proves only the released transport prerequisites:

```text
Human-visible rich mention → one Worker ingress
Worker-owned visible rich mention → another Worker ingress
stable correlated Matrix events → no peer reply loop
```

The existing transport identities are not treated as trusted professional roles.
The run does not claim that target Work admission, PostgreSQL outbox delivery,
or Leader takeover already exists.

## Boundary truth table

| Boundary | Required observation | Rejected shortcut |
|---|---|---|
| Original Human event | structured mention targets only the first Worker | hidden Leader mention or full Leader MXID in body |
| Worker handoff transport | event sender is the authenticated first Worker and `m.mentions` targets exactly the second Worker | test driver or service account sends as the Worker |
| Recipient ingress | second Worker has a correlated changed Harness/session fact | message visibility or model prose alone |
| Return correlation | recipient replies with the same nonce and exact first-Worker mention | unbound ordinary text |
| Terminal behavior | final event has no peer mention and no later peer/Leader event | cleanup immediately after first reply |
| Passive Leader control | stock Leader remains silent with unchanged session snapshot | assuming Leader saw the original event |
| Cleanup | all exact owned resources are absent | broad or name-derived deletion |

## Preconditions

1. repository policy, Skills, Worker tests, observability, and the focused smoke
   contract pass;
2. `make verify` passes against the pinned local AgentTeams stack;
3. the reserved peer-smoke Team, Workers, containers, aliases, storage prefixes,
   OTLP receiver, volume, and trace path are absent;
4. the configured provider/model are not changed to make the run pass;
5. no credentials or unrestricted event bodies are captured.

## Commands

```text
bash scripts/check-repository.sh
node scripts/check-skills.mjs
npm --prefix worker test
npm --prefix worker run check-observability
make check-demo-contract
make test-peer-mention-smoke-contract
make verify
make test-peer-mention-smoke
```

Only the last command creates disposable AgentTeams/Matrix resources. The peer
transport control is deterministic and is not a model verdict.

## Required machine observations

- effective Coordinator and Engineer Matrix policies contain the expected
  authenticated peers and retain `requireMention:true`;
- the original Admin event mentions only Coordinator;
- exactly four ordered, nonce-correlated events exist: Admin start, Coordinator
  ping, Engineer pong, and Coordinator terminal;
- ping/pong senders and structured mentions match their exact authenticated
  Worker identities;
- both Worker Harness markers and persistent sessions changed for the current
  nonce;
- terminal delivery does not re-wake a Worker;
- the stock Leader emits no event and its session snapshot does not change;
- all run-owned Team, Worker, container, Matrix alias, storage, receiver,
  receiver-volume, helper, and trace resources are absent after cleanup.

These observations establish a public Worker-to-Worker explicit-mention route.
They do not establish the future `specialist-handoff` database intent, Work
source binding, raw-event structured-reference validation, distinct sender ack
and Leader receipt, stable outbox transaction identity, or failure/restart
state. Those remain implementation and Gate requirements of later
target-runtime slices.

## Failure discipline

- First failure: classify platform routing, Worker adapter, Harness, observer,
  readiness, or cleanup and preserve only bounded sanitized diagnostics.
- Second failure of the same class: stop and add lower-layer evidence before
  another real run.
- A timeout does not prove unauthorized delivery or successful absence.
- Any cleanup failure keeps the run failed.
- Do not patch generated OpenClaw configuration, disable mention gating, inject
  a hidden mention, or send a peer event with the test driver.

## Result

### Attempt 1 — PASS

Execution date: 2026-08-11.

The runtime, scripts, fixtures, and smoke paths used by the local configured
stack were first verified Git-identical to the recorded public baseline. The
focused contract, repository policy, three project Skills, 271 Worker tests,
observability contract, demo contract, and AgentTeams readiness all passed
before the real run.

The real run then observed:

```text
matrix_peer_team_room_topology=pass
matrix_peer_channel_policy=pass
matrix_peer_active_channel_stability=pass
worker_peer_event_chain=pass
peer_coordinator_harness=pass
peer_engineer_harness=pass
peer_coordinator_start_observability=pass
peer_engineer_ping_observability=pass
peer_coordinator_pong_observability=pass
stock_leader_message_count=0
stock_leader_model_turn_count=0
peer_test_identities_are_not_role_authority=pass
```

The four unique correlated event IDs were:

```text
start=$oBvdMuryeeM2AbZFtBGHTqtMFmC_gOLhibAOnNX1zOA
ping=$GaixUphfsiLY82X1a3yzmsZvCzRk5r8aV2hJe3VyL3I
pong=$Fpmqf8tMAkNLhBjyVq2KfYSzAdrUf640IkUWBrxK3l8
done=$75qqNcc5Kv0wbIV4j_jn-gBrX-RovZJCLHlElelVZCg
```

The runner reported Team and Matrix alias cleanup success. A separate
post-run check found zero matching containers, Workers, or Teams and confirmed
`.runtime/peer-smoke-observability` absent.

Verdict: the pinned public platform can carry a deterministic, authenticated,
visible rich-mention handoff between Worker identities while every Worker
retains mention gating and an unmentioned Leader remains idle. This is enough
to select explicit specialist-to-Leader handoff as the target routing shape.
It is not evidence for Work admission, the future `specialist-handoff` outbox,
source-event resolution, distinct Leader receipt, or Leader takeover, which
remain gated implementation.
