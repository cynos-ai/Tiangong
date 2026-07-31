# Worker runtime rules

Use these rules for `worker/`, AgentTeams/OpenClaw integration, tools, Gate, approval, Evidence, and recovery.

## Ownership boundary

- AgentTeams supplies team/container/Matrix/storage integration and Worker-scoped Gateway credentials.
- Official OpenClaw owns Matrix login, E2EE behavior, allowlists, mentions, room lifecycle, sync, typing, media, queueing, and delivery.
- Tiangong owns the Agent Plane: turn contracts, pi session, context, model selection, tools, Skills, Concern, Gate, approval, Evidence, idempotency, and recovery.
- Keep `worker/plugin/openclaw-adapter.mjs` a thin DTO adapter. Do not place Agent business logic in the Channel adapter.
- Keep OpenClaw's bundled pi dependencies isolated from Tiangong's pinned pi runtime.
- Do not enable an OpenClaw Agent Harness fallback that can hide a Tiangong failure.

## Model and session boundary

- Claim only explicitly supported providers and copy only allowlisted non-secret provider metadata.
- Inject the Worker Gateway credential through the model runtime in memory.
- Disable automatic discovery of external tools, extensions, Skills, prompt templates, and repository context until Tiangong owns and validates those inputs.
- Persist Tiangong sessions and runtime state only beneath the fixed Worker state root.

## Tool boundary

- Every active tool must come from the Tiangong registry and execute through the Tiangong wrapper.
- Gate evaluation, authorization, idempotency, Evidence, and rollback wrap the backend executor; prompts and extension callbacks are not sufficient.
- Keep tools sequential until concurrency semantics for Gate, Evidence, approval, and idempotency are explicitly implemented and tested.
- Add the smallest tool set that proves the current contract. Do not enable `bash` before command authorization, environment isolation, timeout, output sanitization, and sandbox behavior are defined.
- Filesystem tools must reject workspace escape, symlink traversal, runtime state, and credential-bearing paths.

## Approval and recovery

- Persist pending approval as a versioned Tiangong operation envelope; do not depend permanently on an upstream transcript's internal representation.
- Validate approval or rejection commands before entering the model loop.
- Bind approval to requester or an explicit Tiangong-owned owner policy and require the same operation digest. Until that policy exists, only the requester may approve or reject.
- Never reconstruct authorization from a natural-language summary.
- Do not automatically retry an `executing` operation after a crash. Reconcile first.
- Time only establishes a stale-candidate threshold; determine reconciliation from the protected payload, workspace scope, target digest, approved precondition, and rollback snapshot.
- Record reconciliation decisions separately from execution Evidence. An applied outcome may become completed, an unchanged precondition may return to approved for explicit requester replay, and a conflict must remain blocked.
- Retain terminal idempotency metadata for the declared 90-day replay window; compact only through an explicit operator action after appending a summary Evidence event.
- Keep normal idempotency transitions append-only and maintain unique key/invocation/approval indexes. Full active-state rewrite belongs only to explicit retention maintenance.
- Erase raw pending payloads after completion, rejection, or applied reconciliation, but retain payloads and snapshots for uncertain or conflicting outcomes. Keep AgentTeams remote erasure internal to the runtime; never expose storage credentials or `mc` as model tools.
- Bound new model turns by transcript entry and byte capacity while keeping deterministic approval/rejection control commands available.

## Verification

For a relevant runtime change, prove the deterministic contract first, then run Basic or Full smoke according to `docs/rules/verification.md`. Preserve the official Channel Plane in the real integration test.
