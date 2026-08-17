# Specialist-to-Leader Matrix handoff P0 probe

## Scope

- Level: focused P0 capability probe
- Public baseline: `develop@dbc89b3197cda280280e957acc4e960152add6be`
- Related design: `docs/design/matrix-specialist-handoff.md`
- Product code exercised: bounded Specialist command parsing, authenticated
  Specialist-to-Leader Matrix transport, stable Matrix replay, sender-side
  acknowledgement persistence, and the `handoff.transport.sent` observability
  checkpoint
- Provider/model: AgentTeams Gateway / `deepseek-v4-flash`
- Status: PASS for the explicit visible handoff transport and its released
  Worker/runtime boundary; Work admission, PostgreSQL outbox, and production
  Leader structured-reference handling remain gated

## Decision under test

Every professional Worker retains `requireMention:true`. A Human event that
mentions only a Specialist may cause that Specialist to send one visible rich
Matrix mention to the authenticated current Leader. The Leader is proved by
its own Matrix ingress and persisted CoPaw session change; room visibility or
model prose alone is not treated as receipt.

The handoff carries a bounded namespaced structured reference containing the
source room/event/sender, Work and intent identifiers, authenticated sender,
and current recipient. The Matrix transaction ID is derived from that exact
reference, so a transport replay returns the same Matrix event instead of
creating a second visible handoff. The sender acknowledgement is persisted in
the Specialist session and is separate from the Leader receipt.

## Boundary truth table

| Boundary | Required observation | Rejected shortcut |
|---|---|---|
| Human source | current Matrix event visibly mentions exactly the Specialist | hidden Leader mention, display-name routing, or test-driver Specialist send |
| Specialist admission | bounded command has the authenticated Matrix actor/current event and exactly one authorized Leader recipient | prose-selected recipient, peer-originated control, malformed/ambiguous command |
| Sender transport | authenticated Specialist emits one rich mention whose structured reference matches the source and current IDs | Human/service-account impersonation or body prose selecting Work |
| Sender acknowledgement | one persisted `TG_HANDOFF_SENDER_ACK` binds one transaction ID, event ID, and replay event ID | Matrix acceptance alone or a model claim |
| Replay | same stable transaction ID and Matrix event ID; visible event count is one | second event or second recipient wake-up |
| Invalid reference | a valid-shaped mutation of the observed raw reference is rejected by the bounded validator | accepting body prose or an unbound source reference |
| Leader receipt | Leader account observes the handoff and its independent persisted session snapshot changes | passive room observation or a Leader reply alone |
| Human Work boundary | no Work/Task admission fact or exact Work/intent storage path is created | treating Agent communication as new Human Work |
| Observability | Specialist trace has a completed Harness attempt and `handoff.transport.sent`, with no model span for the deterministic handoff | model telemetry or an uncorrelated log line |
| Cleanup | exact Team, Workers, aliases, storage, OTLP receiver/volume/path, and helpers are absent | broad or name-derived deletion |

## Preconditions

1. repository policy, focused Skills, Worker tests, observability, and this
   contract pass;
2. the pinned local AgentTeams stack and generated environment are ready;
3. reserved Team/Workers/containers, Matrix aliases, storage prefixes, OTLP
   receiver/volume/path, and helper paths are absent;
4. the run uses the fixture-pinned public AgentTeams images and model;
5. no credentials or unrestricted Matrix bodies are retained as evidence.

## Commands

```text
./scripts/test-specialist-leader-handoff.sh
TIANGONG_GENERATED_ENV=/home/sj/codes/Tiangong/.runtime/agentteams/manager.env \
  make test-specialist-leader-handoff
```

The contract wrapper performs shell/Node checks and deterministic tests before
the real run. The real run creates only the reserved disposable resources in
the fixture, sends the Human source event through Matrix, and lets the
Specialist own the handoff send.

## Required machine observations

- one pinned stock CoPaw Leader and two pinned Tiangong Workers are Running;
- effective Matrix topology includes the exact authenticated peers and retains
  `requireMention:true`;
- the source event and handoff event IDs, authenticated senders, room, rich
  mentions, and structured reference are validated from Matrix responses;
- the Specialist session contains one sender acknowledgement with a stable
  replay event ID;
- the handoff transaction and event are:

  ```text
  source=$zXOq1QGZUo5tabpcsCvND6KjZXDBiLG-2G3_NwKA1uI
  transaction=tiangong_2930b9068948a5bf81c21f4e9be64234c249820260d1b1cf04ee0def87ec1eb2
  handoff=$15kLgMuzD_iWyPIK0wmYjPXI1Y4v_XjFiTDdno31oHk
  replay=$15kLgMuzD_iWyPIK0wmYjPXI1Y4v_XjFiTDdno31oHk
  ```

- `handoff_visible_event_count=1`, invalid-reference fail-closed validation,
  independent Leader receipt/session change, no Work/Task facts or exact
  Work/intent paths, observer non-interference, and completed trace evidence
  all pass;
- all exact run-owned resources are absent after cleanup.

## Result

### Final real attempt — PASS

Execution date: 2026-08-11. The focused contract suite passed 10/10 before
the real run. The real run passed:

```text
handoff_observability_receiver=pass
matrix_handoff_alias_team_absent=pass
matrix_handoff_alias_leader_dm_absent=pass
stock_leader_runtime=pass
handoff_worker_runtime_and_channel_readiness=pass
matrix_peer_team_room_topology=pass
matrix_handoff_channel_policy=pass
matrix_handoff_active_channel_stability=pass
handoff_human_event_sent=pass
handoff_specialist_sender_ack=pass
handoff_specialist_harness=pass
handoff_human_source=pass
handoff_raw_reference=pass
handoff_invalid_reference_fail_closed=pass
handoff_visible_event_count=1
handoff_leader_receipt=pass
handoff_leader_session_changed=pass
handoff_agent_communication_not_human_work=pass
handoff_observer_non_interference=pass
handoff_specialist_handoff_observability=pass
matrix_handoff_alias_team_cleanup=pass
matrix_handoff_alias_leader_dm_cleanup=pass
```

The final run left no reserved containers or volumes and no
`.runtime/specialist-handoff-observability` path. Direct post-run checks also
confirmed the temporary Team, Workers, exact storage prefixes, OTLP receiver,
OTLP volume, and helper paths were absent. Credentials were used only inside
the disposable smoke helpers and were not included in the report.

## Failure discipline

- A timeout or missing session fact is not treated as proof of receipt.
- A failed cleanup keeps the run red and retains only the bounded state needed
  to diagnose ownership or deletion.
- Generated OpenClaw configuration is not patched during the run; mention
  gating and the official Matrix channel remain the routing boundary.

## Limits and next gate

This probe does **not** claim authenticated Human Work admission, durable
PostgreSQL communication intent/outbox state, restart reconciliation,
production Leader-side raw-event validation, Leader takeover, ordinary
OpenClaw delivery acknowledgements, or Work closure. The invalid-reference
fact above is the public smoke validator's fail-closed oracle over the observed
raw event; it is not a production Work/Leader receiver implementation.

P1 and the later target-runtime slices remain blocked until the complete P0
Gate—including P0.4–P0.8 identity/PG, prepared execution, capacity,
retention, and backup probes—passes.
