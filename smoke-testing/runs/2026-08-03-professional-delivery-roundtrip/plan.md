# Professional delivery roundtrip

> Date: 2026-08-03
> Level: focused real integration prerequisite and Full-path continuation
> Status: BLOCKED (AgentTeams Manager readiness)

## Scope

Continue the successful real Designer → Implementor → Assessor revision proof
through Operator approval, deployment, post-deploy verification, accepted
release Result, Leader terminal disposition, and requester Matrix delivery.
This run may claim `DELIVERED` only when all of those machine facts exist.

Provider/model: configured AgentTeams `openai-compat` provider with
`deepseek-v4-flash`. No provider, model, prompt, fixture, or timeout substitution
is allowed after the run starts.

## Prerequisites and owned resources

- Deterministic Worker suite: 288 tests passed at source commit `552ca21`.
- Rebuild the Leader, four professional Worker, Runner broker, deployment
  broker, and deployment service images from that commit.
- Require `make verify` before creating any Team or Project.
- The run owns only the newly installed local AgentTeams stack and any uniquely
  named Team, Project, broker, target, state volume, and config volume created
  after readiness passes.
- Installer output and generated environment files are sensitive and must stay
  owner-only and outside Evidence.

## Required proof

1. Active Team with complete five-role roster and converged peer policy.
2. Accepted immutable Design, Implement, and Assess Task chain.
3. Exact sealed revision independently verified by Assessor.
4. Operator deployment plan bound to the accepted release Task, target,
   previous digest, revision, and configured explicit approver.
5. Authenticated explicit approval before activation.
6. Durable target journal proves stage, activate, and healthy post-deploy
   verification; broker receipt and release Result bind the same outcome.
7. Leader accepts the release Result, derives `DELIVERED`, and sends the
   immutable terminal report to the original authenticated requester.
8. Matrix delivery and durable Evidence both prove notification.
9. Exact cleanup is verified; cleanup failure keeps the run failed.

## Fail-closed rules

- Do not create the Team while Manager readiness is false.
- Model prose, image build success, target-only activation, or an unaccepted
  release Result cannot establish `DELIVERED`.
- Missing approver identity, broker binding, target precondition, revision
  digest, Evidence, or requester binding blocks the run before side effects.
- Stop on the first failed prerequisite and clean only recorded owned resources.

## Observed result

The checksum-verified AgentTeams v1.2.0 installer started the controller,
Manager, Matrix, object storage, gateway, and dashboard. Generated credential
files and the upstream install log had owner-only mode `0600`. The installer
then timed out waiting for `welcomeSent=true`. A separate `make verify` observed
all service-level HTTP and storage checks passing but again reported Manager
readiness false.

One authenticated admin message was sent to the Manager DM as the documented
onboarding trigger. The authoritative Manager resource remained `Running` with
`welcomeSent=false` for the bounded wait. No Team, Project, Task, broker,
deployment target, approval, or release side effect was created.

Classification: **readiness / upstream environment**, high confidence. The
professional images rebuilt successfully, including the Operator image with
`deploy_release` and fixed AgentTeams explicit-approver discovery. The isolated
deployment target smoke separately passed ready, authorized activate/verify,
unauthorized rejection, machine-state digest checks, and exact cleanup. These
facts do not replace the blocked real Team path.

Result: **BLOCKED**, not `DELIVERED`. The run stopped after the repeated
readiness failure. `make uninstall` removed the owned stack, runtime state,
generated environment file, sensitive upstream install log, network, and data
volume successfully.

## Smallest follow-up

Diagnose the Manager onboarding/readiness boundary using bounded sanitized
status facts before another Full attempt. Do not change the professional
workflow, deployment target, provider/model, or Runner fixture without evidence
that one of those layers caused this readiness failure.
