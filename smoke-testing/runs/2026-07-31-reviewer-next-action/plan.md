# Reviewer nextAction focused integration run

## Scope

- Branch: `feat/reviewer-next-action`
- Contract: `docs/design/reviewer-next-action.md`
- Scenario: `smoke-testing/scenarios/reviewer-runtime.md`
- Hard gates: deterministic nextAction/coverage contracts, Reviewer Basic, official delivery, Harness, and exact cleanup
- Non-gating observation: one Reviewer Journey canary after recovered A+B state
- Unchanged boundary: no new tool, Gate, approval, mutation, state root, idempotency, or assurance behavior
- Status: PASS — deterministic, image/profile, Reviewer Basic, readiness, and exact cleanup hard gates passed; the one declared Journey canary was safely classified `NO_VALID_READ_EVIDENCE`

## Declared environment

- Provider/model: configured `agentteams-gateway` / configured default model; no silent override
- Channel: official AgentTeams/OpenClaw Matrix path
- Image: locally built `tiangong-worker-reviewer:dev` from the current branch
- Reserved identity: `tiangong-reviewer-smoke`
- Timeout and retry behavior: current checked-in smoke runner defaults; no ad hoc extension or sampling

## Preconditions

1. `npm --prefix worker test` passes, including ContextPack v2, shared read coverage, fail-closed Evidence, checkpoint regression, and restart reconstruction.
2. Observability, repository policy, Skills, smoke oracle contract, syntax, and image/profile checks pass.
3. `make verify` confirms Controller, Manager, Matrix, storage, and HTTP readiness.
4. The reserved Worker/container, copied helpers, mirrors, and owned storage prefix are absent; the runner must refuse replacement.
5. No private fixture, package, image, service, transcript, or repository-external runtime input is used.

## Owned resources

This run may create and clean only:

- Worker `tiangong-reviewer-smoke`;
- container `agentteams-worker-tiangong-reviewer-smoke`;
- storage prefix `agentteams/agentteams-storage/agents/tiangong-reviewer-smoke/`;
- Controller/Manager mirrors for `tiangong-reviewer-smoke`;
- runner-owned copied helpers and nonce-bound workspace fixtures documented by the existing Reviewer runner.

Local image tags are developer artifacts, not external resources. Cleanup must verify every listed Worker/container/helper/mirror/storage target is absent.

## Execution order

```text
npm --prefix worker test
npm --prefix worker run check-observability
./scripts/check-repository.sh
make check-skills
node ./scripts/test-reviewer-smoke-oracle.mjs
make build-worker-image
make verify
make test-reviewer-image-basic
make test-reviewer-journey-canary   # exactly once; no sampling until green
```

Do not run Kernel Full unless a new fact shows that this change touched wrapper, Gate, approval, idempotency, external side-effect, or recovery authority.

## Deterministic hard facts

The unit/contract layer must prove:

- ContextPack exact schema is version 2;
- no active run derives `NONE` without scanning run-bound Evidence;
- A complete + B unread derives `READ_REMAINING_SCOPE`, `scope-file-2`, and `SCOPE_READ_INCOMPLETE`;
- partial and latest mixed-version coverage remain incomplete;
- latest complete version satisfies coverage despite older incomplete reads;
- read gaps take priority over a previous failed checkpoint;
- all files complete after a failed checkpoint derives `ADDRESS_CHECKPOINT_FAILURE`;
- all files complete without a failed checkpoint derives `CHECK_COMPLETION`;
- checkpoint and nextAction consume one practice-owned coverage implementation without changing checkpoint outcomes or selected refs;
- Evidence tamper/ambiguity and successful Reviewer mutation fail before ContextPack delivery;
- durable journal/Evidence reconstruction produces the same nextAction after restart;
- Reviewer tool surface, Gate, status, completion, report, assurance, and state roots remain unchanged.

Raw ContextPack, paths, objective, criteria, claims, or transcript are not smoke evidence.

## Reviewer Basic hard gate

Required observations:

- actual image/profile and exact five-tool surface remain Reviewer values;
- official Matrix request and response complete one bounded static review;
- valid run/read/completion Evidence binds one run and independently matched fixture digest;
- machine status remains `worker-local / done / checkpoint passed / static-review-only`;
- no write/edit/bash execution appears;
- Harness passes;
- exact cleanup passes.

Basic blocks promotion if any machine fact, official delivery, or cleanup cannot be proven. Assistant prose is not the oracle.

## Journey canary observation

Use the checked-in Journey flow once on a fresh Worker:

```text
start/read A → append B → persist journal → delete derived snapshot
→ restart/rebuild same active A+B run → one post-restart continuation
```

Deterministic tests already prove that the recovered state derives `READ_REMAINING_SCOPE` for `scope-file-2`; the canary must not inspect or persist the raw ContextPack.

Classification remains:

