# Peer transport diagnostic

Tiangong provides a bounded transport-only control protocol for verifying Worker-to-Worker Matrix wake-up without making exact transport markers depend on stochastic model prose.

This protocol is a diagnostic. It is not Team Work, an Assignment, a Result, a trusted Role Profile, approval, or Evidence.

## Authority boundary

Official OpenClaw authenticates Matrix ingress and remains the only Matrix sender. The Tiangong adapter derives peer authority from the effective channel policy:

```text
authorized peers = groupAllowFrom - dm.allowFrom
```

The current sender must itself be present in the effective group or DM allowlist. Tiangong accepts only validated full Matrix user IDs, at most 32 unique peer targets, and never derives authority from a prompt, display name, Worker name, identity text, or model output.

A start is valid only when exactly one authorized outbound peer exists. Ping and pong are bound to the authenticated group-only sender. A terminal response is allowed only when that sender and nonce match the pending peer correlation.

## Protocol

The reserved control markers carry one lowercase UUID-shaped nonce:

```text
TG_PEER_START nonce=<nonce>
TG_PEER_PING nonce=<nonce>
TG_PEER_PONG nonce=<nonce>
TG_PEER_DONE nonce=<nonce>
```

Only `START`, `PING`, and `PONG` are valid ingress controls. Runtime behavior is deterministic:

```text
START -> mention the one authorized peer with PING
PING  -> reply to the authenticated sender with PONG
PONG  -> consume the matching pending peer/nonce and emit unmentioned DONE
```

Malformed or ambiguous controls, multiple authorized start targets, unknown senders, nonce mismatches, repeated turn IDs, and consumed plans fail closed. Ordinary prompts that contain no reserved control marker continue through the normal model path.

The runtime stores only bounded correlation state and records the deterministic control output in the Tiangong session. It does not call the model for a transport control. A completed trace includes `peer.transport.start`, `peer.transport.ping`, or `peer.transport.pong`; model phases are intentionally absent. Diagnostic telemetry remains lossy and is not Evidence.

## Limitations

The protocol proves only authenticated Harness-to-official-OpenClaw-to-Matrix transport and bounded peer wake-up. It does not establish professional role authority, formal Work state, independent verification, recovery, or exactly-once external delivery.
