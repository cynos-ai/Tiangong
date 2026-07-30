# Reviewer v1 release integration run

## Scope

- Branch: `feat/reviewer-integration`
- Levels: Reviewer Basic, Reviewer Full, and existing kernel Full regression
- Durable scenario: `smoke-testing/scenarios/reviewer-runtime.md`
- Provider/model: configured `agentteams-gateway` / `qwen3.5-plus`; no override permitted
- Channel: released official AgentTeams/OpenClaw Matrix path
- Status: BLOCKED — Reviewer Basic and kernel Full passed; Reviewer Full did not complete the required real-model tool sequence

## Preconditions

1. Reviewer deterministic tests, observability contract, Skills, shell syntax, and image/profile checks pass.
2. `make verify` passes for the pinned local AgentTeams stack.
3. Reserved Workers/containers are absent before each run; the runner refuses replacement.
4. No repository-external fixture, package, service, or private material is used.
5. Basic passes before Full; existing kernel Full runs after Reviewer smoke to detect Gate/approval/recovery regression.

## Owned resources

Reviewer runs own only:

- Worker `tiangong-reviewer-smoke` and container `agentteams-worker-tiangong-reviewer-smoke`;
- MinIO prefix `agentteams/agentteams-storage/agents/tiangong-reviewer-smoke/`;
- Controller and Manager mirrors `/root/hiclaw-fs/agents/tiangong-reviewer-smoke`;
- Manager helpers `/tmp/tiangong-reviewer-smoke-worker.yaml` and `/tmp/tiangong-matrix-reviewer-roundtrip.sh`;
- Worker helper `/tmp/tiangong-reviewer-state-oracle.mjs` and nonce-bound fixture files inside the temporary Worker workspace.

The kernel regression separately owns only its existing reserved `tiangong-pi-smoke` resources. Built local image tags are developer artifacts, not disposable external resources.

## Execution order

```text
make check-skills
npm --prefix worker test
npm --prefix worker run check-observability
bash -n changed smoke scripts
make test-reviewer-smoke-contract
make build-worker-image
make verify
make test-reviewer-image-basic
make test-reviewer-image
make test-worker-image
```

Each integration command must finish cleanup before the next starts.

## Required machine observations

### Reviewer Basic

- actual Reviewer image ID and fixed profile digest;
- exact five-tool profile/materialized surface;
- Matrix request and delivered response event IDs;
- one validated run, one complete read with independently matching digest, one completion;
- terminal worker-local static-only status;
- no write/bash Evidence;
- `reviewer_cleanup=pass`.

### Reviewer Full

- one run ID and unchanged objective/criteria digests;
- one append-only scope event A → A+B;
- Matrix transaction retry resolves to the same request event;
- current journal reaches the owned remote prefix before restart;
- derived snapshot deletion plus restart leaves the verified PracticeRun journal unchanged and rebuilds the same active A+B state before the post-restart turn;
- a post-restart B-only read turn leaves the same run active with complete A+B Evidence, followed by a separate completion-only turn;
- complete A/B read Evidence and final-scope claim/checkpoint binding;
- exactly one completion and terminal machine status;
- `reviewer_cleanup=pass`.

### Kernel regression

- real read, pending write, restart, requester approval, one execution, one replay, payload erasure;
- exact Worker/container/mirror/storage cleanup.

## Failure discipline

- First failure: classify product, environment/model, readiness, scenario, driver/oracle, or cleanup and state one testable hypothesis.
- A second failure of the same class requires lower-layer evidence or a deterministic regression before another Full run.
- Do not change model/provider, broaden scope, weaken state/Evidence counts, infer execution from prose, or bypass official OpenClaw.
- Always perform exact cleanup. Cleanup residue keeps the run failed.

## Result

### Reviewer Basic — PASS

A fresh run on `agentteams-gateway/qwen3.5-plus` passed the official Matrix path and exact cleanup.

- image ID: `sha256:2a5f6d330ed9671162212417fb6e763c58e9b29dbaaffd23a4fbccba56832d9b`
- profile digest: `636a466beb58788da2786d1eabcad4a8479006b4f2e6df46fb1b648bc1ceeaf7`
- Matrix request/response: `$lB0f-wgQYu6SzqUFz5yLvNoVRS_BHdTAqDZ3YqhZzV0` / `$vp2DOe9KXwj91Htud6N5kHCweCcURTtMCS40keWGnjU`
- run: `run-b0e7fc62-e57a-46b1-a5ac-0d5c8290d14e`, revision 2, one `run.started`, one complete read, one `run.completed`
- fixture and selected read digest matched; protected claim scope digest matched final scope digest
- terminal Matrix status was worker-local, done, checkpoint passed, static-review-only
- Harness passed; no write/edit/bash Evidence; `reviewer_cleanup=pass`

The first Basic attempt reached the same product terminal state but failed an invalid test-driver assertion against a nonexistent projection field. The oracle was corrected without changing product behavior or the smoke scope before the passing fresh run.

### Reviewer Full — BLOCKED

The durable driver proved these boundaries in fresh runs:

- start A and complete A read through Matrix;
- a later Matrix turn appended only B to the same run;
- objective and criterion digests remained unchanged;
- duplicate Matrix transaction PUTs resolved to one request event;
- the latest PracticeRun journal reached the exact owned MinIO prefix before restart;
- deletion of the derived snapshot followed by restart rebuilt a valid snapshot from the unchanged journal;
- the same run ID and active A+B scope recovered after official Matrix readiness;
- every failed attempt ended with `reviewer_cleanup=pass`.

Early failures were test-driver/scenario defects: an active-scope oracle incorrectly required B before the post-restart read; restart occurred before the current journal reached remote storage; and transcript/snapshot timing assertions overfit AgentTeams synchronization and runtime rebuild timing. Each was corrected only after lower-layer policy, source, or snapshot-rebuild evidence, without weakening run/scope/Evidence/cleanup assertions.

After those corrections, two independent fresh runs failed the required model-controlled tool sequence:

1. the combined post-restart turn executed the second complete read but emitted no `check_completion` proposal; sanitized Evidence showed two successful reads, one scope extension, no completion state event, and active/not-run status;
2. after decomposing Full into a B-only read turn followed by a completion-only turn, the B-read response remained active/not-run but the machine oracle found no valid complete B read proof.

These are environment/model or scenario-behavior failures, not proof of a state-machine defect. Failure discipline prohibits further real-model retries without a new lower-layer discriminator or a reviewed product/scenario contract change. Full therefore remains red; no release availability claim is allowed.

### Existing kernel Full regression — PASS

A fresh kernel run passed real Matrix read, pending write, restart, requester approval, exactly one execution, exactly one replay, terminal payload erasure, and exact cleanup. Approval ID was `approval-af0c042e4fabab93583b81bb`; `worker_cleanup=pass`.

### Fresh-AI Reader Test — PASS

A separate no-session, no-tool, no-Skill/extension/context model process received only `docs/design/agent-plane-foundation.md` and consistently answered all eight §22 questions. It preserved the v1 exclusions, exact five-tool/profile boundary, actor and state transitions, append-only scope, `not_addressed` truth table, file-version Evidence proof, `run.completed` authority, claim/state/Evidence/OTel separation, five PRs, smoke machine oracles, and non-waivable block rules. The temporary response was deleted after evaluation and was not committed.

### Promotion decision

**BLOCKED.** Basic, deterministic/container contracts, kernel regression, Reader Test, and cleanup are green. Reviewer Full is not. Keep README and design status at “real Reviewer Full smoke/release gate pending”; do not declare Reviewer v1 publicly available.
