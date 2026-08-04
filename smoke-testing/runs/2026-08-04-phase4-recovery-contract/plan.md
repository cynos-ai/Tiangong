# Phase 4 recovery contract

> Date: 2026-08-04
> Level: focused deterministic regression plus Leader Basic integration
> Status: PASS for the Phase 4 machine contract

## Scope

This run closes the revision, approval/recovery disposition, idempotency, and
Leader restart boundaries required before Phase 5. It uses a run-owned
filesystem fixture and the public deterministic adapters; no credentials, raw
model transcripts, or unrestricted logs are retained.

## Machine coverage

- Assessor revision opens `implement@1`; the new `ChangeRevisionRef` has a new
  artifact digest and the stale revision cannot be dispatched.
- An exact Implementor Task replay after Leader restart reuses the immutable
  Task binding while the Task is still undecided; it does not create a second
  Task.
- Leader restart after Result submission, after Task creation, and while the
  release Task is awaiting deployment verification reconstructs state from
  durable Project/Task/Result records.
- Approval/deployment replay returns the durable identity and the deployment
  broker performs one operation.
- Post-verify failure with rollback and previous-digest verification produces
  `FAILED_SAFE`; rollback failure or previous-digest verification failure
  produces `RECOVERY_REQUIRED`.
- `FAILED_SAFE` is persisted in the release Result, TransitionDecision,
  Project disposition, terminal report, and hash-chained Evidence; the report
  states that the new change was not delivered.
- Interrupted Runner execution remains `outcome_uncertain` and is not retried.

## Commands and results

```text
make test-phase4-recovery                 PASS (2/2)
npm test --prefix worker                   PASS (262/262) after the RoleProfile/WorkRun clean cut
make test-deployment-service              PASS (readiness, authorization, Evidence, cleanup)
make test-leader-smoke-contract           PASS
make test-leader-image-basic              PASS (functional blocked terminal + requester report)
                                             PASS (manager-aware exact cleanup)
make verify                                PASS
```

The Leader Basic path intentionally ends in the fail-closed
`RECOVERY_REQUIRED` branch; it is not a successful delivery claim. The
revision/rollback/recovery assertions are deterministic and independently
bound to machine state and Evidence.

## Owned resources and cleanup

The real integration attempt owned only the reserved
`tiangong-leader-smoke*` Workers/Team and its discovered Project/Tasks. The
manager-aware cleanup stopped Manager, removed it from the exact Worker rooms,
deleted only the reserved Team, restarted Manager after Team absence, and
verified no reserved Worker records, containers, Project/Task prefixes, or
Team storage remained.

## Limitations

This focused run does not promote model prose to machine evidence and does not
claim a Phase 5 clean rerun, dashboard/Collector evaluation, or public
credential revocation. The local old AgentTeams JWT remains accepted because
no non-destructive upstream revocation mechanism is available.
