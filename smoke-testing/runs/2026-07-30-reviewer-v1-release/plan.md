# Reviewer v1 release integration run

## Scope

- Branch: `feat/reviewer-integration`
- Hard gates: Reviewer Basic, Reviewer Recovery Full, existing kernel Full, deterministic/container contracts, cleanup
- Non-gating observation: Reviewer Journey canary
- Durable scenario: `smoke-testing/scenarios/reviewer-runtime.md`
- Provider/model: configured `agentteams-gateway` / `qwen3.5-plus`; no silent override
- Channel: released official AgentTeams/OpenClaw Matrix path
- Status: PASS — all revised hard gates passed; Journey canary recorded a safe no-progress outcome

## Decision being verified

The former monolithic Full mixed deterministic recovery safety with probabilistic post-restart model progression. The revised contract does not weaken any machine assertion:

- Recovery Full is the hard release Gate for append-only scope, remote journal durability, snapshot-loss restart, same-run rebuild, unchanged Evidence boundary, and safe active state.
- Journey canary separately observes `read B → check_completion → done`. Only the full terminal oracle is PASS; a non-PASS result is classified and reported without blocking release.
- Cleanup remains hard for every execution.
- Public support promises durable safe recovery and retry, not that every model turn progresses.

This reviewed contract change supplies the new evidence required before another expensive run; it is not a retry for a favorable model sample.

## Preconditions

1. Reviewer deterministic tests, observability, Skills, shell/Node syntax, repository policy, and image/profile checks pass.
2. `make verify` passes.
3. Reserved Workers/containers and owned storage prefixes are absent; runners refuse replacement.
4. No private or repository-external fixture, package, service, or runtime input is used.
5. Basic precedes Recovery Full. Journey runs once on its own fresh Worker. Kernel Full runs independently.

## Owned resources

Reviewer executions own only:

- Worker `tiangong-reviewer-smoke` and container `agentteams-worker-tiangong-reviewer-smoke`;
- `agentteams/agentteams-storage/agents/tiangong-reviewer-smoke/`;
- Controller/Manager mirrors `/root/hiclaw-fs/agents/tiangong-reviewer-smoke`;
- Manager helpers `/tmp/tiangong-reviewer-smoke-worker.yaml` and `/tmp/tiangong-matrix-reviewer-roundtrip.sh`;
- Worker oracle helpers and nonce-bound fixtures under that Worker's workspace.

Kernel Full separately owns only the existing `tiangong-pi-smoke` resources. Local image tags are developer artifacts.

## Execution order

```text
make check-skills
npm --prefix worker test
npm --prefix worker run check-observability
shell/Node/repository checks
make test-reviewer-smoke-contract
make build-worker-image
make verify
make test-reviewer-image-basic
make test-reviewer-image
make test-reviewer-journey-canary   # one declared observation; non-gating
make test-worker-image
fresh-AI Reader Test
independent cleanup absence check
```

Every command completes cleanup before the next. Journey non-PASS does not stop later hard verification, but cleanup failure does.

## Hard machine observations

### Basic

- actual Reviewer image/profile and exact five-tool surface;
- one Matrix request/response, validated run, complete digest-matched read, and completion;
- terminal worker-local static-only status; no mutation Evidence; Harness and cleanup pass.

### Recovery Full

- one run and unchanged actor/profile/objective/criteria facts;
- exactly one append-only A → A+B scope event;
- A has one complete digest-matched read; B is intentionally unread;
- Matrix transaction retry resolves to one request event;
- latest journal reaches the exact remote prefix before restart;
- derived snapshot is absent before restart, then rebuilt from the byte-identical journal;
- PracticeRun and Evidence terminal facts remain unchanged across restart;
- recovered state is the same active/not-run A+B run, with no completion or mutation Evidence;
- official readiness, Harness, and cleanup pass.

### Kernel Full

- real read, pending write, restart, requester approval, one execution, one replay, payload erasure, exact cleanup.

## Journey canary oracle

Run once for this image/provider/model declaration after repeating Recovery Full on a fresh Worker.

- PASS: complete B Evidence with independent digest, original run, one final-scope checkpoint/completion, terminal done/passed Matrix status.
- `NO_VALID_READ_EVIDENCE`: delivered active response but no valid complete B execution.
- `NO_VALID_COMPLETION`: B is valid but no valid final completion.
- `INCONCLUSIVE`: delivery/readiness/adapter result does not permit model-liveness classification.
- Before classifying model behavior, inspect bounded proposal/Gate/start/completion counts to exclude a product/oracle failure.
- No outcome may infer tool execution from model prose. Cleanup is mandatory.

## Failure discipline

- Classify the first failure and form one machine-testable hypothesis.
- A second same-class failure requires lower-level diagnostics before another expensive run.
- Do not switch model/provider, broaden scope, weaken state/Evidence counts, bypass OpenClaw, or sample canary until green.
- Preserve only bounded IDs, digests, counts, status, image/profile facts, and cleanup results.

