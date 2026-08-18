# OpenClaw Worker runtime smoke scenarios

## Ownership

- Related implementation: `worker/agent/`, `worker/plugin/`, and `worker/bin/openclaw`
- AgentTeams owns Worker/Team/Matrix/storage lifecycle; Tiangong owns control hooks, roles, Gates, Evidence, approvals, ToolResult, and recovery state.
- OpenClaw owns model turns and conversations. Tiangong does not ship a model loop, Pi harness, or runtime fallback.
- Update triggers: OpenClaw hook/tool contracts, role registration, Gate/approval parsing, Evidence records, ToolResult capture, state paths, Worker restart behavior, Matrix delivery, or Worker image ownership.

## Basic smoke

### B1: Worker-scoped Matrix-to-OpenClaw response

- Purpose: prove that the pinned Worker image starts OpenClaw, loads `tiangong-control`, joins Matrix, and reaches a bounded Tiangong tool path.
- Target: disposable AgentTeams Worker `tiangong-openclaw-smoke` and its exact storage prefix.
- Expected observations:
  - Node.js is `22.23.2` and the pinned OpenClaw built-in runtime is selected with upstream id `pi`;
  - Matrix reaches one real gated `read` tool call;
  - the matching Evidence chain records one successful read completion;
  - the OpenClaw `ToolResult` store contains bounded metadata only;
  - the temporary Worker and exact storage prefix are removed during cleanup.
- Required evidence: `read_tool_event=pass`, `matrix_to_openclaw_response=pass`, `openclaw_control_plugin=pass`, `openclaw_tool_result_state=pass`, and cleanup proof.
- Skip/block rules: block if Docker, AgentTeams, Gateway, Matrix, or reserved Worker ownership is unavailable. Never replace a real Matrix result with a mocked green result.

## Full smoke

### F1: Pending write, restart recovery, and exactly-once approval

- Purpose: prove Matrix → Gate → persisted pending checkpoint → Worker restart → approval → constrained write → Evidence → replay.
- Target: the same disposable Worker and a random file beneath only that Worker's workspace.
- Required outcomes: pending writes never execute early; approval is bound to the original operation digest; restart preserves the checkpoint; approved content is written once; replay is deterministic; terminal payloads are erased; the exact Worker and storage prefix are cleaned.
- Verification: `make test-worker-image` plus focused recovery tests. Do not infer recovery from model prose.

### F2: Rejection path

- Purpose: prove rejection is persistent, subject-bound, and never invokes the write backend.
- Current status: deterministic rejection coverage is maintained in Worker tests; promotion to the full Matrix smoke remains blocked until the helper gains a rejection phase.

## Deterministic recovery fixtures

- Interrupted writes, retention boundaries, RoleProfile/Skill loading, WorkRun binding, idempotency, Evidence, and rollback are verified by deterministic Worker tests and image-level CLI checks.
- Runtime and maintenance state remain under the independent Worker state root: `WorkRun`, Evidence, idempotency, pending-operation, rollback, and `tool-results/openclaw.json`.
- A missing or stale model/runtime marker is never treated as proof of a completed operation; machine Evidence and ToolResult records are authoritative for those facts.

## Environment sensitivities

- Worker `Running` and `openclaw health` do not alone prove Matrix readiness; wait for the room-join observation after restart.
- Deleting a Worker does not necessarily delete MinIO data; cleanup owns only the exact disposable Worker prefix.
- Model tool-call wording is nondeterministic; Gates, approvals, idempotency, Evidence, and ToolResult assertions remain deterministic.
- DeepSeek Flash is the current release canary. Qwen/Coding Plan remains an explicitly later optional canary and is not part of this release gate.
