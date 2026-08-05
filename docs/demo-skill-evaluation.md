# Demo Skill evaluation

> Date: 2026-08-04
> Evaluation type: deterministic with/without trusted Skill context
> This is not a claim about model quality or professional judgment.

## Contract

For each active responsibility role (`leader`, `designer`, `implementor`,
`assessor`, `operator`):

1. Load the fixed profile, SOUL, and Skill through the digest-validated loader.
2. Build the trusted system context with the bound Skill.
3. Build a comparison context with the Skill text removed, without changing
   the fixed profile or tool registry.
4. Require the two context digests to differ while the role, profile digest,
   tool IDs, Playbook binding, and authority remain unchanged.

This tests the safety property that a Skill contributes bounded context but
cannot grant a tool, change a role, or rewrite the Playbook. It does not test
whether an LLM makes a better design or assessment.

## Reproduction

```bash
make check-demo-contract
```

The command also verifies:

- all five profile and Skill digests against the closed registry;
- expected role-scoped tool surfaces;
- absence of active Reviewer/Practice authority;
- `software-change-delivery@1.0.0` package and `playbooks.lock.json` equality;
- the fixed Runner fixture manifest digest.

The command emits only digests, IDs, tool names, and boolean contract facts; it
never prints credentials, prompts, responses, or transcripts.

## Result

The evaluation passed for all five roles. Each with/without context pair had
different context digests, while the fixed role tool surface remained equal.
The Playbook and fixture locks also passed. The result is a deterministic
binding/authority evaluation, not an independent assurance of model output.
