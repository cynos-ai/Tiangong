---
name: tiangong-skill-authoring
description: Create, maintain, or audit portable Agent Skills for Tiangong. Use when adding or editing a SKILL.md, bundled scripts, references, assets, trigger descriptions, Skill validation, or Skill security and distribution rules.
license: Apache-2.0
---

# Tiangong Skill authoring

Create Skills as executable workflow packages, not general documentation.

## Required workflow

1. Define concrete user prompts that should and should not activate the Skill.
2. Decide whether the Skill is:
   - maintainer-only under `.agents/skills/`; or
   - a future product Skill under the Tiangong-owned product registry.
3. Search for an existing Skill with the same responsibility. Extend it instead of creating overlapping triggers.
4. Design the smallest package:
   - `SKILL.md` for instructions;
   - `references/` only for details loaded on demand;
   - `scripts/` only for repeated deterministic operations;
   - `assets/` only for output resources;
   - `tests/trigger-cases.json` for activation boundaries.
5. Write bundled resources first, then keep `SKILL.md` concise.
6. Run `make check-skills`.
7. Add or update a Skill smoke scenario when behavior, triggers, scripts, or side effects change.
8. Inspect the final package for public-boundary and supply-chain risks.

## Frontmatter

Follow the Agent Skills specification:

- `name`: lowercase letters, digits, and hyphens; maximum 64 characters; equal to the parent directory name.
- `description`: state both what the Skill does and when it activates; include boundary keywords; maximum 1024 characters.
- `license`: use `Apache-2.0` for native Tiangong Skills.
- Add `compatibility` only for real environment requirements.
- Treat `allowed-tools` as optional compatibility metadata, never as authorization.

Put trigger information in `description`; the body is not loaded until after activation.

## Instruction design

- Use direct, imperative steps.
- Match precision to risk: exact commands for fragile deterministic work; bounded judgment for open-ended analysis.
- Use concrete pass/fail examples for easy-to-misinterpret boundaries.
- Give every required evidence path a blocked alternative that records the failure and attempted approaches.
- State the success evidence and cleanup requirement.
- Keep `SKILL.md` below 500 lines. Move focused detail to one-level references.
- Do not create auxiliary README, changelog, installation diary, or duplicated quick-reference files inside a native Skill.

## Security and portability

- Do not include credentials, private URLs, internal hostnames, private repository paths, local absolute paths, raw sessions, or internal reports.
- Do not copy private Skills or project-specific protocols into a public Skill.
- Review every bundled script as executable supply-chain code. Validate inputs, bound output, fail clearly, and clean only owned resources.
- Require explicit authorization for destructive, costly, public, or irreversible external actions.
- Keep authorization, idempotency, path restrictions, and Evidence enforcement in runtime code rather than Skill prose.
- Use relative paths inside the Skill package. Do not depend on sibling private repositories.

## Validation

Require four layers:

1. structural validation of frontmatter, names, references, and package shape;
2. security scan for credentials, private paths, and unsafe scripts;
3. trigger truth table with positive, negative, ambiguous, and adjacent-Skill prompts;
4. behavior smoke with machine-observable success, blocked, and cleanup evidence.

Do not make model-sensitive trigger smoke a hard per-commit gate unless its environment and expected variance are controlled.

## Anti-patterns

- Do not broaden a description merely to make one test prompt activate.
- Do not duplicate repository rules inside every Skill.
- Do not prescribe a model unless model choice is part of the capability contract.
- Do not claim a maintainer Skill is loaded by the Tiangong Worker runtime until the product registry actually supports it.
- Do not publish under an `alibabacloud-*` name without explicit Alibaba Cloud authorization.
