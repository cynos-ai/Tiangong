# M9-A0 source-seam prototype

## Scope

- Issue: #116
- Baseline: pinned OpenClaw `2026.4.14` (`2f35b6f`) in the existing Worker image
- Purpose: research-only prototype of the minimum explicit source seams required by the revised M9-A0 contract
- Product boundary: no Tiangong runtime change, no M9-A implementation, no OpenClaw upgrade, and no Matrix run

## Hypothesis under test

The pinned runtime may support a small, explicitly versioned source patch rather than relying on native fail-open hooks:

1. Add a fail-closed `before_model_call` seam immediately before the existing `activeSession.prompt(...)` provider/session call. It receives the final prompt/system context and can prevent the provider request.
2. Add a fail-closed `before_tool_result_release` seam in the actual wrapped tool executor after the tool returns and before the result is released to the agent loop. A Tiangong control handler can synchronously close the bounded ToolResult to control spool; a capture failure marks recovery-required and causes the next model-call seam to block.
3. Keep `before_tool_call` admission bounded by a Tiangong handler-owned deadline/AbortSignal; do not rely on an OpenClaw runner timeout.

These are source-contract prototypes only. The patch must not be called a Tiangong runtime implementation.

## Serial gates

1. Inspect exact source call sites, types, hook registration, failure policy, and testability of the proposed seams.
2. Apply the smallest patch in a disposable copy/container of the pinned source; run focused deterministic tests with fake provider and synthetic tool.
3. Only if the patch proves the required no-provider-request and no-release-on-capture-failure facts may a later deterministic Tiangong integration prototype be considered.
4. Basic Matrix remains out of scope until the first three prototype gates pass and the patch decision is reviewed.

Any failure stops the prototype. No patch is copied into product code or accepted as a version change without exact upstream tag, patch ref/digest, license review, and a separate reviewed decision.

## Required observations

- invalid bootstrap blocks before the fake provider receives a request;
- valid bootstrap reaches the fake provider and exposes exact verified provenance;
- a synthetic tool result is closed before ordinary release;
- capture failure causes recovery-required state and prevents the next provider request;
- pre-tool handler timeout/throw denies the tool;
- native `before_prompt_build` and `tool_result_persist` remain negative/observation facts.

## Evidence and cleanup

- Use only a disposable Docker container derived from the existing pinned image and a temporary source copy outside the repository.
- Disable external network for all prototype commands.
- Preserve only bounded source diff, test output, version/commit identity, event ordering, and sanitized error codes.
- Remove the temporary container/source copy after evidence is written.
- No credentials, raw provider config, private session data, or unrestricted transcript is allowed in evidence.
