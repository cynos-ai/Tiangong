# Agent runtime smoke scenarios

## Ownership

- Related implementation: `worker/agent/`, `worker/plugin/openclaw-adapter.mjs`
- Related skill: none; this is a cross-cutting runtime scenario
- Related checkpoints/evidence: persistent pi session, `EvidenceRecorder` hash chain, Gate decision, approval checkpoint, idempotency record, cleanup proof
- Update triggers: changes to OpenClaw Harness DTOs, pi version, tool registration, Gate/approval parsing, Evidence records, session paths, Worker restart behavior, Matrix mention handling, or smoke Worker ownership

## Basic smoke

### B1: Worker-scoped Matrix-to-pi response

- Purpose: Prove that the pinned Worker image can use its generated Gateway credential and that official OpenClaw Matrix delivery reaches the Tiangong runtime.
- Target project: reserved temporary AgentTeams Worker `tiangong-pi-smoke`.
- Setup: local AgentTeams readiness passes; build `tiangong-worker:dev`; remove stale storage owned by the reserved smoke Worker.
- Prompt: send a mentioned Matrix message requesting one exact random nonce response.
- Expected observations:
  - Node.js is `22.23.1` and pi is `0.82.0`;
  - Matrix drives one real gated pi `read` against a disposable fixture;
  - Matrix returns the exact random nonce through the Tiangong Harness;
  - the matching Evidence chain records one successful read completion;
  - one persistent pi session exists;
  - temporary model configuration and persistent session do not contain the Worker Gateway credential.
- Required evidence: `read_tool_event=pass`, `matrix_to_pi_response=pass`, `pi_harness_selection=pass`, `persistent_pi_session=pass`, `runtime_credentials_in_memory=pass`.
- Skip/block rules: block if Docker, the pinned AgentTeams stack, Gateway model, Matrix, or reserved Worker ownership is unavailable. Never replace the real Matrix result with a mocked green result.

## Full smoke

### F1: Pending write, restart recovery, and exactly-once approval

- Purpose: Prove the complete Matrix → Gate → persisted pending checkpoint → restart → approval → constrained write → Evidence path.
- Target project: reserved temporary AgentTeams Worker `tiangong-pi-smoke`; a random file beneath only that Worker's workspace.
- Setup: complete B1, then generate a unique target and content nonce.
- Prompt:
  1. request exactly one `write` tool call;
  2. wait for the code-generated approval summary;
  3. restart the Worker before approval;
  4. send the exact `APPROVE <approval-id>` command;
  5. replay the same approval command.
- Expected observations:
  - target does not exist while Gate is pending;
  - approval summary contains machine-derived tool, target, operation digest, content digest, and exact commands, but not write content;
  - Matrix channel readiness is re-established after restart before sending approval;
  - approved file content equals the nonce;
  - replay returns the deterministic replay message;
  - the Evidence chain associated with that approval contains one `tool.execution.started` and one `tool.execution.replayed`;
  - temporary Worker and its exact MinIO prefix are removed.
- Required evidence: pending/approve/replay Matrix event IDs, file-content check, approval-specific Evidence path, execution/replay counts, Worker absence, and empty reserved MinIO prefix.
- Skip/block rules: block rather than approve if the sender identity, operation digest, original tool call, persistent checkpoint, or Matrix readiness cannot be verified. Never inspect or delete storage outside the exact reserved Worker prefix.

### F2: Rejection path

- Purpose: Prove that rejection is persistent, subject-bound, and never invokes the write backend.
- Target project: the same reserved smoke Worker with a second unique target.
- Setup: produce a pending write without reusing F1's approval identifier.
- Prompt: send exact `REJECT <approval-id>`, then replay the rejection.
- Expected observations: deterministic rejection response; no target file; state remains rejected across restart; no execution-start event for the rejected tool call.
- Required evidence: `approval.rejected`, rejected idempotency state, absent target, zero matching execution-start records.
- Skip/block rules: currently blocked until the automated full-smoke helper gains a rejection phase. Do not infer rejection coverage from the approval test.

## Maintenance notes

- **Current status (2026-07-25)**: F1's restart-recovery step fails because approval execution cannot relocate the original write tool call in the reopened pi transcript (`findToolArguments` throws). There is no deterministic test covering that path; the unit test bypasses it by passing params directly. Do not mark F1 green until a Tiangong-owned pending-operation store replaces transcript recovery and a deterministic cross-reopen recovery test exists. Basic smoke remains the proven release path.
- Promotion candidates from past runs: sender mismatch, operation mutation after approval, executing-state reconciliation, and Evidence tamper detection may move into Full once their runtime contracts stabilize.
- Known environment sensitivities:
  - Worker `Running` and `openclaw health` do not alone prove Matrix sync readiness; wait for the room join observation after restart.
  - deleting a Worker does not necessarily delete its MinIO data; the smoke owns and purges only `agents/tiangong-pi-smoke/`.
  - model tool-call phrasing is nondeterministic; Gate, approval, idempotency, and Evidence assertions must remain deterministic.
  - `deepseek-chat` or another fast model may review or cross-check scenarios, but it does not replace the pinned real-model smoke required for the release path.
