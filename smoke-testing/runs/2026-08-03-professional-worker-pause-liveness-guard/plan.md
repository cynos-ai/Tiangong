# Paused Worker liveness guard

> Date: 2026-08-03
> Level: focused deterministic smoke-driver regression
> Status: PASS

## Scope

The Full `tg-del6-92f8d9` attempt showed that a Docker-paused OpenClaw Worker
can lose its active gateway connection before unpause. The durable Matrix Task
mention was not replayed into a Tiangong turn. This focused change is limited to
the smoke driver; it does not alter the Worker runtime or claim a production
Channel Plane fix.

## Contract

`smoke-testing/support/pause-worker-until-file.sh` accepts one exact container,
its expected `AGENTTEAMS_WORKER_NAME`, a bounded pause budget of 1–120 seconds,
and a unique `/tmp/tiangong-smoke-*` readiness marker. It:

- verifies the exact container identity and running/unpaused state before pause;
- refuses a pre-existing or symlinked readiness marker;
- pauses only the verified Worker;
- unpauses as soon as the exact `ready=pass` marker appears;
- fails closed on identity, readiness, pause, or unpause failure; and
- always attempts unpause on timeout, signal, or exit.

The future Full orchestration must start this guard before dispatching a Task,
prepare the immutable broker, write the readiness marker only after broker
readiness is machine-proven, and wait for the guard before relying on the
Worker's Matrix notification. It must not resend a Task or notification after a
failed guard.

## Verification

- `bash -n smoke-testing/support/pause-worker-until-file.sh scripts/test-pause-worker-boundary.sh`
- `make test-pause-worker-boundary`
- `git diff --check`

The deterministic test proves the positive readiness path, bounded timeout
cleanup, and exact Worker identity rejection. It uses a fake Docker CLI and no
AgentTeams, Matrix, model, credential, or external resource.

## Result

**PASS / focused orchestration guard only.**

This result authorizes one newly planned Full run only after the run driver is
rewritten to use the guard and all cheaper Worker/image checks pass. It does not
upgrade the failed `tg-del6-92f8d9` run, does not replay its Task, and does not
prove Runner registration ownership or `DELIVERED`.
