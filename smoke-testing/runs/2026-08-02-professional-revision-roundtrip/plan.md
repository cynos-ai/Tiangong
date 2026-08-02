# Focused run — real Implementor → Assessor ChangeRevision roundtrip

> Status: FAILED — AgentTeams v1.2.0 dropped the Worker `spec.env` broker endpoint
> Date: 2026-08-02
> Branch: `feat/43-agentteams-v1.2-and-leader-spike`

## Scope and level

Focused real-integration proof of one accepted Implementor Task followed by one
accepted Assessor Task in an Active AgentTeams v1.2.0 Team. This run does not
claim `DELIVERED`; deployment and requester reporting remain separate gates.

## Fixed inputs

- Provider/model: configured AgentTeams OpenAI-compatible gateway,
  `deepseek-v4-flash`.
- Team: `tiangong-professional-smoke`.
- Workers: one Tiangong Leader plus Designer, Implementor, Assessor, and
  Operator RoleProfiles.
- Runner image: immutable local image ID resolved before broker bootstrap.
- Fixture: `smoke-testing/fixtures/runner-isolation`.
- Implementor objective: run `node probe.mjs` once through `run_command` and
  submit the returned `ChangeRevisionRef`.
- Assessor objective: run `node probe.mjs` once through `run_test_command` on
  the exact read-only materialization and submit the same reference.

## Orchestration and ownership

The Team and Tasks must be created by the real Leader over Matrix. Professional
Workers must resolve and submit through their own model turns. The test driver
may temporarily put the Implementor and Assessor Workers to sleep after Team
readiness so it can bootstrap the broker from the immutable Task binding before
the queued official Matrix assignment is consumed. It must not call Worker
internal functions, forge a Worker Matrix message, or manufacture a Result.

Owned resources:

- the five reserved Workers and their containers/storage;
- Team `tiangong-professional-smoke` and its Team room/storage;
- unique Project and all Tasks under that Project;
- broker container `tiangong-professional-runner-broker`;
- broker state volume `tiangong-professional-runner-state`;
- run-local broker config beneath `.runtime/professional-smoke/`;
- broker-created resources labeled for its exact run IDs.

The existing AgentTeams stack is a prerequisite, not run-owned. Cleanup failure
keeps the run failed. The known upstream Team deletion defect must be reported,
not hidden by a later stack reset.

## Required machine evidence

1. Team was `Active`, had one `team_leader`, and all four professionals were
   ready before the controlled sleeps.
2. AgentTeams Project/Task records and immutable Tiangong bindings exist under
   `shared/projects/` and `shared/tasks/`.
3. Implementor Result producer/profile/Skill/Task digests match its binding and
   contains a broker/journal-proven `ChangeRevisionRef`.
4. Leader accepted that exact Implementor Result digest before creating Assess.
5. Broker revision object re-verifies to the reference artifact digest.
6. Assessor runner Evidence has `fixtureDigest == artifactDigest`, returns the
   same canonical `ChangeRevisionRef`, and cannot modify the authoritative
   revision.
7. Assessor Result binds the same reference and Leader accepts its exact digest.
8. Runner and broker journals prove one command execution per professional
   invocation; Workers have no Docker socket and runner policy remains
   `network=none`, read-only rootfs, non-root, drop-all capabilities, bounded
   tmpfs and resources.
9. No release Task is accepted as evidence for this focused run.
10. Exact cleanup is verified.

## Fail-closed rules

- Missing broker registration, wrong Task/run/image/peer/revision/digest, or an
  outcome-uncertain command fails the run.
- A blocker, revision request, duplicate command, forged Result, model prose
  without machine state, or test-driver-authored handoff is not a pass.
- Do not wake a professional Worker until the broker config includes its exact
  immutable Task/run binding.
- Do not reuse an old revision, old Result, or old runner journal.

## Observed result — attempt 1

The Team reached `Active` with all five real Workers. Project
`professional-3638bec9` completed design and the Leader accepted the Designer
Result, then created `professional-3638bec9-implement-0` with an immutable
single-line objective and the accepted design Task as its input ref.

The focused run failed before command execution. Although the Worker manifest
contained `spec.env.TIANGONG_RUNNER_BROKER_ENDPOINT`, the AgentTeams v1.2.0
controller did not retain that field in the effective Worker resource or
container environment. The Implementor therefore failed closed with
`TIANGONG_RUNNER_UNAVAILABLE`; its blocker Result was accepted only as
`blocked`. No ChangeRevision was created and no Assess Task was dispatched.
The separately started broker remained ready but received no execution.

Classification: **adapter/host contract**. This is not a model, Runner, or
revision-store failure. Before attempt 2, the product needs a deterministic
broker service-discovery endpoint that does not depend on an unsupported
Worker environment field, plus a lower-level regression test. This failed
Project and its immutable Task chain must not be reused.

Cleanup result: **FAIL**. `agt delete team` returned without releasing the
Active Team or its five Worker members, matching the known AgentTeams v1.2.0
cleanup defect. Broker-owned containers and volumes were removed. A subsequent
explicit whole-stack reset is remediation for the development environment and
does not upgrade this run's verdict.
