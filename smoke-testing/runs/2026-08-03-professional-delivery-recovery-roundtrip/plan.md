# Professional delivery recovery roundtrip

> Date: 2026-08-03
> Level: focused real integration continuation
> Status: FAIL (model command-contract violation; upstream cleanup failure)

## Scope

Continue from a verified AgentTeams v1.2.0 stack through a fresh real
Designer → Implementor → Assessor → Operator → requester path. Prove the
successful deployment boundary without reusing any prior Team, Project, Task,
revision, approval, receipt, or target journal.

This run uses the configured `openai-compat` provider and
`deepseek-v4-flash`. Provider, model, prompts, Runner fixture, deployment fault
mode, and timeouts are fixed when the run begins.

## Declared readiness deviation

The fresh stack initially reproduced the AgentTeams v1.2.0 CoPaw sync-cursor
race: the authoritative Manager DM invitation existed while Manager had zero
joined rooms. Before this run, the Manager identity accepted exactly the room
bound by the authoritative Manager resource; `welcomeSent` then became true and
`make verify` passed. Commit `9cddf14` implements that same bounded recovery with
positive, adjacent, and foreign-room regression tests.

This focused run may prove the downstream professional delivery path, but this
already-running stack cannot by itself prove that a subsequent fresh `make up`
automatically executes the committed recovery.

## Fixed inputs and prerequisites

- Source commit: `9cddf14`.
- Team and all five Workers: fresh unique names under one run suffix.
- Runner command for both Implementor and Assessor: first and only invocation is
  exactly `["node", "probe.mjs"]` against the public runner-isolation fixture.
- Deployment fault mode: `none`.
- Deployment target, broker, capability, config/state volumes, and journals are
  run-owned and uniquely labeled.
- Original requester: authenticated AgentTeams administrator in the Leader DM.
- `make verify`, focused deterministic deployment/Runner tests, repository
  checks, and required image builds must pass before Team creation.

## Required machine proof

1. Active five-role Team, complete Matrix roster, effective peer allowlists, and
   loaded OpenClaw policy.
2. Accepted immutable Design, Implement, and Assess Task chain.
3. Implementor seals one `ChangeRevisionRef`; Assessor independently
   materializes and verifies that exact artifact digest with one invocation.
4. Release Task binds the accepted assessment and exact revision.
5. Operator deployment plan binds the release Task, Operator container/image,
   target, previous digest, revision, and fixed configured approver.
6. No activation occurs before authenticated explicit approval of the exact
   operation digest.
7. Deployment target journal proves stage, activate, and healthy post-deploy
   verify; broker receipt and release Result bind the same `DELIVERED` outcome.
8. Leader accepts the release Result, derives `DELIVERED`, and writes one
   immutable terminal report for the original requester.
9. Official Matrix delivery and durable Evidence independently prove requester
   notification.
10. Exact cleanup removes only recorded run-owned resources. Cleanup failure
    keeps the overall run failed.

## Fail-closed and stop rules

- Model prose, tool-call intent, target-only activation, or an unaccepted Result
  is not execution proof.
- Missing or mismatched Task/revision/image/peer/approval/target/Evidence binding
  stops the run before further side effects.
- Timeout or uncertain deployment outcome is not retried automatically.
- Do not issue exploratory Runner calls or manually author Worker Results.
- On a second failure of the same class, stop and add bounded diagnostics rather
  than launching another model turn.

## Owned resources

The base AgentTeams stack is a prerequisite and is not owned by this focused
run. Before creation, this run reserved:

- Team: `tg-del-269435`.
- Workers: `tg-del-269435-{leader,designer,implementor,assessor,operator}`.
- Project: `delivery-269435`; initial Task: `delivery-269435-design-0`;
  subsequent Task IDs must be discovered from immutable bindings.
- Runner broker: `tiangong-runner-broker-269435` and volumes prefixed
  `tiangong-runner-269435-`.
- Deployment broker/target: `tiangong-deployment-broker-269435`,
  `tiangong-deployment-target-269435`; target ID `delivery-target-269435`;
  volumes prefixed `tiangong-deployment-269435-`.
- Additional internal deployment network, if required:
  `tiangong-delivery-269435`.
