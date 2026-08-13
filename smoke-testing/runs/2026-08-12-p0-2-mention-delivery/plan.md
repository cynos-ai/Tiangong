# P0.2 mention-gating regression and delivery contract — focused run

## Ownership

- Related implementation: none new. This is a P0 transport/regression probe.
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`.
- Driver: `smoke-testing/support/run-p0-2-mention-delivery.sh`
- Deterministic contract: `smoke-testing/support/p0-2-mention-contract.mjs`
  (`make test-p0-2-mention-contract`)
- Fixtures: `smoke-testing/fixtures/p0-2-mention-{workers,team}.yaml`
- Update triggers: any change to the Worker mention gate, the Dashboard chat
  wire format, or the worker-owned Matrix delivery contract.

## Scope

Closes the three remaining P0.2 items with direct machine facts against a real
`requireMention:true` Worker in a bound Team room:

1. **Dashboard `body=@displayName` regression (negative).**
2. **OpenClaw ordinary reply: stable delivery echo / replay safety.**
3. **Sender preservation: Human keeps Human sender; Worker reply carries the
   Worker sender.**

It does **not** implement the target CoordinationStore, Work admission, or any
P1 API. The "rich mention wakes a Worker" positive fact is additionally covered
by the merged peer-mention and Specialist-to-Leader handoff smokes.

## Frozen worker-owned delivery contract (decision for P1)

- The Matrix `event_id` is the stable delivery echo / queryable ack for any
  Human or Worker message (verified via `GET /event/{id}`).
- The Matrix transaction id (the `.../send/m.room.message/<txn>` path segment)
  is the send-idempotency key: a duplicate PUT with the same txn id returns the
  same `event_id` and creates no second event or second effect.

This is the contract P1 builds on; no separate retry/ledger is introduced.

## Probe facts (observed 2026-08-12)

- Disposable Team (stock Leader + one Tiangong openclaw Worker) became Active
  with `readyWorkers == 1`; the Target Worker retained `requireMention:true`
  in the bound team room and joined it.
- **Dashboard-format mention** (`body=@DisplayName …`, `formatted_body` plain
  text with **no** `matrix.to` anchor, `m.mentions.user_ids=[worker]`) did **not**
  wake the Worker (harness snapshot unchanged after the bounded window).
- **Standard rich mention** (`formatted_body` with a `matrix.to` anchor for the
  Worker MXID + `m.mentions.user_ids=[worker]`) **did** wake the Worker (harness
  turn observed).
- Re-sending the rich mention with the **same Matrix transaction id** returned
  the **same event id**; no second event/effect.
- The Worker's ordinary reply was observed as a Matrix event with a stable
  `event_id`, queryable via `/event/{id}`, with `sender == Worker` (not the
  Human). The Human's sent events preserved `sender == Human`.

## Required evidence (direct machine facts)

- `p0_2_dashboard_mention_no_turn=pass` (harness snapshot unchanged).
- `p0_2_rich_mention_wakes_worker=pass` (harness snapshot changed).
- `p0_2_replay_same_event_id=pass` (duplicate txn id → identical event id).
- `p0_2_worker_reply_echo_sender_preserved=pass` + captured reply `event_id`.
- Deterministic wire-format boundary + replay + sender contract (5/5).

## Owned resources and cleanup proof

Owned per run: stock Leader Worker, Tiangong Target Worker, the Team, the
reserved storage prefixes `agents/<leader>`, `agents/<target>`, `teams/<team>`,
the Manager's membership in the Worker rooms, the team and leader-DM Matrix
aliases, and the disposable admin Matrix session.

Cleanup is fail-cold: the driver logs out the admin, leaves the Manager from
each Worker room, deletes the Team, restarts the Manager, deletes the Workers,
purges the reserved storage, deletes the aliases, and verifies each is absent.
On the recorded passing run, the Team and both Workers resolved to 404, no
Worker containers remained, the storage prefixes were empty, the Manager
manifests were absent, and the run state directory was removed.

## Not claimed

- Target CoordinationStore, Work admission, durable intent/outbox, or P1 API.
- Production Leader handling, takeover, or reconciliation.
- Driving the Dashboard web UI itself; the Dashboard bug class is exercised via
  its documented wire format (plain `formatted_body` + `m.mentions` without a
  `matrix.to` anchor), which is the exact shape that fails the gate.
