# Phase 5 Run R2 — revision and safe rollback

> Date: 2026-08-05
> Level: Full real AgentTeams/Matrix/Runner/deployment integration
> Status: PARTIAL (safe rollback passed; revision branch not exercised)

## Scope

Fresh exact-scope Team `tg-p5r2-08050645`, five role-scoped Workers, a fixed
Runner broker, a disposable fault-injected deployment target, approval state,
and Evidence root. The model/provider, role images, Runner fixture, and
`[node, probe.mjs]` command remain the same as the prior Run R. No prior
Project, Task, Result, approval, journal, target, or artifact may be reused.

## New lower-layer evidence

Before this run, the focused readiness run
`smoke-testing/runs/2026-08-05-professional-readiness-probe/plan.md` passed:
AgentTeams phase/roster, five Worker containers, OpenClaw health, room
bindings, and authenticated five-member Team-room membership were all verified.
The same read-only readiness probe is required before the first Task
notification in this run.

## Functional contract

The first wave was expected to reach an independent `REVISION_NEEDED`
assessment. A new Implementor/Assessor wave would then bind a new revision
digest. The final Operator release must remain pending until the configured
explicit subject approves the exact operation. A deterministic post-verify
fault must roll back once and verify the previous digest, yielding
`FAILED_SAFE`; rollback uncertainty must remain `RECOVERY_REQUIRED`.

## Machine result

The initial prompt used an incorrect Worker-name projection and was rejected
before Project/Task persistence. A corrected prompt used the exact five Worker
names; the corrected Project/Task chain then persisted and passed the
Designer → Implementor → Assessor → Operator path.

Machine facts for the corrected Project `p5r2-08050645-project-corrected`:

- Design Result digest:
  `68f557c88588c134468fa31eee18a22fe51704743d07dc86d4002bb4ef909011`;
  decision `accept`.
- Implement Result digest:
  `e45e80cdd83da48638ad07072f7019537b0b2cce3f02385524b4c1913bcf03d2`;
  sealed artifact digest:
  `5b38a3123ef7417e73e9892bc260a4d9f362096c548c0e9e5139c6ff181dbd62`;
  decision `accept`.
- Assessor Result digest:
  `f6b169916fc0b7927d05ae4ff898d3c235dd579b821a63b8a475955b1a301627`;
  it bound the same artifact and decision `accept`.
- Release Result digest:
  `7010fa50047c8facb4e16747397ec61a39bdd07ce757b1076797b06cf263fe4e`;
  outcome disposition `FAILED_SAFE`, `postVerifyHealthy=false`,
  `rollbackPerformed=true`, and final target digest equal to the previous
  digest.
- The target journal contained one initialization, one stage, one activation,
  one failed post-deploy verification, one rollback, and one healthy previous
  verification.
- Approval ID `approval-6418ffebbf5af13ac5334ca4` had one pending → approved →
  executing → completed operation identity. The authorized explicit subject
  was the only member of the Operator personal room besides that Worker.
- Terminal report digest:
  `b624c9893f3da1618cefb5c2c9b0e30ccfc87bd4bcddca03e6f2b0d5a4634885`
  and disposition `FAILED_SAFE`; requester delivery Evidence was present.

The independent verifier passed with expected disposition `FAILED_SAFE`.
However, the Assessor accepted the first revision rather than producing
`REVISION_NEEDED`, so this run does **not** close the revision-wave portion of
Phase 5.

## Stop and cleanup

Any missing readiness, binding, Result, approval, deployment, rollback,
Evidence, requester report, or cleanup fact is fail-closed. Do not resend a
consumed event or retry a failed professional operation. Clean only exact
run-owned resources, using the supported AgentTeams membership cleanup when
necessary; never uninstall/rebootstrap local AgentTeams or delete shared
`projects/`/`tasks/` authority.

Cleanup passed after evidence capture:

- exact target and broker containers and their capability/config/state volumes:
  absent;
- exact Runner broker container and three labeled volumes: absent;
- Team `tg-p5r2-08050645`, all five exact Workers, cleanup helper, and exact
  Worker containers: absent;
- AgentTeams-owned Project/Task records for the corrected Project: retained
  under the authority boundary.

The run remains **PARTIAL/FAIL-CLOSED**: the safe rollback branch is proven,
but the required first-wave `REVISION_NEEDED` and second revision wave were
not exercised. This is not a complete Phase 5 F2 pass.
