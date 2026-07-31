# Releasing Tiangong

Tiangong follows Semantic Versioning. Public APIs and product contracts use `v0.y.z` while they are stabilizing. Prereleases use `-alpha.N`, `-beta.N`, or `-rc.N`.

## Release flow

1. Create `release/vX.Y.Z` from `develop`.
2. Allow only release blockers, documentation, versioning, and generated release metadata on the release branch.
3. Run required build, test, security, license, reproducibility, and clean-environment checks.
4. Prepare release notes and record compatibility or migration changes.
5. Merge the release pull request into `main` after all required checks and reviews pass.
6. Create an immutable annotated `vX.Y.Z` tag from the merge commit and publish a GitHub Release.
7. Publish immutable package/image digests, checksums, SBOM, provenance, and known limitations when those artifacts exist.
8. Merge the released state back into `develop` through a pull request.

Never move or reuse a published tag. Do not create a release tag merely for project initialization.

Urgent released-version fixes use `hotfix/vX.Y.Z-<slug>` from `main` and merge back into both `main` and `develop` by pull request.
