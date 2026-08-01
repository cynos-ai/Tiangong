# Reviewer v2 local-Git activation integration run

## Scope

Focused Basic proof for the public [`reviewer-local-git-targets`](../../../docs/design/reviewer-local-git-targets.md) contract. The run exercises one pinned `commit` target and one direct `git_diff` target through the official Matrix/OpenClaw/Reviewer image path. It does not claim remote or pull-request freshness, commit authorship/signature trust, test execution, workspace mutation, or model correctness.

## Ownership and resources

- Command: `make test-reviewer-image-git`
- Reserved Worker: `tiangong-reviewer-smoke`
- Owned storage prefix: `agents/tiangong-reviewer-smoke/`
- Image: `tiangong-worker-reviewer:dev`
- Fixture: one nonce-owned ordinary non-bare repository under the Worker workspace, plus an expected-patch file and an external-diff sentinel helper in the same owned Worker root.
- Cleanup rule: delete the temporary Worker/container, purge only its owned storage prefix/mirrors, and keep cleanup failure red.

## Assertions

| Boundary | PASS oracle | Blocked result |
|---|---|---|
| image/profile | schema v2; kinds `file,directory_snapshot,commit,git_diff`; exact seven tools; Git 2.43.0 and util-linux 2.39.3 checks | image/profile/runtime mismatch |
| Matrix | idempotent request transaction and official Worker response with `done`, checkpoint passed, two targets | missing or mismatched official delivery |
| target state | ordered `commit` then `git_diff`; exact base/head/commit OIDs; immutable snapshot identities | reordered, refreshed, or unbound targets |
| Store | journal-authorized commit manifest and diff Artifact exact joins | missing, tampered, orphan-only, or cross-target object |
| inspection | one `inspect_repository/list_commit` result with two members and no coverage credit | live Git browsing or inspection-as-coverage |
| consume | two complete commit-member reads plus one complete diff read | missing, truncated, changed, or unauthorized resource |
| completion | ordered target-ID claim, final scope digest, `review-v2` checkpoint pass | model prose or OID used as completion authority |
| privacy | no raw repository path/ref/OID/member path/patch/artifact ref in Evidence | raw Git source fact in Evidence |
| no mutation/execution | pre/post repository byte-state digest equal; configured external helper sentinel absent; no write/edit/bash Evidence | source mutation or helper execution |
| cleanup | Worker/container/storage/mirrors absent | any owned residue |

## Execution record

### Deterministic and image gates

- Worker suite: 146 tests passed before the final Basic run, including SHA-256 packed repositories, loose refs, packed-over-loose ref injection, ancestor symlink races, annotated-tag peeling/depth rejection, unsafe repository layouts, strict byte grammar/BOM, malformed short object framing, duplicate raw tree names, tree-DAG traversal budgets, lock-path hardening, source isolation, durable replay, and Git producer byte validation.
- Repository policy, Skill validation, Reviewer smoke-oracle contract, module syntax, and shell syntax passed.
- Reviewer image ID for the passing Basic run: `sha256:1b348db59e904ba14cf11f80391cba04a3a6e60c71a3baa20bf001ed47cfcfb1`.
- Reviewer profile digest: `fbfb76ec336cc841e39cf42d028aa7f1883dfb5a7e546692da18c85648d928cd`.

### Focused Matrix Basic

- Request event: `$VMrGg7IEJJggsx2jno-6xYRwGxwlboPct8ZuyFEFpqE`
- Response event: `$jYBvl-9ROC_EGwAgAsvbC15QXlfZwOG5yJY3aaJGYpc`
- PracticeRun: `run-1a91935d-969b-47f7-bb7e-8f4e7d095f20`
- Commit target: `target-ef0d4d14-e2d8-483c-925c-01fb1327fc23`
- Diff target: `target-d6d3dea6-6f78-4669-b37a-b7662e7449a7`
- Base commit: `9900c7d38b4435f8a81c8381ed726cbf99e09fcc`
- Head/commit: `9e84e3dc74f766dbfd3232820ae300afd6b61199`
- Commit manifest digest: `164834f4bc7c75cff37989ac5a796de0e38a1ff04ea28f8596c76558373dc4d5`
- Diff digest: `6516c96adbe0a41ef79fa8d3d48ff4f6a05ab9acafef1605d4d7607cc8725ea5`
- Final scope digest: `517fdb8cdc7c2ac420af4ac4b4b33ae3550967e374af2a5a717a83bc6322f96a`
- Evidence terminal sequence/hash: `20` / `40b42e965ed2f6bb7175f699f02714610408ef244279e0025d8da7379686c17a`
- Reads: 3 complete resources.
- Repository inspections: 1 exploration result.
- Harness: pass with the fixed AgentTeams gateway/model contract.
- Repository unchanged: pass.
- External helper not executed: pass.
- Cleanup: pass.

The first focused attempt correctly blocked because the new oracle detected raw Git descriptor facts in state-transition Gate Evidence. The implementation was changed to retain the authoritative full operation in Gate/journal processing while persisting only a code-owned safe operation projection in Evidence. The same unweakened oracle then passed on the final run.

## Recovery limitation

A deeper local-Git recovery attempt subsequently admitted/read a commit target, appended a diff target, proved the pre-restart journal/Evidence/Store state, removed the derived snapshot and fixture `.git`, and restarted the Worker. The Worker did not report ready within the bounded window. The run-owned Worker/storage cleanup passed. The attempt was stopped rather than repeated without new deterministic evidence; investigation is tracked in [#41](https://github.com/cynos-ai/Tiangong/issues/41). No local-Git Recovery Full pass is claimed here.

## Promotion decision

PASS for the initialization-phase Reviewer v2 local `commit`/`git_diff` activation based on deterministic coverage plus the official Matrix Basic. The B2 scenario is retained because it covers fixed local-Git execution, immutable Artifact authority, Evidence privacy, and no source mutation. Local-Git Recovery Full is explicitly deferred to #41 and the later end-to-end verification stage; model-liveness Journey remains non-gating.
