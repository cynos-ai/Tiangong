# Coordination runtime smoke scenarios

## Ownership

- Related implementation: app/coordination/runtime-server.mjs, app/Dockerfile, scripts/deploy-coordination-runtime.sh
- Related state: PostgreSQL CoordinationStore, Matrix wake Outbox, /api/runtime
- Update triggers: binding schema, Control API auth, runtime image, secret injection, or AgentTeams deployment contract changes

## Phase B3 Task/Result checks

- Create one Task through the CoordinationStore with an exact assignee and current Work epoch.
- Submit one schema-valid Result and verify the Task projection becomes `reported`, the Result is readable through the narrow Gateway, and the Work timeline/epoch advance together.
- Race a Result submission against cancellation for the same Task; exactly one terminal fact may commit and the loser must receive a conflict.
- Restart the runtime and confirm Task/Result and pending wakes are read from PostgreSQL rather than process memory.
- `/api/runtime` may expose bounded claim/blocker summaries and reference counts only; it must not expose raw ToolResult payloads or deployment credentials.

## Basic smoke

### B1: Runtime readiness and bounded deployment

- Purpose: prove the deployment-owned runtime starts with a valid binding and reaches readiness without exposing secrets.
- Setup: disposable PostgreSQL, one uniquely named Team binding, owner-only env/binding files, and the pinned Coordination image.
- Prompt: admit one non-destructive Matrix Work and wait for its Leader resume wake.
- Expected observations:
  - /healthz and /readyz are successful; readiness source reports PostgreSQL and, when enabled, Matrix identity.
  - exactly one Work is bound to the source Matrix event and one Leader-resume wake is acknowledged.
  - /api/runtime exposes bounded Work/Timeline/Outbox projections only.
- Worker container environment contains no PG URL or deployment Matrix token.
- When Task/Result wakes are present, assignment is sent only to the enabled assignee and result notification only to the current Leader; both receipts are durable and deterministic.
- Required evidence: container labels, image digest, readiness JSON, Work ID, wake ID/status, and sanitized cleanup result.
- Before the prompt, run verify-leader-runtime-injection.sh against the actual Leader container. It must pass; a prompt/SOUL mention of the path is not injection evidence.
- Skip/block rules: block if AgentTeams cannot inject the Leader binding and endpoint; do not replace an existing Team or Worker.

## Full smoke

### F1: Runtime restart and outbox recovery

- Purpose: prove a crash between Matrix send and PG acknowledgement does not lose or duplicate the logical wake.
- Setup: same as B1, with a disposable Matrix room and an injected consumer fault after send.
- Expected observations:
  - the wake remains pending after the injected interruption;
  - restart claims the same wake and the idempotent Matrix transaction produces at most one logical resume event;
  - final PG state is acked, and the Leader reads the same durable Work facts after restart.
- Required evidence: wake claim/ack facts, Matrix event ID, restart timestamps, Leader resume source event, and cleanup proof.
- Blocked rules: never treat model prose, a successful HTTP transport response, or a Web UI label as proof of the Work transition.

## Maintenance notes

Run deterministic app/Worker tests before Basic smoke. Keep model/provider and AgentTeams version explicit in every run; never silently switch them to make readiness pass.

## Phase C production boundary

Run `make test-phase-c-contract` before any real resource is touched. The
explicit `make phase-c-real` entrypoint owns a unique disposable Team, PG,
Coordination runtime, binding volume, and Worker set; it must prove the
Leader binding verifier, role/runtime injection, native Leader resume,
Task/Result/ToolResult delivery, WebUI/Matrix projections, restart recovery,
and exact cleanup. A provider/catalog rejection or a deployment injection
failure is a No-Go; do not substitute model prose or an HTTP 2xx for the
missing machine fact.
