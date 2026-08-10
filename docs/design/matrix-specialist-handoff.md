# Matrix specialist-to-Leader handoff

> Status: target routing contract and P0 capability boundary. The Work/outbox
> lifecycle described here is not implemented by the current v0.2 runtime.

## Decision

The first Tiangong Web/runtime release will not require the Leader to passively
observe every Human message in a bound Team room.

All professional Workers, including the Leader, keep Matrix mention gating
enabled. When a Human mentions only a specialist, that specialist explicitly
hands the request to the Leader with a visible Matrix message that mentions the
Leader. This adds one visible handoff event but works through the public
AgentTeams/OpenClaw routing contract and does not require an invisible mention,
a frontend relay, or Human impersonation.

## Verified platform boundary

AgentTeams v1.2.0 exposes additive and subtractive Matrix sender allowlists
through `channelPolicy`. Its generated OpenClaw Worker configuration retains:

```text
channels.matrix.groups["*"].requireMention = true
```

for both Leaders and ordinary Workers. The released AgentTeams resource API has
no per-Worker/per-room activation field that can make only the Leader receive
unmentioned Team-room events. Tiangong therefore does not depend on that
unavailable projection.

AgentTeams peer policy and the existing Worker peer-mention smoke do provide a
public path for one authenticated Worker identity to send a visible rich
mention to another Worker in the shared Team room. P0 must prove the bounded
handoff shape on the pinned stack; it does not prove that the future Work and
outbox implementation already exists.

## Target event chain

```text
Human event visibly mentions Specialist
→ control runtime authenticates Human, bound room, and Specialist admission
→ room ID + Human event ID deduplicate one Work
→ Work source binding + specialist-handoff intent + outbox commit atomically
→ Specialist turn may start
→ Specialist Matrix identity sends a visible rich mention to current Leader
→ Matrix event ID acknowledges the send
→ official Leader Matrix ingress receives that handoff event
→ Leader ingress validates its structured Work/source reference
→ Leader resolves the original Human event and current Work facts
→ Leader stays silent for a simple answer or publicly takes over
```

The handoff body is bounded and ordinary-client-readable. Its
`formatted_body` contains an escaped `matrix.to` link for the full Leader MXID,
and `m.mentions.user_ids` contains exactly that Leader MXID. Code also writes a
namespaced structured reference to the existing Work and original Human event.
Visible body text is explanatory and cannot select the authoritative Work.

On Leader ingress, the adapter uses the authenticated specialist sender and the
handoff `currentMessageId` to fetch the raw Matrix event, validate the structured
reference against the durable communication intent's expected Work, source,
sender, and recipient, and bind it idempotently to the existing Work. If the
pinned OpenClaw path later proves that it faithfully carries the required
structured content, that directly observed content may be used; model-visible
prose is never the reference oracle.

The Human remains the author of the original request. The specialist remains
the author of the handoff. Neither the minimal API nor another service account
may send either message on their behalf.

## Authority and fact semantics

- Work admission is based on the authenticated original Human event, not on the
  specialist's handoff prose.
- A specialist handoff is Agent communication. It must enter an authenticated
  member-communication path and must never be admitted as a new Human Work.
- The current Team binding and enabled MemberConfig select the specialist and
  Leader identities. A name, display name, prompt, or message body cannot select
  an authority.
- Only the Leader may create or cancel Tasks and complete or stop a Work.
- A direct specialist reply is ordinary communication, not a Task Result.
- Formal delivery, filesystem writes, testing, additional roles, sustained
  tracking, or external effects require a Leader-created Task and the relevant
  later capability gates.

## Delivery and failure contract

The future control runtime must use one durable Matrix delivery protocol for
handoffs, ordinary replies, and structured notifications:

```text
business fact + communication intent + outbox in one transaction
→ sender-identity-scoped claim
→ stable Matrix transaction ID
→ send
→ Matrix event_id acknowledgement
→ bounded retry/restart reconciliation
```

Required behavior:

- duplicate ingress creates neither a second Work nor a second handoff intent;
- duplicate claim, send, acknowledgement, recipient ingress, or restart does
  not create a second visible handoff or a second Leader wake-up;
- the specialist turn starts only after Work admission and the durable handoff
  intent have committed;
- sender-side Matrix acknowledgement and Leader-side receipt are separate
  facts; acknowledgement cannot claim that the Leader processed the event;
- a pending or failed send or Leader receipt remains visible in product state
  and keeps the Work open;
- a Matrix timeout without a trustworthy outcome is reconciled by transaction
  identity or event observation, not by blind creation of another intent;
- Leader takeover and specialist reply races preserve both communications, but
  only authorized actors may append Task or closure facts;
- messages from Workers cannot pass the Human-admission check;
- non-bound rooms remain ordinary Matrix chat.

A model may add useful professional context, but reliable handoff is enforced
by code. Prompt instructions such as “remember to report to the Leader” are not
a delivery guarantee.

## P0 capability truth table

| Source event | Expected receiver path | Expected product interpretation |
|---|---|---|
| Human mentions only Specialist in bound room | Specialist receives original event; Leader and other specialists do not start from it | future runtime may admit one Work |
| Specialist visibly mentions Leader in handoff | Leader receives handoff through official Matrix/OpenClaw routing and validates the raw event reference | communication for the existing Work |
| Specialist sends no Leader mention | Leader does not start | handoff remains undelivered; no success claim |
| Agent sends a handoff-shaped message | Leader may receive it when mentioned | never a new Human Work |
| Same Matrix transaction ID is retried | one Matrix event | same handoff delivery |
| Message is in a non-bound room | ordinary chat behavior | no Tiangong Work/control facts |
| Display name or hidden frontend signal names Leader | rejected as a routing shortcut | no authority or delivery fact |

P0 must record the original and handoff event IDs, verified senders, room,
structured mentions, effective mention policy, bounded delivery observations,
and exact cleanup of owned Team/Worker/room/storage resources. It must not
retain tokens or unrestricted message bodies.

## Gate

P1 may not claim this feature. P0 only establishes that the explicit Matrix
handoff route is feasible on the pinned public platform.

The complete direct-specialist lifecycle may be enabled only when later slices
implement and test authenticated Work admission, source-event resolution,
durable outbox delivery, distinct send acknowledgement and Leader receipt,
raw-event structured-reference validation, replay handling, Leader wake-up,
failure visibility, and closure races. If the explicit peer-mention route
cannot be reproduced, the fail-closed fallback is to require the Human to
mention the Leader directly.
