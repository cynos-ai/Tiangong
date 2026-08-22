# M9-A0 trusted-boundary rerun result

## Overall decision

**STOPPED at layer 1.** The revised source/type/contract inspection confirmed that the new Trusted boundary names are design contracts only; neither the current Tiangong runtime nor pinned OpenClaw `2026.4.14` exposes a proven implementation seam. Layers 2–4 were not started. No M9-A implementation, OpenClaw upgrade, source patch, Matrix fixture, or external test resource was used.

This result is research evidence, not evidence that M9-A is implemented.

## Layer status

| Layer | Status | Reason |
|---|---|---|
| 1. Source/type/contract inspection | **FAIL / stop** | No verifiable provider-call TrustedModelCallBoundary or tool-result TrustedToolExecutionBoundary exists in the current pinned integration. |
| 2. Container hook runner + fake provider | **BLOCKED** | Required serial gate: layer 1 failed. |
| 3. Deterministic integration | **BLOCKED** | Required serial gate: layer 2 was not started. |
| 4. Basic Matrix turn | **BLOCKED** | Required serial gate: layer 3 was not started; no Matrix fixture was used. |

## Direct machine facts

- Baseline: `develop` commit `1c1534f`
- Candidate image: `tg-worker:dev`
- Candidate image ID: `sha256:ac1cb183e5b2c82982f6473fef86ccf128763a31192d711526d843a79edb69ff`
- Pinned runtime observation: `OpenClaw 2026.4.14 (2f35b6f)`
- Inspection ran with Docker network disabled.
- Bounded source paths, line references, and current Tiangong symbol/capture searches are in [`evidence/source-inspection.txt`](evidence/source-inspection.txt).

## Blocking findings

### 1. No trusted model-call seam is available

The pinned source contains the provider/session call at `activeSession.prompt(effectivePrompt, ...)`, but no `TrustedModelCallBoundary` symbol or plugin contract. The available `before_prompt_build` path logs an error, returns `undefined`, and continues to the model path. `before_model_resolve` has no block result field. The current Tiangong runtime has no implementation of the revised boundary.

Therefore missing, corrupt, or digest-mismatched Package bootstrap cannot yet be proven to prevent the provider request without a source patch or another explicitly reviewed pre-provider integration seam.

### 2. No trusted tool-result release seam is available

The pinned source contains a candidate `wrapToolWithBeforeToolCallHook` for pre-tool admission, but no `TrustedToolExecutionBoundary` contract or implementation. The current Tiangong plugin still registers native `tool_result_persist`, and the capture store still uses local `store.appendSync(record)`; no current path proves that every allowed tool executor is wrapped and that capture failure aborts the model turn rather than becoming a normal result.

The native `tool_result_persist` hook remains synchronous-only and default fail-open. It cannot be promoted to the revised trusted boundary.

### 3. No native hook-level timeout is available

The inspected `before_tool_call` runner block has no timeout/abort enforcement. A Tiangong handler-owned deadline remains a required future implementation seam, not a fact of the current runtime.

## Cleanup and resource ownership

- No fake provider, fake coordination endpoint, disposable workspace, Worker, Matrix room, or external resource was created.
- Docker inspection containers exited.
- No credential, token, provider configuration, private session material, or raw Matrix transcript was written to the repository.

## Required follow-up

1. Create an explicit source-patch or OpenClaw integration decision for the provider-call and tool-result release seams, recording exact pinned upstream tag, patch ref/digest, license, and direct source evidence.
2. Implement or prototype only the minimum trusted seam in a separately reviewed spike branch; do not call it M9-A implementation until the four-layer spike passes.
3. Re-run layer 1 after the seam decision/prototype is reviewable. If it passes, continue strictly to layers 2–4.
4. Keep M9-A formal implementation blocked until all four layers pass.