- Run-local non-secret orchestration files:
  `.runtime/professional-delivery-recovery/`. Any generated capability file is
  owner-only, never copied to Evidence, and deleted during cleanup.

## Result

**Functional result: FAIL-CLOSED / requested delivery not achieved.**

The stack passed `make verify`; 52 focused deterministic Runner, deployment,
approval, revision, and coordination tests passed; repository/bootstrap checks
passed; and all required images rebuilt from `9cddf14`. Team `tg-del-269435`
then reached `Active` with all five Workers, the complete five-role roster in
a stable six-member Matrix room, converged peer allowlists, and observed
OpenClaw config reloads.

Project `delivery-269435` accepted its Designer Result at digest
`65a9bcf0288c94d5ce9d51b4e409ddb02fb3c481b7d9933b58e6226fa2b836c0`
and created exactly one Implement Task,
`delivery-269435-implement-0`. Implementor, Assessor, and Operator had been put
to sleep before dispatch so each controlled service could be bound before its
queued assignment was consumed. The Implementor was woken only after the
closed Runner broker was ready with the exact Task, Worker container/image,
run ID, fixture, and network binding.

The Implementor nevertheless did not issue the required first command. Durable
Gate Evidence records command digest
`e1ed39228da56c4694266a821e0c73890405d1366ce74575d59cc924cd35bd79`;
the deterministic digest for the fixed command `["node","probe.mjs"]` is
`6f80262800f1abc968bf01ddd033875cbcdfb3e28e047329d025d9f2620af1af`.
The first invocation became `outcome_uncertain` with stable reason
`RUNNER_EXECUTOR_FAILED`; the Worker journal contains exactly the append-only
states `executing` then `outcome_uncertain`, terminal hash
`607db2d15f30eb7e6f140f32412fb92d36cfd1276b5c86fb615df7c65c997799`.
No broker journal, revision, disposable Runner residue, Assess Task, Release
Task, approval, deployment broker, deployment target, or deployment journal
was created. Subsequent exploratory model attempts were rejected by the locked
journal rather than executed.

The Implementor submitted a blocker Result at digest
`537fea1d91dfb5af7a718a33042e22f5fb5a5d543f97d50a0ea45d47f025eb51`;
the Leader correctly decided it as `blocked`. The immutable Task chain derived
`RECOVERY_REQUIRED`. Terminal report digest
`fb0a0383d8327aaf050e1d10c13ce51601dafcd9692d72beda581b0d5869403c`
was delivered exactly once to the original authenticated
`@admin:matrix-local.agentteams.io:18080` requester in the Leader personal
room, and one durable `team.requester.report.delivered` Evidence event
independently confirms delivery.

Classification: **environment/model behavior**, high confidence, with correct
product fail-closed handling. The fixed identity and Task objective explicitly
required the first and only command to be `["node","probe.mjs"]`; the machine
command digest proves a different request. No automatic retry or replacement
Project is permitted in this run. A second expensive attempt requires a new
focused hypothesis and direct command-shape control; changing the provider,
model, fixture, or journal would not turn this run green.

Cleanup result: **FAIL**. The run-owned Runner broker and all three Runner
volumes were removed and no disposable Runner residue existed. AgentTeams
`agt delete team tg-del-269435` returned `team/tg-del-269435 deleted`, but after
the bounded wait the Team remained `Active`; Leader, Designer, and Implementor
resources/containers remained running, while Assessor and Operator resources
remained `Sleeping` with exited containers. This reproduces the known upstream
Team member-release defect. The smoke remains red regardless of any subsequent
whole-stack development reset.

Post-verdict remediation also exposed the same upstream uninstall gap: the
pinned uninstaller removed controller, Manager, Operator, data volume, generated
environment, sensitive install log, and attempted the network, but left the
other four recorded Worker containers. After those exact run-owned containers
were removed, `agentteams-net` remained empty without ownership metadata, so
the Tiangong wrapper correctly refused a broad second uninstall. The empty
exact network and residual generated runtime directory were then removed.
Final remediation proof: zero `agentteams-*` containers, no `agentteams-net`, no
`tiangong-agentteams-data`, no generated Manager environment, and no sensitive
installer log. This environment reset does not upgrade either the functional or
cleanup verdict.
