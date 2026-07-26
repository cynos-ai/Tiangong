# Team Leader runtime boundary focused run

## Purpose

Verify whether AgentTeams `v1.2.0-beta.1` can create an inline Team whose Leader and Worker both use `runtime: openclaw` and `image: tiangong-worker:dev`, while preserving role facts, official Matrix topology, Tiangong Harness selection, restart persistence, and exact cleanup.

This run is a platform-boundary spike. It does not implement Work Ledger, Assignment, Result, Reviewer, or Leader failover behavior.

## Scope and ownership

- Team: `tiangong-team-smoke`
- Leader: `tiangong-team-smoke-leader`
- Worker: `tiangong-team-smoke-engineer`
- Matrix aliases:
  - `#agentteams-team-tiangong-team-smoke:<local-domain>`
  - `#agentteams-leader-dm-tiangong-team-smoke-leader:<local-domain>`
- Storage prefixes:
  - `agents/tiangong-team-smoke-leader/`
  - `agents/tiangong-team-smoke-engineer/`
  - `teams/tiangong-team-smoke/`

The run refuses to replace an existing Team, synthetic member, or member container. Cleanup is limited to the fixed resources above.

## Verification order

1. `make test-team-runtime-smoke-contract`
2. Worker deterministic tests
3. `make verify`
4. one focused `make test-team-runtime-smoke` attempt per changed hypothesis
5. exact resource, alias, storage, helper, and container cleanup proof

## Failure triage and results

### R1: Aggregated Leader response is lossy

The first attempt stopped because the aggregated Worker API reported the inline Leader as `runtime=copaw` and omitted its image. Source inspection showed that the pinned response projection hardcodes this legacy value even when the Team spec contains explicit fields.

Classification: test oracle / adapter observation. The durable scenario now records that projection but proves actual selection from the fixture, container image and environment, OpenClaw health, and real Tiangong Harness execution. The Worker response remains strictly checked.

### R2: Legacy Team deletion leaves reserved room aliases

A later attempt reused the Leader-DM alias left by the previous legacy Team deletion and failed room provisioning with a Matrix authorization error. Direct alias resolution confirmed that the two reserved aliases still existed after the Team resource and containers were gone.

Classification: cleanup/ownership gap in the pinned legacy Team path. The durable runner now:

- makes terminal Team `Failed` stop the wait immediately;
- removes only the two hard-coded reserved aliases through a test-only Controller helper;
- uses a temporary Admin Matrix session without printing its credential and logs it out;
- keeps alias cleanup failure red;
- removes the helper after cleanup.

### R3: Embedded declarative API drops Leader runtime and image

After the oracle and cleanup regressions were closed, the Team reached the point where the actual Leader container could be inspected. The container used the pinned stock CoPaw image rather than `tiangong-worker:dev`.

Public source inspection explains the boundary:

1. `hiclaw apply -f` forwards the YAML `spec` to the embedded Team HTTP endpoint;
2. the pinned `TeamLeaderRequest` HTTP type does not contain `runtime` or `image`;
3. the Team create handler therefore does not copy those two fields into `Team.Spec.Leader`;
4. the reconciler falls back to the stock CoPaw Leader runtime and image.

Classification: pinned AgentTeams adapter/host contract blocker, not a Tiangong runtime failure and not a model-response failure.

### R4: Direct embedded config publication is also pruned

A test-first follow-up evaluated whether the lower embedded config mirror/watcher could preserve the same public Team CR fixture without using the lossy HTTP request type. The exact MinIO config object and mirrored YAML retained both Leader fields, but an authenticated, field-filtered Kubernetes API observation showed `spec.leader.runtime=null` and `spec.leader.image=null` while the Worker's equivalent fields remained intact. The actual Leader again used the stock CoPaw image.

The pinned Team CRD schema explains the result: its legacy `spec.leader` OpenAPI properties omit `runtime` and `image`, while `spec.workers[*]` includes both. Kubernetes structural-schema pruning removes the Leader fields before reconciliation. The experimental direct-publication change was therefore reverted rather than retained as a false workaround.

Classification: pinned AgentTeams CRD contract blocker. Neither the embedded HTTP adapter nor direct config ingestion can create the required custom legacy Leader on this release.

## Current result

**BLOCKED** on AgentTeams `v1.2.0-beta.1` for an explicitly configured custom Team Leader runtime/image. Both the embedded apply request and the installed Team CRD omit or prune the required Leader fields.

The assertion must not be weakened to accept the stock Leader. Phase 0 is intended to prove that the Tiangong trust kernel runs inside the Leader; a stock Leader would invalidate the boundary under test.

The decisive attempt did not proceed to Matrix turns, Harness assertions, or restart persistence because the actual Leader image check failed first.

## Cleanup result

After the decisive attempt, machine checks confirmed:

- Team absent;
- both synthetic members absent;
- both member containers absent;
- both reserved Matrix aliases unresolved;
- all three exact storage prefixes empty;
- copied Manager manifest absent;
- copied Controller cleanup helper absent.

Cleanup passed. No broader AgentTeams resource or storage path was removed.

## Smallest follow-up

Resolve the public platform contract before another real smoke:

1. wait for or select a reviewed public AgentTeams release containing the decoupled `Worker` + `Team.spec.workerMembers` contract already present on upstream `main` after PR #1072;
2. update Tiangong's immutable AgentTeams pin through normal dependency review;
3. replace the legacy inline fixture with two explicit Worker resources plus one Team membership resource; and
4. prove an authenticated role-fact path into Tiangong TurnIngress rather than treating mutable prompt assets as authorization.

As of this run, `v1.2.0-beta.1` remains the newest public release; upstream `main` is not a releasable dependency pin. Do not bypass the gate with prompt instructions, a stock Team Leader, global default-image mutation, direct config-object publication, private patches, or a Tiangong-owned replacement for Team/Matrix lifecycle.

## Promotion decision

Keep `team-runtime-boundary.md` and its deterministic contract as durable coverage. Do not add the real Team smoke to CI while the pinned platform contract is blocked. Once an upstream pin preserves the explicit Leader runtime/image, rerun the same scenario without weakening later role, Matrix, Harness, restart, Evidence, or cleanup assertions.
