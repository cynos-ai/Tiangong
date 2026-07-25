# AGENTS.md

## Scope and phase

These instructions apply to the entire Tiangong repository.

Tiangong is in project initialization. There are no released versions, external users, or compatibility commitments. Prefer the cleanest current design: delete obsolete paths instead of adding shims or migrations unless a task explicitly requires compatibility.

## Always-on boundaries

- Tiangong is the project name. Do not add `Cynos` to the product or repository name.
- Keep the public project self-contained and based only on public dependencies.
- Do not import, copy, or depend on private packages, repositories, images, fixtures, archives, or services.
- Commit only material needed to build, test, use, secure, maintain, or govern the public project.
- Never commit credentials, private evidence, internal research, strategy, schedules, evaluations, partner information, unpublished plans, or internal reports—even on a non-default branch.
- Private working material must remain outside this repository and must not become a submodule or runtime, build, test, or release dependency.
- AgentTeams owns the team/container/Matrix/storage integration layer. Tiangong owns its Worker runtime, professional roles, evidence, approvals, and product experience.
- Prefer coarse professional roles and cohesive operations over one Worker per practice or file type.
- Treat claims, model prose, machine state, and machine-captured evidence as different facts.
- Put authorization, idempotency, evidence gates, path restrictions, and rollback checks in code rather than prompts, rules, or Skills.

## Required rule loading

Read the relevant rule before changing the matching area:

| Task or path | Rule |
|---|---|
| Any code, script, refactor, or bug fix | [`docs/rules/implementation.md`](docs/rules/implementation.md) |
| Tests, CI, smoke scenarios, external resources, or cleanup | [`docs/rules/verification.md`](docs/rules/verification.md) |
| Credentials, logs, Evidence, approvals, dependencies, or external side effects | [`docs/rules/security-and-evidence.md`](docs/rules/security-and-evidence.md) |
| `worker/`, AgentTeams/OpenClaw integration, tools, Gate, approval, or recovery | [`docs/rules/worker-runtime.md`](docs/rules/worker-runtime.md) |

Use project Skills for reusable workflows. Rules never replace deterministic runtime enforcement.

## Repository workflow

- Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) for branches, commits, and pull requests.
- Follow [`RELEASING.md`](RELEASING.md) for versions and releases.
- Never push directly to `main` or `develop`; use a short-lived issue branch and a pull request.
- Use Conventional Commits and sign every commit with `git commit -s`.
- Keep commits reviewable and free of unrelated changes.
- Do not merge with failing required checks or unresolved review conversations.
- Never force-push a shared branch or move a published tag.

## Completion discipline

- Understand the current implementation and callers before editing.
- Make the smallest change that proves the current contract; avoid speculative frameworks.
- Verify at the cheapest deterministic layer first, then use expensive integration smoke only when its boundary is relevant.
- Report known limitations and blocked verification explicitly; do not turn missing evidence into a success claim.
- Update these instructions only when repository-wide workflow or safety boundaries change.
