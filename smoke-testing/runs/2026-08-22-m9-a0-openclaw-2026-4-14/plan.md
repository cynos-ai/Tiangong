# M9-A0 pinned OpenClaw spike

## Scope

- Issue: #110
- Design: `docs/design/m9-professional-agent-runtime-and-project-knowledge.md`, §§16.1, 17.1, 20.1
- Component under test: OpenClaw `2026.4.14` (`2f35b6f`) and the Tiangong control plugin path
- Run type: focused research/integration spike; the final layer is one Basic Matrix member turn
- Product boundary: this run does not implement or enable M9-A and does not authorize an OpenClaw upgrade

## Contract and owners

- OpenClaw owns the pinned hook registry, runner, prompt/session path, and official Matrix Channel Plane.
- Tiangong owns the control plugin, admission decisions, bootstrap contract decision, ToolResult capture decision, and sanitized report.
- Fake provider and fake coordination endpoint are test-only fixtures owned by this run.
- The disposable workspace and any final reserved Matrix fixture must be created by the run, recorded by stable identifier, and cleaned only by the run.

## Provider and target identity

- Layers 1–3: no external model provider; use a deterministic fake provider and capture the final request without credentials.
- Layer 4: use the official Channel Plane with one reserved safe member fixture. Record the exact owned fixture identity and current turn correlation in `result.md` before execution.
- No production Work, Task, room, repository, credential, or unrestricted transcript is in scope.

## Prerequisites

- Repository branch is based on merged `develop` and keeps the pinned OpenClaw version at `2026.4.14`.
- Actual candidate Worker image reports the pinned OpenClaw version and source/type paths before any hook runner test.
- Docker, Node, the repository deterministic checks, and the local AgentTeams/Matrix stack are available only for the layer that requires them.
- No layer may silently change the OpenClaw version, provider, model, prompt, fixture, timeout, or isolation policy.

## Serial gates

A later layer is blocked unless the previous layer has a passing direct machine result:

1. **Source/type/contract inspection** — inspect hook types, registration, ordering, await/block, throw/timeout, priority, error policy, bootstrap loading, and final prompt assembly.
2. **Container hook runner + fake provider** — run the real runner in the actual image with no external network; verify blocking, final request, persistence ordering, replay, truncation, bootstrap placement, and corrupt/missing bootstrap behavior.
3. **Deterministic integration** — run the real plugin and gateway/session path with fake provider, fake coordination, synthetic Task and Work-Leader admission, runtime binding/claim fixtures, and disposable workspace.
4. **Basic Matrix turn** — use the official Channel Plane once to confirm the already-proven path; it cannot prove authorization, concurrency, atomicity, or recovery.

If any layer fails, stop immediately, preserve sanitized evidence, and do not run later layers or begin M9-A implementation.

## Required observations

- `before_tool_call`: synchronous gate from the caller's perspective; await behavior, block result, thrown error, timeout, priority, and whether the tool executes.
- `tool_result_persist`: synchronous-only contract, exact ordering relative to transcript persistence and return to the model, replay behavior, truncation, and failure behavior.
- `before_prompt_build`: final request/system context, mutation fields, ordering, priority, and failure behavior.
- Immutable bootstrap: selected `AGENTS.md`/`SOUL.md` content reaches the final provider request; missing, corrupt, or digest-mismatched input prevents the model call rather than degrading to ordinary prompt context.
- Observation-only hooks remain observations and are not treated as fail-closed controls.

## Evidence and sanitization

- Store direct, bounded machine evidence under this run directory with pinned versions, source paths/line ranges, stable fixture IDs, event ordering, exit codes, and sanitized error codes.
- Do not store credentials, tokens, provider configuration, private session material, raw Matrix transcripts, unrestricted prompts, or unrestricted logs.
- Keep model/provider response claims separate from hook outcomes, persistent records, and external Matrix observations.

## Timeout and cleanup

- Each layer has an explicit command timeout recorded in `result.md`; no fixed sleep is used as readiness proof.
- Cleanup runs after every started layer and removes only this run's disposable workspace, fake services, containers, and reserved fixture resources.
- Cleanup failure keeps the run red and is reported with the exact owned resource residue.

## Deliverables

- `plan.md` — this pre-run scope and gate plan.
- `result.md` — per-layer pass/fail/blocked status, direct facts, limitations, and integration decision.
- Bounded evidence files referenced by `result.md`.

## Decision rule

The spike is research evidence only. A passing result selects the actual hook/bootstrap integration points for a later M9-A implementation PR. A failed or inconclusive premise requires a design revision and review before any implementation; no prompt, Skill, Gate, or manual process may be used as a substitute for a missing runtime safety boundary.