- PASS: complete independently matched B read, original run, one valid final-scope completion, delivered done/passed status;
- `NO_VALID_READ_EVIDENCE`: safe delivered turn without complete valid B Evidence;
- `NO_VALID_COMPLETION`: complete valid B Evidence without valid final completion;
- `INCONCLUSIVE`: readiness/delivery/adapter facts do not permit a model-liveness classification.

A non-PASS model-liveness classification does not fail this extension if deterministic guidance, product boundaries, Harness, and cleanup remain valid. Product/oracle failure or cleanup residue remains blocking. Do not rerun for a favorable sample.

## Failure discipline

- First failure: classify product, adapter/host, environment/model, scenario, driver/oracle, readiness, or cleanup and form one machine-testable hypothesis.
- A second same-class failure requires lower-level diagnostics before another expensive run.
- Do not change model/provider, prompt, fixture, timeout, assertions, or resource identity during the declared run.
- Preserve only bounded image/profile IDs, Matrix IDs, run IDs, digests, counts, stable error codes, Harness status, and cleanup facts.
- Never use unrestricted logs, raw ContextPack, raw prompts, claims, external provider payloads, or transcript text as an execution oracle.

## Result

### Deterministic and environment prerequisites — PASS

- Worker tests: 122/122 passed.
- Observability, repository policy, Skills, smoke oracle contract, syntax, and whitespace checks passed.
- Both local Worker images built; Reviewer profile remained runtime-ready with the exact five-tool surface.
- `make verify` passed Controller, Manager, Element, Console, Matrix, MinIO, and Manager readiness.
- No Kernel Full was run because this slice did not change wrapper, Gate, approval, idempotency, external side-effect, state-root, or reconciliation authority.

### Reviewer Basic hard gate — PASS

- image: `sha256:8b5e49c01cd35715b0cb5196209649e6ffddcae4100a1aa431e2cc55e1440696`
- profile: `636a466beb58788da2786d1eabcad4a8479006b4f2e6df46fb1b648bc1ceeaf7`
- request/response: `$5ydNfeTP9rvNBiy2czJN3yPoOnAZ26eUdUG6B7HCkvY` / `$Ef0yU25QtbiZDl9J5LN8dMoZvoiMarVRxrbC4F1Me4A`
- run: `run-ced3f2a9-ca36-4d07-b433-1e712531b9d1`; revision 2; one start/read/completion; independently matched fixture digest; done/passed static-only status
- duplicate Matrix transaction handling, official delivery, Harness, machine oracle, and exact cleanup passed.

### Journey canary — `NO_VALID_READ_EVIDENCE` (non-gating)

The one predeclared run used image `sha256:16160d42bff7e566b8ea0249b36958040b2624becd4e43f336c44ce91d303997` and original run `run-87d0fd9e-7721-4d9c-95a2-bf8bc0cf5f95`.

- start request/response: `$QuxnuZY0mG16eX1yv7re7gNBiArRFnQYxB0wP0MQXpU` / `$OOWVvgdukQMZXjDpM9E4N7Fltv39QWqPAiIakkZPgfY`
- append-B request/response: `$Yd5GIgnLsJdEXn95KnEEXscCxffgIDpVc1KKLejbCeg` / `$_i4NKaYhnpm4I7c3MePmF0WvPiHnOzxPdcLLKIVrcOg`
- continuation request/response: `$39MzKjFRfZdCMM908HtX_gQpUEaOxewAqewIEk4ulKQ` / `$XDsmvcMMT_eB6oejc8QFRXc1OiUXW2JMYeNHM90Ww6c`
- A was read completely before restart; exactly one append-only scope event added B; the journal reached owned remote storage; deleted snapshot reconstruction and same-run recovery passed.
- deterministic tests proved the recovered A+B state derives `READ_REMAINING_SCOPE` for `scope-file-2`; the raw ContextPack was not captured or used as a smoke oracle.
- bounded post-turn diagnostics showed two successful read lifecycles total, `readCountA=2`, `readCountB=0`, no checkpoint, no completion, and a second `start_work` proposal without Gate/execution. The model reread A instead of B.
- official continuation delivery and active machine status passed. The bounded failure snapshot showed the ephemeral Harness file still at `status=running`; this run therefore makes no separate post-turn Harness-pass claim. Basic Harness and the pre-restart Recovery Harness check passed.
- no false B Evidence, new run, checkpoint, completion, or mutation appeared. The original run stayed active.
- The canary was not retried or sampled until green.

### Cleanup — PASS

Both runner cleanups reported `reviewer_cleanup=pass`. An independent final check found no reserved Worker/container, Manager helper, Controller/Manager mirror, or owned storage object for `tiangong-reviewer-smoke`.

### Promotion decision

**PASS under the reviewed contract.** Machine-derived guidance, fail-closed Evidence projection, shared checkpoint coverage, restart reconstruction, image/profile materialization, Reviewer Basic, and cleanup are proven. The single model-liveness observation remained safe no-progress and does not weaken authorization, Evidence, state, or completion guarantees. No claim is made that `nextAction` guarantees model progress.
