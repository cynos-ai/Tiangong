# Software Change Delivery (v1.0.0)

A closed, versioned TeamPlaybook. The Leader binds a Project to this playbook
when it accepts a Human change request; the binding is immutable and the
deterministic `transition-policy` decides which steps are allowed — the model
cannot author new transitions, roles, or permissions.

## Intent

Deliver one software change end to end, with Claim, Machine State, Evidence,
Artifact, and Approval kept as distinct facts:

- **Designer** investigates scope, approach, risks, and the acceptance
  contract, and submits them as the `design` Result.
- **Implementor** modifies code within scope and seals a
  `ChangeRevisionRef`; the `implement` Result carries it.
- **Assessor** independently verifies a read-only materialization of the sealed
  revision against the acceptance contract; its Result carries the exact same
  `ChangeRevisionRef` and supports `accept`, `revision`, or `blocked`.
- **Operator** consumes that same accepted revision, builds, requests approval,
  deploys, post-verifies, and rolls back if needed as the `release` step.

## Coordination contract

- Only the Leader creates and accepts professional Tasks. Workers acknowledge,
  submit Results, or report blockers in their assignment room; chat is never a
  cross-role handoff.
- Handoff is by accepted Result, Artifact ref, and digest only.
- A revision opens a **new** Implementor Task (and a new Assess) at
  `revisionIndex + 1`; a closed Task is never reopened and its Result is never
  overwritten. A prior Assessor conclusion must not be reused for a new
  revision.
- `maxRevisionWaves = 2`. Beyond the limit, a timeout, or an unformable next
  node, the project is `BLOCKED`; it never loops.

## Dispositions

- `DELIVERED` — the new digest is live on the target and verified.
- `FAILED_SAFE` — the change was **not** delivered, but the previous digest is
  restored and verified.
- `RECOVERY_REQUIRED` — an outcome is uncertain or a safe rollback is not
  proven; never reported as completed.

The deterministic transitions and dispositions live in `transition-policy.mjs`;
this document only explains intent.
