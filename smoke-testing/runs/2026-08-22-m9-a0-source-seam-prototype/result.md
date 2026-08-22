# M9-A0 source-seam prototype result

## Overall decision

**Prototype partially passes the lower-level source seam checks, but A0 cannot advance to the real container/fake-provider layer yet.** A disposable patch against pinned OpenClaw `2026.4.14` compiled through focused source tests and demonstrated the intended hook-runner and tool-wrapper behaviors. The actual `runEmbeddedAttempt` harness did not reach any hook/provider event within its timeout; the same existing harness test also times out on the unpatched image, so this is classified as test-driver/image readiness, not as proof of a working provider boundary.

No patch was copied into Tiangong runtime, no OpenClaw version was changed, and no Matrix or external resource was used.

## Prototype status

| Check | Status | Direct fact |
|---|---|---|
| Exact pinned source identity | **PASS** | OpenClaw `2026.4.14 (2f35b6f)`, package license `MIT` |
| Minimal patch applies | **PASS** | 5 source files, `patch --dry-run=pass`, patch SHA-256 recorded |
| Fail-closed model hook runner | **PASS** | 3 custom assertions: block result, thrown error, fake provider count remains zero |
| Tool-result release wrapper | **PASS** | 3 custom assertions: execute → release hook order; capture failure rejects release |
| Handler-owned deadline example | **PASS** | Never-resolving admission returns bounded block |
| Existing OpenClaw focused regressions | **PASS** | 7 files, 54 tests passed in the patched container |
| Actual `runEmbeddedAttempt` provider/session gate | **BLOCKED** | Harness timed out before any hook/provider event; clean unpatched image shows the same timeout |
| Layer 2 real fake-provider path | **NOT STARTED** | Blocked by readiness evidence |

## Candidate patch

The disposable patch adds only the minimum source seams:

- fail-closed `before_model_call`, invoked immediately before the existing `activeSession.prompt(...)` call;
- fail-closed `before_tool_result_release`, invoked by the existing wrapped tool executor after `execute(...)` returns and before ordinary release;
- global failure policies for both new hooks;
- no change to native `before_prompt_build` or `tool_result_persist` semantics.

Patch artifact: [`openclaw-2026.4.14-trusted-boundary.patch`](evidence/openclaw-2026.4.14-trusted-boundary.patch)

- Upstream identity: OpenClaw `2026.4.14 (2f35b6f)`
- Upstream license: MIT
- Patch SHA-256: `ff58803f3497c4aa67f40c32cf72a63508dfb992aa87d037eda8b85146d3723f`
- Patch application dry run: passed

The patch is a research candidate, not an accepted dependency or M9-A implementation.

## Focused evidence

- [`prototype-results.txt`](evidence/prototype-results.txt)
- [`source-seam.test.ts`](evidence/source-seam.test.ts)
- [`model-gate-wiring.test.ts`](evidence/model-gate-wiring.test.ts)
- [`openclaw-2026.4.14-trusted-boundary.patch`](evidence/openclaw-2026.4.14-trusted-boundary.patch)

The patched source tests passed:

- native hook regression set: 3 files / 25 tests;
- source-seam prototype: 1 file / 3 tests;
- tool integration plus attempt imports: 2 files / 116 tests;
- additional attempt bootstrap/context tests: 2 files / 16 tests;
- combined rerun after patch refresh: 7 files / 54 tests.

A full project TypeScript check was attempted but the disposable container ran out of memory; it is not used as pass evidence. Vitest source transformation and the focused test sets passed.

## Readiness blocker

The next step is to repair or replace the actual OpenClaw attempt/fake-provider harness so a clean unpatched baseline and the patched candidate both reach a deterministic provider/session event. Until that direct machine fact exists, do not claim the `before_model_call` seam prevents a real provider request, and do not start the remaining A0 layers.

After readiness is proven, rerun the actual patched container path with:

1. invalid/corrupt bootstrap → zero provider requests;
2. valid bootstrap → fake provider receives exact verified provenance;
3. synthetic tool → spool closure before release;
4. capture failure → recovery-required and no next provider request;
5. pre-tool timeout/throw → tool not executed.

## Cleanup

- The disposable OpenClaw container and temporary source copies are to be removed after evidence is finalized.
- No credentials, provider configuration, private session data, raw transcript, Matrix fixture, or external resource was created.
