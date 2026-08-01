# Reviewer v2 directory activation integration run

## Scope

- Branch: `feat/36-reviewer-directory-targets`
- Contract: `docs/design/reviewer-typed-targets.md` and `docs/design/reviewer-directory-inspection.md`
- Scenarios: Reviewer directory Basic and append-only Recovery Full
- Hard gates: deterministic v2 contracts, fixed image/profile/kind/tool identity, official Matrix delivery, journal/Artifact/Evidence oracle, restart reconstruction, Harness, and exact cleanup
- Unchanged assurance: `worker-local / static-review-only`
- Status: PASS

## Declared environment and ownership

- Provider/model: configured `agentteams-gateway` / `qwen3.5-plus`; no override or retry sampling
- Image: locally built `tiangong-worker-reviewer:dev`
- Reserved Worker/container: `tiangong-reviewer-smoke` / `agentteams-worker-tiangong-reviewer-smoke`
- Owned storage: `agentteams/agentteams-storage/agents/tiangong-reviewer-smoke/` and matching Controller/Manager mirrors only
- Fixtures: nonce-owned workspace directories with two selected UTF-8 members and one explicitly excluded member
- Cleanup rule: every run deletes only the reserved Worker and exact owned prefix, then proves Worker/container/mirrors/helpers/storage absent

## Preconditions and execution

```text
npm --prefix worker test
make test-reviewer-smoke-contract
./scripts/check-repository.sh
make check-skills
make verify
./scripts/build-worker-image.sh
make test-reviewer-image-basic
make test-reviewer-image
```

No Kernel Full was run: Reviewer v2 changes the Reviewer-owned read/state wrapper path but does not alter kernel write approval, execution, rollback, reconciliation, or external-side-effect behavior. The generic wrapper remained covered by deterministic Worker tests.

## Required machine facts

| Boundary | Required pass fact | Blocking fact |
|---|---|---|
| profile | schema v2; kinds `file,directory_snapshot`; exact six tools | v1/mixed schema or extra capability |
| admission | one runtime target ID and journal-bound canonical manifest per directory | live path authority, missing/tampered manifest, or excluded member selected |
| inspection | one bounded list and literal search Artifact/Evidence join | query/prefix/ref/content in Evidence or inspection counted as coverage |
| consume | every selected member has complete target/snapshot/digest-bound read Evidence | path-based read, changed source, wrong digest, or missing member |
| completion | protected claim uses final ordered target IDs and checkpoint binds final scope digest | prose-only completion or mismatched scope |
| recovery | append-only A→B, unchanged journal/Evidence across restart, snapshot rebuilt from journal, manifests read from Store | target replacement, live recapture, or snapshot authority |
| cleanup | reserved Worker/container/prefix/mirrors/helpers absent | any owned residue |

## Attempt discipline and regressions found

1. The first Basic attempt timed out after only `start_work` completed. Cleanup passed. The initial hypothesis was that the expanded six-call Basic exceeded the old Matrix polling window.
2. After increasing only the bounded polling window and adding sanitized failure diagnostics, a second attempt again stopped after `start_work`; Harness remained `running`, with exactly one successful start lifecycle and no later tool proposal. This disproved timeout-only diagnosis.
3. Lower-level inspection showed the state-transition content exposed only a target count; runtime target IDs existed only in UI details and were not model-visible in the same turn. The product result was corrected to return bounded `{targetId,kind}` refs without descriptor, snapshot, digest, or Artifact data, and a deterministic regression assertion was added.
4. The next Basic reached done/passed but the smoke oracle compared JSON object insertion order for the normalized selection. This was a test-driver defect; the oracle was corrected to compare the two arrays independently. Product state and cleanup remained valid.
5. The declared Basic and Recovery Full then passed. After additional deterministic replay/producer hardening, the final-image Basic passed again. The first final-image Recovery attempt observed an Evidence boundary change across restart; cleanup passed. The runner had waited for remote journal durability but not remote Evidence durability.
6. The recovery readiness contract was corrected to wait for the exact owned Evidence object digest as well as the journal before restart, with bounded sanitized mismatch diagnostics. The next final-image Recovery Full passed without weakening the unchanged-boundary oracle.

## Result

### Deterministic and image contracts — PASS

- Worker suite: 128/128 passed at the declared run point.
- Repository policy, Skills, module/shell syntax, smoke oracle contract, and AgentTeams readiness passed.
- Reviewer image materialized schema v2, kinds `file,directory_snapshot`, exact six tools, fixed `flock`, and the closed Artifact producers.

### Directory Basic — PASS

- image: `sha256:f366250bd3c46bcc3b41e2d263e67ebb83afb810e0a588f7d22beed51fe35f73`
- run: `run-d5c31477-266c-4f5b-ba33-b1de61dd91eb`
- target: `target-db58755b-d650-4f36-95c8-24532f8cb18b`
- final state: one target, revision 1, done, checkpoint passed
- evidence: two successful inspections and two complete independently digest-matched member reads; no mutation tool
- final scope/checkpoint digest: `410546485eb4eb90f7a41bf8cdb1c2d5bc8d40a91d843e60d4e2b4a90d793bf1`
- official delivery, duplicate Matrix transaction handling, Harness, machine oracle, and cleanup passed

### Append-only Recovery Full — PASS

- image: `sha256:7bcc5225647619ca6194098da951c62a15f02fb0fe58721a67d406d0fa8cb2cb`
- original run: `run-50814e2b-aa1c-4286-8626-34cfd50a1525`
- ordered targets: `target-afd8b734-38c7-40c8-ba95-7908ac4748c7`, then `target-b4dbc351-7f47-421a-bb19-eca2e838e44c`
- one `scope.revised` produced final scope revision 2; A had exactly two complete member reads and B remained unread
- exact remote journal and Evidence durability, pre-restart Harness, derived snapshot deletion/rebuild, unchanged journal/Evidence boundary, same target/snapshot identities, Store-backed manifests, machine oracle, and cleanup passed

### Cleanup — PASS

Every attempt reported `reviewer_cleanup=pass`. No result depends on transcript text, model prose, unrestricted logs, raw query/content, raw Artifact ref, or private inputs.

## Promotion decision

**PASS.** Reviewer v2 `file` and `directory_snapshot` activation is supported by deterministic contracts plus official Matrix Basic and journal-derived Recovery Full. This does not promote the assurance beyond Worker-local static review and does not claim git, remote PR, test execution, workspace mutation, Team verification, or model-liveness guarantees.
