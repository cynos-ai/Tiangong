# Professional delivery with broker-bound plans

> Date: 2026-08-03
> Level: focused real integration and Full-path continuation
> Status: BLOCKED (pinned installer origin unreachable)

## Scope

Run a fresh AgentTeams v1.2.0 stack and fresh five-role Team from source commit
`5143d0f`. Re-attempt Designer → Implementor → Assessor → Operator → requester
using the now machine-bound Runner command plans. No Project, Task, revision,
journal, approval, target, or Evidence from a prior run may be reused.

Provider/model remain the configured `openai-compat` and
`deepseek-v4-flash`. The fixed Implementor and Assessor plans are exactly
`["node","probe.mjs"]`, timeout 30000 ms, output bound 65536 bytes. Deployment
fault mode is `none`. None of these inputs may change after Team creation.

## Prerequisites

- Full Worker suite: 289/289 passed.
- Broker-bound plan container regression: PASS, including changed-plan and
  unauthorized-peer rejection, exact replay, revision roundtrip, Evidence, and
  cleanup.
- Fresh `make up` must prove the committed automatic Manager DM recovery and
  finish with `make verify` green before Team creation.
- Required images must be rebuilt from `5143d0f`.

## Required proof

1. Automatic Manager readiness, Active five-role Team, complete Matrix roster,
   effective peer allowlists, and loaded OpenClaw policy.
2. Accepted Design, Implement, and Assess chain with immutable bindings.
3. Professional model tools expose only `taskId`; broker plan retrieval occurs
   before Worker journal creation and exact plan digest appears in machine
   Evidence.
4. Implementor and Assessor each execute one broker-bound command; Assessor
   independently verifies the exact sealed revision digest read-only.
5. Release Task, closed deployment broker/target binding, and fixed trusted
   approver are present before Operator wake.
6. Explicit authenticated approval binds the exact pending operation digest;
   activation cannot occur before it.
7. Target journal, broker receipt, Operator Result, and Leader decision bind the
   same healthy `DELIVERED` outcome.
8. Immutable requester report, official Matrix delivery, and durable Evidence
   bind the original authenticated requester.
9. Exact cleanup succeeds. Any Team or stack residue keeps the run failed.

## Stop rules

- Stop on any binding, readiness, plan, revision, approval, target, Evidence, or
  cleanup mismatch.
- Do not retry an uncertain invocation or edit product code during the active
  run.
- Do not issue exploratory model commands or manually author Worker Results.
- A second failure of the same class requires lower-level evidence before any
  further expensive run.

## Ownership

The run owns the fresh local AgentTeams stack and all unique Team, Worker,
Project, Task, Runner broker, deployment broker, target, container, network,
volume, config, and journal resources created after readiness. Exact unique
identifiers will be appended before their creation. Sensitive generated
credentials and installer output remain owner-only outside Evidence and are
removed during cleanup.

## Result

**BLOCKED before AgentTeams installation; no professional run started.**

Two bounded attempts to run fresh `make up` failed at the same prerequisite.
The host could not connect to `raw.githubusercontent.com:443` for approximately
134–135 seconds, so the pinned AgentTeams v1.2.0 installer could not be
downloaded. The checksum gate then correctly rejected the absent temporary file
rather than executing unverified content. No alternative mirror, copied private
artifact, changed dependency, provider/model substitution, or third expensive
attempt was used.

Classification: **external network / dependency retrieval**, high confidence.
This failure is unrelated to Manager readiness, Team coordination, the new
broker-bound command plan, the model, or deployment because none of those
boundaries started. The prior deterministic and real Docker broker-plan proof
remains valid but cannot replace a real Team roundtrip.

Cleanup: **PASS**. Only empty run-created runtime/install-cache directories
existed. They were removed. Final checks found zero `agentteams-*` containers,
no `agentteams-net`, no `tiangong-agentteams-data`, no generated Manager
environment, and no sensitive installer log.

Smallest follow-up: retry only after direct connectivity to the immutable public
installer origin recovers or the same checksum-verified public installer is
available in the normal Tiangong cache. Do not change the pinned version,
checksum, provider/model, Runner plan, or deployment fixture to bypass this
blocker.
