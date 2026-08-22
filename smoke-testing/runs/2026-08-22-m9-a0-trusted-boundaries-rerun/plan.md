# M9-A0 trusted-boundary rerun

## Scope

- Issue: #114
- Previous run: #110 / result PR #111, stopped at source/contract inspection
- Design revision: merged PR #113, baseline `develop` commit `1c1534f`
- Component under test: pinned OpenClaw `2026.4.14` and the Tiangong control/plugin integration
- Run type: focused research/integration spike; the final layer is one Basic Matrix member turn
- Product boundary: this run does not implement or enable M9-A and does not authorize an OpenClaw upgrade

## Revised trusted boundaries

- `TrustedModelCallBoundary` is the Tiangong control pre-model boundary. It verifies Package/bootstrap/authority/session identity and the exact bootstrap digest before the provider request. It is not a model runtime.
- `TrustedToolExecutionBoundary` wraps each allowed top-level tool executor and synchronously closes a bounded ToolResult to the control spool before releasing an ordinary result to OpenClaw.
- Native `before_prompt_build` and `tool_result_persist` are observation/transform paths only. Native fail-open or synchronous-only behavior cannot count as a trusted pass.
- The pre-tool admission handler owns a hard deadline/AbortSignal. Timeout, abort, throw, crash, or malformed output must deny/block without relying on an OpenClaw runner timeout.

## Ownership and resources

- OpenClaw owns the pinned hook registry, runner, provider/session path, and official Matrix Channel Plane.
- Tiangong owns the two trusted control boundaries, admission decisions, bootstrap contract, ToolResult capture contract, and sanitized report.
- Fake provider, fake coordination endpoint, synthetic tool, disposable workspace, and any final reserved Matrix fixture are test-only resources owned by this run.
- No production Work, Task, room, repository, credential, or unrestricted transcript is in scope.

## Provider and target identity

- Layers 1–3: deterministic fake provider, no external model provider, no external network.
- Layer 4: one reserved safe member fixture on the official Channel Plane. Record its exact owned identity and turn correlation in `result.md` before execution.
- Provider/model overrides are recorded; none may be changed silently.

## Prerequisites

- Repository is based on the merged design revision at `1c1534f`.
- Candidate Worker image reports OpenClaw `2026.4.14` before layer 1 evidence is accepted.
- Docker, Node, repository deterministic checks, and the local AgentTeams/Matrix stack are used only by the layer that requires them.
- If a source patch is required, record the exact pinned upstream tag, patch ref/digest, license, and source inspection before proceeding; an unreviewed patch or upgrade is a stop.

## Serial gates

The next layer may start only after the previous layer passes with direct machine evidence:

1. **Source/type/contract inspection** — inspect native hooks, model provider seam, tool executor seam, `TrustedModelCallBoundary`, `TrustedToolExecutionBoundary`, and handler-owned deadline. Stop if any trusted seam cannot be located and proven.
2. **Container hook runner + fake provider** — use the actual built image with network disabled. Prove missing/corrupt/digest-mismatched bootstrap causes no provider request; handler timeout/throw blocks synthetic tool execution; ToolResult spool closure precedes ordinary result release; capture failure aborts or enters recovery-required without an ordinary ToolResult or next provider request.
3. **Deterministic integration** — use the real Tiangong plugin and OpenClaw gateway/session path with fake provider, fake coordination, synthetic Task and Work-Leader admission, runtime binding/claim fixtures, Trusted boundaries, and disposable workspace.
4. **Basic Matrix turn** — use the official Channel Plane once to confirm the already-proven path only. It cannot prove authorization, concurrency, atomicity, or recovery.

No later layer starts after a failure. If a premise fails, preserve sanitized evidence, stop, and open or update a design/source-patch decision before implementation.

## Required observations

- Final provider request contains the exact immutable bootstrap/system context and its verified provenance.
- Missing, corrupt, or digest-mismatched bootstrap produces no provider request.
- Pre-tool timeout/throw/abort denies the synthetic tool before execution.
- Tool execution result is synchronously closed to control spool before ordinary release; capture failure cannot become an ordinary ToolResult or permit the next provider request.
- Native hook order, replay, truncation, and transcript behavior remain separate observations.
- Model/provider claims, hook outcomes, persistent ToolResults, and Matrix delivery remain separate facts.

## Evidence and cleanup

- Store bounded evidence under this run directory with pinned versions, source paths/line ranges, stable fixture IDs, event ordering, exit codes, and sanitized error codes.
- Do not store credentials, tokens, provider configuration, private session material, raw Matrix transcripts, unrestricted prompts, or unrestricted logs.
- Record exact resources created by the run. Clean only those resources and verify absence after every started layer.
- Cleanup failure keeps the run red.

## Deliverables

- `plan.md` before execution.
- `result.md` with per-layer pass/fail/blocked status, direct facts, limitations, and integration decision.
- Bounded evidence files referenced by `result.md`.

## Decision rule

A passing rerun selects the actual integration seams for a later M9-A implementation PR; it does not itself enable M9-A. A failed or inconclusive premise requires design/source-patch review before any later layer or implementation. No Prompt, Skill, Gate, manual process, or native observation hook may substitute for a missing trusted boundary.
