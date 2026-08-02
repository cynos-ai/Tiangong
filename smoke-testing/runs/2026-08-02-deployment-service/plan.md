# Focused run — disposable deployment service

> Status: FUNCTIONAL PASS
> Date: 2026-08-02

## Scope

Deterministic Docker proof of the run-owned deployment target boundary. This is
not an Operator approval or `DELIVERED` proof: the Operator broker/tool wiring
and real Team release turn remain pending.

## Contract

- fixed target identity and preloaded previous digest;
- capability stored as a digest in the service config and required exactly once
  on every request;
- bounded `status`, `stage`, `activate`, `verify`, and `rollback` routes;
- append-only, fsynced, hash-chained journal with immutable configuration;
- exact replay for stage/activate/verify/rollback;
- activation precondition and rollback digest bound at stage time;
- deterministic post-verify, rollback, and verify-previous fault modes;
- read-only root filesystem, UID 65532, no capabilities,
  `no-new-privileges`, bounded CPU/memory/PIDs/tmpfs, and an internal Docker
  network;
- no Docker socket and exact owned-resource cleanup.

## Machine observations

- `deployment_service_ready=pass`
- `deployment_service_activate_verify=pass`
- `deployment_service_unauthorized=pass`
- previous digest:
  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- activated and verified digest:
  `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`
- `deployment_service_cleanup=pass`

Unit/contract tests also prove exact replay, stale-precondition rejection,
operation conflict, post-verify failure followed by safe rollback and previous
digest verification, rollback failure, partial-record rejection, tamper
rejection, and immutable service configuration.

## Remaining gate

The service is only the physical target. It does not establish `DELIVERED`
until a real Operator Task binds the accepted ChangeRevision, a configured
explicit subject approves the exact deployment operation, the closed Operator
adapter executes through a peer-authenticating broker, the target reports the
same artifact digest healthy, the release Result is accepted, and the Leader
reports the code-derived terminal disposition to the original requester.
