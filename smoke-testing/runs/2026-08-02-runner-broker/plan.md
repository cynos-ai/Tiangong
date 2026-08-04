# Closed Runner broker focused run

> Date: 2026-08-02
>
> Status: **PASS at the closed broker and ChangeRevision materialization boundary**
>
> Promotion: durable Basic B3; official AgentTeams/Matrix professional-tool proof remains blocked

## Purpose

Move Docker authority out of the model-facing Worker without mounting the Docker socket into an AgentTeams-managed container. The controlled broker is the only component with the socket. It authenticates the source container from daemon-owned network and container facts, binds execution to one Worker, Task, deterministic task run ID, immutable Worker/runner images, fixture, revision dependency, and invocation, then delegates to the disposable executor. A successful Implementor command seals one bounded writable fixture copy; the bound Assessor receives a fresh read-only materialization of that exact digest.

This run deliberately uses a Worker-image client container rather than claiming an official AgentTeams Worker turn. It proves the adapter topology and machine authorization boundary. A later Full run must still exercise `run_command` and `run_test_command` from authenticated Matrix turns in the real Team.

## Implementation under test

- `worker/agent/runner/broker-client.mjs`
- `worker/agent/runner/broker-server.mjs`
- `worker/agent/runner/docker-executor.mjs`
- `worker/agent/runner/journal.mjs`
- `worker/agent/runner/runner-port.mjs`
- `worker/agent/runner/revision-store.mjs`
- `worker/agent/work/member-tools.mjs`
- `worker/Dockerfile` target `runner-broker`
- `smoke-testing/support/run-runner-broker-smoke.mjs`

## Boundary truth table

| Source / request | Expected execution | Expected result |
|---|---|---|
| Registered container IP, name, running state, Worker image/name, Task, run and invocation | One seed and one command container | Completed result with runner machine Evidence |
| Same invocation through a fresh client journal | None | Broker journal replays the saved completed result and immutable ChangeRevisionRef |
| Bound Assessor Task after sealing | Fresh seed and command containers over an independent copy | Fixture digest equals the Implementor artifact digest; authoritative revision remains read-only |
| Assessor before its Implementor dependency, wrong revision, or changed digest | None | Config, materialization, or Result binding rejects fail-closed |
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
- `runner_broker_revision_sealed=pass` with artifact digest `4c4f11dc044fdbee8440e51becc2dc147c4b297eed02f28a31c070e83312ddc2`
- capture-mode runner policy digest `e859771496de11924ddb50d842d9a59a0b9a650316efd9c6dc12ded3b1616b5e`
- `runner_broker_replay=pass`
- `runner_broker_assessor_materialization=pass`
- `runner_broker_assessor_readonly=pass`
- `runner_broker_single_execution=pass`
- `runner_broker_unauthorized_peer=pass`
- `runner_broker_worker_socket_absent=pass`
- `runner_broker_cleanup=pass`

The Implementor daemon event stream contained exactly one labeled seed-container create and one labeled command-container create, including the fresh-journal replay. Its bounded scratch tmpfs was exported only after the command exited and no command process remained; the broker independently validated the bounded archive before sealing an immutable record. The Assessor then received a separate fixture volume whose digest exactly matched the sealed artifact, and its write attempt failed. The unauthorized adjacent client produced no runner create event. Both runners retained the credential, socket, read-only root, bounded scratch, resource, and `network=none` boundaries from B2.

## Authority and cleanup

The broker image pins the public Docker CLI image by digest. Only the controlled broker mounts `/var/run/docker.sock`; it has a read-only root, dropped capabilities, `no-new-privileges`, bounded CPU/memory/PIDs, one read-only config, one read-only fixture mount, and one run-owned state volume. The client has no socket mount.

The run refuses pre-existing reserved names. Broker, Implementor client, Assessor client, intruder, state volume, and unique network carry the exact run ownership label. Cleanup inspects that label before removal, removes no foreign resource, verifies each owned resource is absent, and removes the temporary non-secret registration file.

## Honest limit and next step

The broker is authenticated by daemon-owned source-container facts rather than a bearer secret, so no platform credential crosses into it. The broker itself is a privileged control component because it owns Docker authority; it is not a sandbox and is never model-facing. This run proves local ChangeRevision sealing, immutable one-Task ownership, exact-digest Assessor materialization, and read-only assessment. It does not prove AgentTeams reconciliation, a real Matrix-triggered professional turn, or model selection of the command. The next Full boundary is an official Implementor/Assessor Team turn using the fixed RoleProfile tools, accepted Task-chain binding, and durable Worker Evidence projection.
