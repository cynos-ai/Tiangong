# Runner first-plan fetch Evidence diagnostic

> Date: 2026-08-03
> Level: deterministic and real Docker broker regression
> Status: PASS

## Purpose

Preserve direct machine Evidence for the unresolved real Worker first
`/v1/plan` boundary without retrying a failed professional Task or executing a
command. The professional role still retrieves the immutable plan before the
Runner journal; the new Evidence events classify only the plan request stage.

## Contract

- `runner.plan.requested` binds Task ID, run ID, role, Task binding digest, and
  a digest of the credential-free broker endpoint.
- `runner.plan.received` binds the returned immutable plan digest, command
  digest, cwd, timeout, and output bound.
- `runner.plan.failed` records only a finite stable failure code; it never stores
  raw fetch errors, credentials, response bodies, model text, or endpoint text.
- A plan failure remains `TIANGONG_RUNNER_PLAN_UNAVAILABLE`, occurs before the
  Worker Runner journal, and cannot be automatically retried.

## Proof

- Worker unit/contract suite: `289/289` passed.
- Targeted member/Runner tests: `13/13` passed.
- Repository policy, syntax, and diff checks: passed.
- Worker, professional profile, and Runner broker images rebuilt from the
  changed source.
- Real Docker broker smoke passed plan retrieval, changed-plan rejection,
  exact replay, revision sealing, independent Assessor materialization,
  unauthorized-peer rejection, no Worker Docker socket, and exact cleanup.
- Machine-captured broker plan digest in this run:
  `4116897c504e45d012439405ccbf077d3883975480ecdd42507b4ea909b7d6f5`.

This diagnostic proves observability and preserves fail-closed semantics. It
does not claim a real AgentTeams professional delivery or `DELIVERED`.

## Follow-up

The next justified Full attempt may use these events to distinguish a broker
rejection, invalid response, timeout, or network failure on the first plan
request. It must keep provider/model, fixture, timeout, and isolation policy
fixed and must not replay either failed run.
