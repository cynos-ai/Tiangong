# AGENTS.md

## Scope

These instructions apply to the entire Tiangong repository.

## Current phase

The repository is in project initialization. Do not add runtime, application, package, deployment, or generated code unless the task explicitly authorizes that scope.

## Product principles

- Tiangong is the project name. Do not add `Cynos` to the product or repository name.
- The project is designed as a self-contained, Apache-2.0 open-source project built on public dependencies.
- Do not import, copy, or depend on private packages, repositories, images, fixtures, archives, or services.
- AgentTeams provides the team/container/Matrix/storage integration layer; Tiangong owns its worker runtime, professional roles, evidence, approvals, and product experience.
- Prefer coarse professional roles and cohesive operations over one Worker per practice or file type.
- Treat claims, model prose, and machine-captured evidence as different facts.

## Public and internal documentation

This is a public repository. Never commit confidential competition strategy, private prior-work details, credentials, partner agreements, unpublished product plans, or internal-only reports here—even on a non-default branch.

GitHub does not support private branches or private directories inside a public repository. Internal documents belong in a separate private repository, recommended as `cynos-ai/Tiangong-internal`, with the local sibling path `../Tiangong-internal/`. Do not add that repository as a required submodule or runtime dependency of Tiangong.

## Branch model

Use a Git Flow–lite model:

- `main`: stable, release-ready history only. Never push directly.
- `develop`: integration branch for the next release. Never push directly after repository bootstrap.
- `feat/<issue>-<slug>`: product features, branched from `develop`, merged into `develop` by pull request.
- `fix/<issue>-<slug>`: non-production bug fixes, branched from `develop`, merged into `develop` by pull request.
- `docs/<issue>-<slug>`, `refactor/<issue>-<slug>`, `test/<issue>-<slug>`, `chore/<issue>-<slug>`: same lifecycle as feature branches.
- `release/v<version>`: release stabilization, branched from `develop`; only release blockers, documentation, versioning, and generated release metadata are allowed. Merge into `main` by pull request, then merge the released state back into `develop`.
- `hotfix/v<version>-<slug>`: urgent released-version fixes, branched from `main`; merge into `main` and back into `develop` by pull request.

Delete short-lived branches after merge. Do not force-push shared branches.

## Commits and pull requests

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`, `perf:`, `revert:`.
- Keep commits reviewable and free of unrelated changes.
- Use pull requests for all changes to `develop` and `main` after bootstrap.
- Prefer squash merge for feature branches so the pull-request title becomes the canonical commit.
- A pull request must explain motivation, scope, verification, risk, and any user-visible change.
- Do not merge with unresolved review conversations or failing required checks.
- Never commit secrets, local credentials, private evidence, or generated dependency directories.

## Versioning and releases

Tiangong follows Semantic Versioning:

- `v0.y.z` while public APIs and product contracts are still stabilizing;
- prereleases use `-alpha.N`, `-beta.N`, or `-rc.N`;
- stable releases use immutable annotated tags such as `v0.1.0`;
- never move or reuse a published tag.

Release flow:

1. Create `release/vX.Y.Z` from `develop`.
2. Run all required build, test, security, license, reproducibility, and clean-environment checks.
3. Prepare changelog/release notes and record compatibility or migration changes.
4. Merge the release pull request into `main`.
5. Create the annotated `vX.Y.Z` tag from the merge commit and publish a GitHub Release.
6. Publish immutable image/package digests, checksums, SBOM, provenance, and known limitations when those artifacts exist.
7. Merge the released state back into `develop`.

Until release automation exists, do not create a release tag merely for project initialization.

## Change discipline

- Keep architecture decisions explicit and versioned when they become public project facts.
- Add the smallest implementation that proves the current contract; avoid speculative frameworks.
- Put deterministic safety boundaries—authorization, idempotency, evidence gates, and rollback checks—in code rather than prompts.
- Update this file when repository-wide workflow or release rules change.
