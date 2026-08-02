# Closed Runner broker focused run

> Date: 2026-08-02
>
> Status: **PASS at the closed container-identity broker boundary**
>
> Promotion: durable Basic B3; official AgentTeams/Matrix professional-tool proof remains blocked

## Purpose

Move Docker authority out of the model-facing Worker without mounting the Docker socket into an AgentTeams-managed container. The controlled broker is the only component with the socket. It authenticates the source container from daemon-owned network and container facts, binds execution to one Worker, Task, deterministic task run ID, immutable Worker/runner images, fixture, and invocation, then delegates to the already proven disposable executor.

This run deliberately uses a Worker-image client container rather than claiming an official AgentTeams Worker turn. It proves the adapter topology and machine authorization boundary. A later Full run must still exercise `run_command` and `run_test_command` from authenticated Matrix turns in the real Team.

## Implementation under test

- `worker/agent/runner/broker-client.mjs`
- `worker/agent/runner/broker-server.mjs`
- `worker/agent/runner/docker-executor.mjs`
- `worker/agent/runner/journal.mjs`
- `worker/agent/runner/runner-port.mjs`
- `worker/agent/work/member-tools.mjs`
- `worker/Dockerfile` target `runner-broker`
- `smoke-testing/support/run-runner-broker-smoke.mjs`

## Boundary truth table

| Source / request | Expected execution | Expected result |
|---|---|---|
| Registered container IP, name, running state, Worker image/name, Task, run and invocation | One seed and one command container | Completed result with runner machine Evidence |
| Same invocation through a fresh client journal | None | Broker journal replays the saved completed result |
| Adjacent container on the same network | None | HTTP request rejected; client reports outcome uncertain |
| Wrong Task, run ID or invocation key | None | Broker rejects before executor creation |
| Mutable or mismatched Worker/runner image | None | Config or peer authentication rejects |
| Missing Worker Docker socket | Normal | Worker remains unable to control containers |
| Broker cleanup failure | No PASS | Entire smoke remains red |

## Machine observations

Observed markers:

- `runner_broker_ready=pass`
- `runner_broker_client=pass`
- `runner_broker_evidence=pass`
- `runner_broker_replay=pass`
- `runner_broker_single_execution=pass`
- `runner_broker_unauthorized_peer=pass`
- `runner_broker_worker_socket_absent=pass`
- `runner_broker_cleanup=pass`

The daemon event stream contained exactly one labeled seed-container create and one labeled command-container create for the authorized invocation, including the fresh-journal replay. The unauthorized adjacent client produced no runner create event. The command runner repeated the credential, socket, read-only fixture/root, bounded scratch, resource, and `network=none` probe from B2.

## Authority and cleanup

The broker image pins the public Docker CLI image by digest. Only the controlled broker mounts `/var/run/docker.sock`; it has a read-only root, dropped capabilities, `no-new-privileges`, bounded CPU/memory/PIDs, one read-only config, one read-only fixture mount, and one run-owned state volume. The client has no socket mount.

The run refuses pre-existing reserved names. Broker, client, intruder, state volume, and unique network carry the exact run ownership label. Cleanup inspects that label before removal, removes no foreign resource, verifies each owned resource is absent, and removes the temporary non-secret registration file.

## Honest limit and next step

The broker is authenticated by daemon-owned source-container facts rather than a bearer secret, so no platform credential crosses into it. The broker itself is a privileged control component because it owns Docker authority; it is not a sandbox and is never model-facing. This run does not prove AgentTeams reconciliation, Matrix actor authorization, ChangeRevision materialization, or a model-selected command. The next Full boundary is an official Implementor/Assessor Team turn using the fixed RoleProfile tools and durable Worker Evidence projection.
