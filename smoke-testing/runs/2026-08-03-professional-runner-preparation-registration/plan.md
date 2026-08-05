# Runner broker preparation and registration boundary

> Date: 2026-08-03
> Level: focused deterministic Docker integration
> Status: PASS / preparation boundary proven (not a delivery claim)

## Scope

Prove the new code-owned preparation boundary without a model turn or Matrix
notification. The fixed shared broker must register an Implementor binding
before the Worker can obtain a plan, accept exact replay, then register an
Assessor binding only with the exact Implementor input. This is not a Full
professional delivery and cannot authorize `DELIVERED`.

## Fixed contract

Use the locally built pinned Worker/Runner images, fixed AgentTeams network
`agentteams-net`, broker container `tiangong-runner-broker`, fixed internal
endpoint, command `['node','probe.mjs']`, role-derived cwd, 30000ms timeout,
65536-byte output limit, and the exact broker preparation protocol. No model,
Matrix Task, arbitrary endpoint, command substitution, Docker socket in a
Worker, or automatic replay is allowed.

## Owned resources

- `tiangong-runner-broker` and its exact config, fixture, and state volumes;
- temporary exact Worker containers
  `agentteams-worker-prep-real-leader`,
  `agentteams-worker-prep-real-implementor`, and
  `agentteams-worker-prep-real-assessor`;
- two temporary non-secret preparation request files.

The broker state is disposable for this focused run. Cleanup must remove the
exact containers, broker, volumes, and request file and verify their absence.

## Required machine proof

1. broker startup reports ready and fixed DNS reachability succeeds;
2. preparation returns `status=ready`, exact Task digest, binding digest, fixed
   endpoint digest, and `replayed=false` for Implementor;
3. the exact same Implementor request returns `replayed=true` without a second
   binding;
4. Assessor preparation succeeds only with the registered same-revision
   Implementor input;
5. Implementor and Assessor source containers independently obtain their
   immutable fixed plan; no command execution is required for this boundary;
6. no Worker container has a Docker socket mount;
7. exact cleanup passes.

## Observed result

**PASS for this focused boundary only; no `DELIVERED`.**

The fixed shared broker started under the exact `tiangong-runner-broker`
identity and its DNS reachability probe passed. Three disposable Worker
containers used the exact role images and no Docker socket mounts.

The authenticated Leader preparation call registered Implementor Task
`prep-real-implement-aaaa-4aaa-8aaa-aaaaaaaaaaaa` with:

- Task binding digest `5ee8e5b6806067327bd2078a9f52d85ea4dec811dd03536258341ec068a3a4b0`;
- broker binding digest `e1ca06b28a44e5875f64f5c3bbe03bed1760e4ac7b5dee2b6f4ca5282dc800be`;
- fixed endpoint digest `38863ce0797ea45869702bbfb8e1e7349c79d2d2413060e555bac2bac4583ae5`;
- `replayed=false`.

The exact same request returned `replayed=true` with the same binding digest.
Assessor Task `prep-real-assess-bbbb-4bbb-8bbb-bbbbbbbbbbbb` then registered
only with the exact same-revision Implementor input and returned
`replayed=false`. Independent source-container plan probes returned the fixed
command `['node','probe.mjs']`, Implementor cwd `scratch/revision`, Assessor
cwd `fixture`, timeout `30000`, output limit `65536`, and one immutable plan per
Task. No command execution, Matrix notification, Result, deployment, approval,
or delivery side effect was attempted.

Exact disposable Workers, broker, config/fixture/state volumes, and request
files were removed; final absence checks passed.

## Blocked rules

Any identity mismatch, missing input, binding conflict, DNS/HTTP failure,
changed plan, unexpected execution, missing evidence, or cleanup failure is
FAIL-CLOSED. This focused proof does not replay a failed professional Task and
does not upgrade any historical Full run.
