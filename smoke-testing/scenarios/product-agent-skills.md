# Product Agent package and Skill smoke

## Purpose

Prove the public M1/M2 boundary without requiring model-sensitive trigger judgment:

- exactly six long-lived Agent packages load from the generic Worker image;
- package responsibility/runtime/model/capability/session policy is fixed;
- product Skills are portable, versioned, digest-locked, and public-safe;
- effective Skills equal installed-by-package ∩ `MemberConfig.allowedSkills`;
- an Agent can select an enabled Skill and the top-level call emits bounded ToolResult metadata;
- an uninstalled, disabled, mismatched, or unauthorized Skill fails closed.

This smoke does not prove model quality, real Matrix delivery, repository modification, or production authority.

## Deterministic run

```bash
make check-skills
make test-product-agent-skills
```

## Success evidence

- Validator prints six `product_skill=... validation=pass` lines and six `agent_package=... validation=pass` lines.
- Tests observe distinct Leader Work and member Task session references.
- Allowed subset resolution returns only the configured Skill IDs.
- `tiangong_use_skill` returns the locked identity/version/content digest and instructions.
- ToolResult capture projects `skillId`, `skillVersion`, and `skillContentDigest` without raw Skill output.
- Runtime console projects Agent package, model, active Task, session, enabled Skills, and actually used Skills.
- Docker injection validates all six responsibility/package/capability combinations.

## Blocked evidence

The run must fail for:

- MemberConfig package/responsibility/runtime/model/capability mismatch;
- `allowedSkills` referencing a Skill absent from the Agent package;
- changed Skill content with a stale Agent package digest lock;
- direct selection of a Skill outside the effective set;
- disabled MemberConfig;
- invalid or duplicate Skill package metadata;
- any tool that is absent from the Agent package tool groups and the pinned OpenClaw workspace tool lock.

## Cleanup

The deterministic tests may create only process-local temporary directories. Test cleanup removes those directories. The Docker injection contract uses a fake owned Docker command and removes its temporary root through its shell trap. No Matrix room, container, repository, network service, credential, or external resource is created.
