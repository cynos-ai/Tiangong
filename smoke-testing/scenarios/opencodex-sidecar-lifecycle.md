# OpenCodex sidecar lifecycle smoke scenarios

## Ownership

- Related implementation: `worker/agent/deployment/opencodex-sidecar.mjs`,
  `worker/agent/preflight/codex-gateway-preflight.mjs`.
- Related design: `docs/design/opencodex-sidecar-deployment-contract.zh.md`.
- Related state/Evidence: AgentTeams deployment receipt, Worker preflight log,
  Team room message IDs, and the deployment adapter's sanitized lifecycle
  events. Never retain a provider key, consumer token, prompt, tool payload, or
  model transcript as evidence.
- Update triggers: AgentTeams Controller/deployment API changes, OpenCodex
  image/version changes, credential projection changes, or route/profile schema
  changes.

## Basic smoke

### B1: Ready receipt gates a real Team task

- Purpose: Prove the supported Chat-only route is explicit and that a Worker
  cannot start without an AgentTeams-owned ready sidecar.
- Setup: Reserve a unique `teamId`, `leaderWorkerId`, `bridgeWorkerId`, and
  sidecar identity. Refuse to replace existing resources. Provision the
  OpenCodex sidecar through the AgentTeams deployment adapter, project only a
  Worker-scoped credential reference, and wait for an observable `ready`
  receipt. The selected AgentTeams path must preserve `accessEntries` through
  admission (native Kubernetes CR or an upstream REST DTO fix); acceptance of
  an unknown YAML field by the unpatched embedded CLI is not sufficient.
- Prompt: Leader sends one deterministic task marker to the bridge Worker in
  the Team room; the Worker replies with the run-owned marker.
- Expected observations:
  - deployment receipt is `phase=ready`, with matching endpoint, provider,
    model, bridge, and generation;
  - Worker preflight reports `sidecarReadiness=pass` and `transport=responses-via-chat-bridge`;
  - Team is Active, both Worker identities are ready, and the expected marker
    is delivered in the Team room;
  - execution metadata identifies `provider=codex`, the selected model, and no
    fallback.
- Required evidence: sanitized receipt fields, Worker phase/preflight facts,
  Team/Worker resource names, and Matrix event IDs for the marker and reply.
- Skip/block rules: Missing receipt, mismatched generation/route, failed
  readiness, or any automatic fallback is a red run. A model response without
  matching Worker/Matrix facts is not success evidence.

## Full smoke

### F1: Provision, rotate, restart/reconcile, drain, and remove

- Purpose: Prove sidecar lifecycle ownership, recovery, and credential
  isolation across the complete external boundary.
- Setup: Use only the run-owned sidecar, Team, Worker, and temporary receipt
  paths. The adapter must inject a secret by reference; the raw value must not
  enter the Worker filesystem, image environment, command arguments, logs, or
  Evidence.
- Steps and expected machine facts:
  1. `provision` creates the exact sidecar identity and leaves it in
     `provisioning`; no Worker starts before readiness.
  2. `ready` passes bounded health, readiness, model, provider, and endpoint
     checks; the Worker starts only after the matching receipt is projected.
  3. One real Team task completes through OpenCodex; Matrix/WebUI remains the
     AgentTeams channel surface.
  4. `rotate` advances generation by exactly one. The new reference works, the
     old reference is no longer admitted, and no raw key is observable in
     Worker state or diagnostics.
  5. Capture the adapter's sanitized credential-projection checks: Docker
     create metadata and argv contain no raw value, the sidecar config stores
     only the variable reference, logs/receipts contain no raw value, and an
     unrelated Worker cannot read the sidecar process environment. Any
     unobservable check is red.
  6. Restart the sidecar or deployment controller. `reconcile` recovers only
     from current adapter status and generation; a lost response is never
     replayed blindly and never falls back to builtin/another model.
  7. `drain` rejects new turns, resolves in-flight work with a bounded
     cancellation/timeout fact, and leaves no unresolved active turn.
  8. `remove` reclaims the sidecar, temporary receipt, session/cache, and
     run-owned Team/Workers. Verify absence by exact resource identifiers.
- Required evidence: sanitized lifecycle events for each transition, current
  generation and route metadata, preflight result, one Team-room correlation,
  credential-projection check results, restart/reconcile facts, drain terminal
  fact, and exact cleanup checks.
- Blocked paths: readiness failure, stale receipt, generation mismatch, raw key
  observed, fallback, ambiguous post-restart state, unbounded drain, or any
  cleanup failure keeps the run red. Do not infer success from HTTP 2xx alone.

## Truth table

| Case | Expected result | Stable proof |
|---|---|---|
| Native Responses model without sidecar receipt | Pass on native route | `transport=native-responses`; no bridge requirement |
| Chat-only model with matching ready receipt | Pass | receipt route/generation + preflight + Team event IDs |
| Chat-only model with missing receipt | Deny before Worker start | `codex-sidecar-receipt-missing` |
| Receipt endpoint/model/generation mismatch | Deny before Worker start | bounded preflight error code |
| Rotation adapter call loses response | Stay in recovery-needed phase | adapter status/reconcile; no blind retry |
| Drain/remove before the required phase | Deny | deterministic sidecar phase error |
| Cleanup of a non-run-owned resource | Refuse | ownership check and unchanged external resource |
| Raw credential appears in metadata/argv/config/logs or cross-Worker `/proc` | Red; do not promote | sanitized projection checks with explicit negative facts |
| Config stores only a variable reference and isolation checks pass | Continue | reference-only config plus all projection checks pass |

## Maintenance notes

The deterministic Node tests prove the state machine and receipt parser. They
do not prove that AgentTeams v1.2.2 has a Controller-managed OpenCodex adapter;
the Full smoke must remain blocked until that adapter is implemented, the
`accessEntries` admission boundary is effective, and real
restart/rotation/drain/remove evidence is available. Keep DeepSeek native
Responses as the default route while this scenario is red or blocked.
