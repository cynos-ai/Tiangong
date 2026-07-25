# Maintainer Skill smoke scenarios

## Ownership

- Related implementation: `.agents/skills/`, `scripts/check-skills.mjs`
- Related Skills: `tiangong-skill-authoring`, `tiangong-smoke-authoring`, `tiangong-smoke-running`
- Related state/Evidence: static validation output, trigger decision, created or reviewed test asset, repository diff
- Update triggers: Skill name/description/body changes, bundled resources, validation policy, smoke layout, or project Skill discovery behavior

## Basic smoke

### B1: Static package validation

- Purpose: Prove each native Skill is structurally valid, self-contained, public-safe, and has positive and negative trigger cases.
- Setup: clean dependency-free repository checkout with Node.js 22 or later.
- Prompt: none; run `make check-skills`.
- Expected observations: every discovered Skill reports `validation=pass`; folder and frontmatter names match; required trigger arrays exist; no private path, credential-like content, escaping reference, or symlink is accepted.
- Required evidence: command exit code zero and one validation line per Skill.
- Skip/block rules: never skip for a Skill change. A validator defect must be fixed rather than bypassed.

### B2: Skill selection boundaries

- Purpose: Check that each description activates for its owned workflow and does not claim adjacent implementation work.
- Setup: trusted project session with project Skills visible; use the prompts in each `tests/trigger-cases.json` without additional hints.
- Prompt: execute each positive and negative trigger case in a disposable session or trigger-evaluation harness.
- Expected observations: positive cases load the named Skill; negative cases do not; smoke authoring and smoke running remain distinct.
- Required evidence: prompt, selected Skill name or no-selection result, model/provider, and any ambiguous result.
- Skip/block rules: model-sensitive mismatches are review signals unless the same boundary fails repeatedly across the supported evaluation model. Do not broaden descriptions after a single noisy result.

## Full smoke

### F1: Author a disposable Skill

- Purpose: Prove `tiangong-skill-authoring` drives a portable, validated package rather than prose-only output.
- Setup: disposable copy of the repository; choose a harmless read-only example capability.
- Prompt: request a new Skill with two positive and two adjacent negative triggers and no bundled script unless deterministic code is needed.
- Expected observations: the agent searches for overlap, creates the minimum package, adds trigger cases, runs validation, and does not add private paths or runtime authorization claims.
- Required evidence: resulting Skill tree, validator output, trigger cases, and diff.
- Skip/block rules: no external side effects are allowed in this scenario.

### F2: Design and execute a focused smoke plan

- Purpose: Prove authoring and running Skills preserve the separation between scenario, execution, machine evidence, diagnosis, and product changes.
- Setup: inject a deterministic test-driver fixture failure in a disposable repository copy.
- Prompt: first request a focused smoke plan, then request execution and review.
- Expected observations: the plan identifies the owned fixture and cleanup; the runner performs lower-level checks before integration; it classifies the test-driver failure without editing product code during the run; it preserves sanitized evidence and cleanup proof.
- Required evidence: plan, commands, failure classification, machine artifact, cleanup result, and unchanged product runtime.
- Skip/block rules: block if a disposable target is unavailable. Do not use the live AgentTeams state to simulate the fixture.

## Maintenance notes

- Keep static validation as a required CI check.
- Trigger and behavior smoke is model-sensitive and runs when Skills change or before a release, not necessarily on every pull request.
- Add portal-specific packaging tests only after Alibaba Cloud confirms a third-party publication contract.