## Historical evidence before the split

- Reviewer Basic passed on qwen3.5-plus with one start/read/completion and exact cleanup.
- Kernel Full passed read/pending/restart/approval/exactly-once/erasure/cleanup.
- Former Full repeatedly proved start A, append B, remote journal durability, snapshot-loss rebuild, same run/scope, and cleanup.
- Two later qwen attempts did not complete the model-driven suffix: one omitted completion after B read; one produced no valid B read proof.
- These runs motivated, but do not themselves pass, the revised hard Gate.

## Revised result

### Deterministic and environment prerequisites — PASS

- Worker tests: 115/115; observability, Skills, smoke contract, shell/Node syntax, repository policy, design-size, and whitespace checks passed.
- AgentTeams Controller, Manager, Matrix, MinIO, and HTTP readiness passed.

### Reviewer Basic hard gate — PASS

- image: `sha256:a30810cd4f1149c70ee3e69dfe077e15b217b9d50c07019bd4eac79881dd2025`
- profile: `636a466beb58788da2786d1eabcad4a8479006b4f2e6df46fb1b648bc1ceeaf7`
- request/response: `$8U5yywJK-LHTO4vDac2JbJJ5hS6FUhMSPVE88iZmSkU` / `$G2ilwVDP4CRidX1Hy6U5ep68lSwSgPId7jQKRJMeahM`
- run: `run-6f9bfc7e-3dc9-4a7d-8f93-150e94ac486b`, revision 2, one start/read/completion, done/passed, final-scope digest match
- Harness and exact cleanup passed.

### Reviewer Recovery Full hard gate — PASS

One first run passed every recovery machine oracle but exposed an invalid driver assertion: after restart and no new turn, it required the ephemeral last-attempt Harness file to remain `status=pass`. The runner now verifies Harness immediately after the last real pre-restart turn; post-restart authority is official readiness plus journal/state/Evidence. Cleanup passed. This was a driver failure, not a second product attempt.

The fresh corrected run passed:

- image: `sha256:f043b6af6b7b6c91b8e4351ecd2deb96ca7c92712c35e5ce07aa75dfc45a4de5`
- request/response A: `$Kgl2gWTOZH284K4o57DLYjO1W-zdVRrbnSHPGOMgkjM` / `$oVIICNnjvBQIXJRDmo-NcinYsWxOYOVE_7aDV2tBxf8`
- request/response append B: `$9C4m0nVI5U3hWYvlKZ5jnTzcxLIRqBZMSwFHOmmJnnQ` / `$4uLqtzya7WoLtVkrop5PrLZlfpHMqveN8z3BGBXWjCo`
- run: `run-0c4adfca-2da7-4c2f-bc3e-60150b6a089f`; scope revision 2; exactly one start, one A read, one B append, zero checkpoint/completion
- journal reached owned remote storage, remained byte-identical, and rebuilt the deleted snapshot;
- run/profile/objective/criteria and Evidence terminal sequence/hash were unchanged across restart;
- recovered state was the same active/not-run A+B run; Harness and cleanup passed.

### Journey canary — `NO_VALID_READ_EVIDENCE` (non-gating)

The one predeclared qwen3.5-plus run used image `sha256:d6240f86f829b51b920581dcac32b7852bcbe51fe9eea5f169f23a453909e872` and run `run-5d6e7252-bf2d-4268-acbf-f5169175d41a`. Recovery Full passed again. Post-restart request/response were `$JkFsoiE6bP3VDtjXqokoTrh6Y07dBwxYcVFeuQlvLwU` / `$6j40hAMFV8IIbA3YAQzEVe4nVyCkCCZs056vMFx87yk`.

Machine diagnostics showed two successful read lifecycles total and a second `start_work` proposal without Gate/execution. Because A had exactly one valid read before restart and the post-turn projection rejected A for duplicate execution, the model reread A instead of B. There was no valid B Evidence, checkpoint, completion, new run, or false done. State remained the original active A+B run. The canary was not retried; cleanup passed.

### Existing kernel Full hard gate — PASS

Real Matrix read, pending write, restart, requester approval `approval-84e9edf1df2a5b3ec016d87d`, exactly one execution, exactly one replay, payload erasure, Harness, and cleanup passed.

### Fresh-AI Reader Test — PASS

A separate no-session/no-tool/no-Skill/extension/context process received only the public design and correctly distinguished all eight §22 contracts, including hard Recovery Full versus non-gating Journey. Its temporary response was deleted.

### Cleanup — PASS

An independent final check found neither reserved Worker/container, copied helper, mirror, nor owned MinIO prefix for Reviewer or kernel smoke.

### Promotion decision

**PASS under the reviewed release contract.** Deterministic contracts, Reviewer Basic, Recovery Full, kernel regression, and exact cleanup are green. The Journey result is an honestly recorded model-liveness limitation and does not weaken any authorization, state, Evidence, recovery, or terminal PASS assertion.
