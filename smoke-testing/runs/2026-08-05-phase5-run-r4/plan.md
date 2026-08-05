# Phase 5 Run R4 — one revision followed by safe rollback

> Date: 2026-08-05
> Level: focused Full AgentTeams/Matrix/Runner/deployment integration
> Status: PASS (machine FAILED_SAFE; exact cleanup pending)

## Scope

Fresh exact-scope Team `tg-p5r4-08050800`, five Workers, fixed Runner broker,
new Project, approval state, Evidence root, and a fault-injected disposable
deployment target. No previous run state is reused. The provider/model and
fixed Runner command remain unchanged.

## Bounded revision fixture

Revision 0 is intentionally not final: the machine-bound acceptance criterion
requires `revisionIndex >= 1`. The first Assessor must return one revision
request for that criterion. At revision 1 the same criterion is satisfied by
the immutable Task revision index, so the Assessor must accept the exact
revision and the Leader must continue to Release. This tests a single legal
revision transition without changing the Runner command or fabricating a
Result.

The read-only readiness probe must pass before the first Task notification.
After the revision-1 Assessor Result is accepted, a deterministic post-verify
fault is installed in the run-owned target. The authorized approval must yield
`FAILED_SAFE` after one rollback and healthy previous-digest verification.

## Machine result

The corrected chain produced one legal revision wave followed by a terminal
safe rollback:

- Design revision 0: accepted.
- Implement revision 0: accepted.
- Assessor revision 0: `revision`.
- Implement revision 1: accepted.
- Assessor revision 1: `accept`, binding the revision-1 Implementor artifact.
- Release revision 1: accepted with deployment outcome `FAILED_SAFE`.
- Release outcome: `postVerifyHealthy=false`, `rollbackPerformed=true`, and the
  target ended at the previous digest after healthy previous-digest verification.
- Target journal: one initialization, one stage, one activation, one failed
  post-deploy verification, one rollback, and one healthy previous verification.
- Approval ID `approval-d10e8e39bcf4c01e39268b33`: one pending → approved →
  executing → completed identity with operation digest
  `484ba28063097655907171c501bb1e919601044664f8fc210d62d8979f3dbb92`.
- Terminal report digest:
  `3801eb089c72c065deb0629813ec1fc17e59dbbfd245ea72366ca2fcfe1eee8a`.

The independent verifier passed with `taskCount=6` and expected disposition
`FAILED_SAFE`. Its sanitized output is preserved as `verify.json` in this run
directory.

## Stop and cleanup

Any missing binding, revision, approval, deployment, rollback, Evidence,
report, or cleanup fact is fail-closed. Preserve AgentTeams-owned
Project/Task records; never uninstall/rebootstrap local AgentTeams.

Cleanup passed after evidence capture: the exact target/broker containers and
three capability/config/state volumes, Runner broker and three volumes, Team,
five Workers, cleanup helper, exact Worker containers, and temporary manifests
were absent. The six AgentTeams-owned Project/Task records are retained under
the authority boundary.
