# M9-A0 pinned OpenClaw spike result

## Overall decision

**STOPPED at layer 1.** The pinned source/type/contract inspection completed, but it found blocking contract mismatches. Layers 2–4 were not started, no M9-A runtime implementation was begun, and no OpenClaw upgrade was attempted.

This result is research evidence, not evidence that M9-A is implemented.

## Layer status

| Layer | Status | Reason |
|---|---|---|
| 1. Source/type/contract inspection | **FAIL / stop** | The pinned runtime does not provide the required fail-closed immutable bootstrap and ToolResult capture contract at the inspected boundaries. |
| 2. Container hook runner + fake provider | **BLOCKED** | Required serial gate: layer 1 failed. |
| 3. Deterministic plugin/gateway/session integration | **BLOCKED** | Required serial gate: layer 2 was not started. |
| 4. Basic Matrix turn | **BLOCKED** | Required serial gate: layer 3 was not started; no Matrix fixture was used. |

## Direct machine facts

- Candidate image: `tg-worker:dev`
- Candidate image ID: `sha256:ac1cb183e5b2c82982f6473fef86ccf128763a31192d711526d843a79edb69ff`
- Pinned runtime observation: `OpenClaw 2026.4.14 (2f35b6f)`
- Inspection ran with Docker network disabled.
- Source file sizes and SHA-256 values, hook line references, and current Tiangong registration lines are in [`evidence/source-inspection.txt`](evidence/source-inspection.txt).

## Blocking findings

### 1. `before_prompt_build` is not fail-closed

The typed hook is asynchronous and the hook runner executes it sequentially, but the embedded attempt prompt helper catches a hook error, logs a warning, returns `undefined`, and continues to the model path. A missing hook also produces no result. The final call still reaches `activeSession.prompt(effectivePrompt, ...)`.

This cannot enforce the M9 requirement that a missing, corrupt, or invalid immutable bootstrap prevents any model call.

### 2. Bootstrap input is ordinary mutable context, not an immutable verified boundary

The inspected bootstrap path loads workspace files, applies internal hook overrides, and builds context files. Missing files are represented as `[MISSING] Expected at: ...`; oversized files may be truncated. No digest/checksum validation was found in the inspected bootstrap sources.

The current Tiangong package runtime returns `prependContext`, and the current ToolResult capture writes a local `store.appendSync(record)`. Neither observation proves immutable bootstrap entry into the final system input or control-domain spool closure.

### 3. `tool_result_persist` cannot provide the required awaited control-spool boundary as currently defined

The typed hook and runner are synchronous-only. Promise returns are detected and ignored or handled according to the hook failure policy. The global runner configures `before_tool_call` as fail-closed but does not configure `tool_result_persist`; the default policy expression is fail-open. The transcript guard applies the transform before the local transcript append, but the hook cannot await a trusted control-domain ingest.

Therefore the current source contract does not prove “closed in control domain before result returns to the model”; the current Tiangong implementation only appends a local capture record synchronously.

### 4. No hook-level timeout contract was found for `before_tool_call`

The inspected `runBeforeToolCall` runner block has no timeout/abort enforcement. Approval timeout is a separate path and is not a timeout contract for the admission hook itself. This remains unresolved until a later design revision or a pinned integration path proves the required behavior.

## Cleanup and resource ownership

- No fake provider, fake coordination endpoint, disposable workspace, Worker, Matrix room, or external resource was created.
- Docker inspection containers exited and the temporary copied source directory was removed after evidence generation.
- No credential, token, provider configuration, or raw session transcript was written to the repository.

## Required follow-up

1. Open a design revision issue/PR for the failed pinned contracts, preserving this result and direct evidence.
2. Decide whether the pinned OpenClaw source can support a Tiangong-owned fail-closed wrapper/control boundary without relying on fail-open prompt or synchronous observation hooks.
3. Re-review the revised contract before rerunning layer 1 or starting layers 2–4.
4. Do not begin M9-A implementation until a new spike passes all four layers in order.
