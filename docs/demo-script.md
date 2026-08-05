# Five-role delivery demo script

This is a 5–10 minute, evidence-first walkthrough of the current Tiangong
runtime. It is deliberately separate from a claim that a real deployment is
safe for production.

## Preparation

```bash
make up
make verify
make check-demo-contract
make build-worker-image
```

`make verify` proves local AgentTeams service readiness. `make check-demo-contract`
verifies the five fixed profiles, closed tool surfaces, Skill bindings,
Playbook lock, and the immutable Runner fixture digest. After a run is paused
for evidence review, verify the preserved shared Project state from a
repository-side diagnostic environment that can read the shared root, without
trusting model prose:

```bash
make verify-professional-state ROOT=<shared-root> \
  PROJECT=<project-id> EXPECTED=DELIVERED
```

Add repeatable `EVIDENCE=<file>` arguments through the Make target to verify
hash-chained Evidence files. The image build checks
Node/pi versions, profile materialization, Runner and deployment image
boundaries, and the closed Leader/member registries.

## Deterministic safety proof

```bash
npm test --prefix worker
make test-phase4-recovery
```

Show the revision-wave, exact digest binding, rollback, `FAILED_SAFE`,
`RECOVERY_REQUIRED`, and Leader-restart assertions. These facts are shown by
machine state, not by model prose.

## Run S: accepted delivery

Use a fresh five-role Team and the real Matrix/AgentTeams path. The requester
starts one Project; the Leader dispatches Designer, Implementor, Assessor, and
Operator. The explicit configured subject approves exactly one deployment
operation. Replaying the same approval must return the saved result without a
second activation.

The reviewed machine result is recorded in:

```text
smoke-testing/runs/2026-08-04-professional-delivery-full-after-cross-turn-approval-dedupe/plan.md
```

The report is valid only because it records Project/Task/Result bindings,
Runner receipts, the deployment journal, approval/idempotency identity,
requester delivery, and exact cleanup separately.

Before sending the first professional Task notification, run the read-only
lower-layer readiness probe and require `professional_readiness=pass`:

```bash
smoke-testing/support/professional-readiness-probe.sh \
  <team> <leader> <designer> <implementor> <assessor> <operator>
```

## Run R: revision and safe rollback

Use different Team, Project, Target, approval, and Evidence identities. Inject
the deterministic post-verify fault in the disposable deployment service. The
expected terminal state is:

```text
new change: not delivered
previous digest: restored and verified
terminal disposition: FAILED_SAFE
```

If rollback or previous-digest verification is uncertain, the only valid
terminal state is `RECOVERY_REQUIRED`.

The durable scenario and truth table are in
[`../smoke-testing/scenarios/professional-delivery.md`](../smoke-testing/scenarios/professional-delivery.md).
A failed run remains red even when later cleanup or a reset removes residue;
inspect the corresponding dated run plan before drawing a conclusion.

## Cleanup and claims

Cleanup must remove only the exact run-owned Team, Workers, Runner/deployment
resources, temporary files, and storage prefix. Verify absence afterward. Do
not delete AgentTeams `projects/` or `tasks/` authority as a shortcut.

F3 acceptance uses safe convergence rather than a promise that a
non-deterministic model repeats one nominal success path. A fresh independent
run is accepted only when it reaches one of these code-owned outcomes:

```text
DELIVERED | FAILED_SAFE | RECOVERY_REQUIRED | FAIL_CLOSED
```

`FAIL_CLOSED` is not a delivery claim. It requires a stable error code, no
approval/deployment/rollback or terminal-delivery side effect, and exact
cleanup. The other three outcomes require their normal Project/Task/Result,
Evidence, and verification facts.

The following are not delivery evidence:

- a model statement that a tool ran;
- a native AgentTeams status without Tiangong bindings;
- a Matrix message without a persisted Result/Evidence record;
- an OTLP or Dashboard trace without the authoritative state transition;
- a successful first run without an independent rerun or safe-convergence
  evidence.

Known local limitations remain explicitly fail-closed: the stock AgentTeams
v1.2.0 stack has a Team/Worker deletion boundary, and controller bearer-token
revocation is unproven. Neither limitation may be rewritten as `DELIVERED` or
as proof that every model-driven rerun must succeed.
