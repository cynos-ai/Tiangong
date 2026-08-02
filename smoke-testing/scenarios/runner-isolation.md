# Disposable runner isolation smoke scenarios

## Ownership

- Related implementation: `worker/agent/runner/runner-port.mjs`, `worker/agent/runner/runner-policy.mjs`
- Related fixtures and driver: `smoke-testing/fixtures/runner-isolation/`, `smoke-testing/support/run-runner-isolation-spike.sh`
- Related state/Evidence: Docker daemon container configuration, bounded probe result, and cleanup absence
- Update triggers: RunnerPort policy, runner image, mount/network topology, credential allowlist, or executor ownership changes

## Basic smoke

### B1: Run a bounded fixture command in a disposable isolated container

- Purpose: prove the declared RunnerPort isolation contract is feasible with the actual Tiangong Implementor image before enabling a production executor.
- Setup: build `tiangong-worker-implementor:dev`; Docker must be available. The driver resolves the mutable development tag to an immutable local image ID before container creation.
- Prompt: none. Run `make test-runner-isolation`.
- Expected observations:
  - the Docker daemon configuration has `network=none`, read-only root filesystem, all capabilities dropped, `no-new-privileges`, bounded memory/PIDs/CPU, and a non-root user;
  - exactly one read-only fixture volume and one writable run-owned scratch volume are mounted; the host repository and temporary directory are not mounted;
  - the fixture command reads its input, cannot modify the fixture or root filesystem, writes only its result in scratch, sees no forbidden credential keys or container-runtime socket, has only loopback networking, and cannot resolve control-plane names;
  - the container and scratch directory are removed.
- Required evidence:
  - `runner_daemon_policy=pass` from inspection of the daemon-owned configuration;
  - `runner_probe=pass` from the executed fixture;
  - `runner_machine_evidence=pass` bound to the run ID and immutable image ID;
  - `runner_cleanup=pass` plus absence of the exact run-owned container.
- Skip/block rules: block if Docker, the image, policy module, or fixture is unavailable. Never inject host credentials to test their absence. Any cleanup failure keeps the smoke red.

### B2: Docker executor preserves the proven boundary

- Purpose: execute the production Docker executor module, rather than a parallel shell implementation, against the same isolation fixture.
- Setup: build `tiangong-worker-implementor:dev`; Docker must be available. Run `make test-runner-executor`. The smoke resolves the mutable development tag to an immutable daemon image ID before constructing the executor.
- Prompt: none.
- Expected observations:
  - the executor creates one uniquely named/labeled fixture volume plus seed and command containers; command scratch is a bounded 64 MiB tmpfs rather than an unbounded daemon volume;
  - it copies only the validated fixture tree, independently revalidates and digest-binds the copied volume before command start, rejects links and unsupported entries, and never replaces a pre-existing resource;
  - the command container matches the B1 network, root filesystem, capability, privilege, resource, user, tmpfs, mount, workdir, and environment boundaries before it starts;
  - RunnerPort receives invocation-bound image, policy, copied-fixture, and container-configuration digests;
  - the append-only hash-chained runner journal records `executing` before command start, replays a completed result, and blocks replay of an interrupted command;
  - a timed-out command becomes durably `outcome_uncertain` rather than being reported complete;
  - both completed and interrupted invocations remove their exactly owned containers and fixture volume and verify absence.
- Required evidence:
  - `runner_executor_daemon_policy=pass`;
  - `runner_probe=pass`;
  - `runner_executor_machine_evidence=pass` with run ID, immutable image ID, policy digest, copied-fixture digest, and configuration digest;
  - `runner_executor_journal=pass`;
  - `runner_executor_timeout_uncertain=pass`;
  - `runner_executor_cleanup=pass`.
- Skip/block rules: block if Docker, the immutable image, or the fixture is unavailable. This proves the executor module on the local Docker boundary; it does not prove an authenticated Worker-to-executor adapter or make the tools model-accessible.

### B3: Closed Runner broker keeps daemon authority outside the Worker

- Purpose: prove the supported socket topology: only a controlled broker receives Docker authority, while an exact Worker-image client reaches it through a task-bound HTTP adapter.
- Setup: build `tiangong-runner-broker:dev` and `tiangong-worker-implementor:dev`; run `make test-runner-broker` on a fresh, uniquely labeled network, broker state volume, broker container, and client identities.
- Prompt: none.
- Expected observations:
  - the broker authenticates the request source by exact Docker network IP, container name, running state, immutable Worker image ID, and `AGENTTEAMS_WORKER_NAME` runtime fact;
  - request Task, derived run ID, invocation key, command bounds, and sanitized environment match the immutable broker registration;
  - only the broker has the Docker socket; the Worker-image client and disposable command runner do not;
  - one authorized request executes the isolation probe, while a fresh client journal re-request is replayed by the broker journal with exactly one seed and one command-container create event total;
  - an adjacent container on the same network is rejected before execution;
  - all exactly owned containers, volume, network, and temporary config are removed and absence is verified.
- Required evidence:
  - `runner_broker_ready=pass`;
  - `runner_broker_client=pass` and invocation-bound `runner_broker_evidence=pass`;
  - `runner_broker_replay=pass` and `runner_broker_single_execution=pass`;
  - `runner_broker_unauthorized_peer=pass`;
  - `runner_broker_worker_socket_absent=pass`;
  - `runner_broker_cleanup=pass`.
- Skip/block rules: block if Docker, either immutable local image, or socket access for the controlled broker is unavailable. This proves the closed container identity and execution topology, not an official AgentTeams/Matrix Worker turn.

## Full smoke

### F1: Production executor preserves the same boundary

- Purpose: prevent the eventual RunnerPort executor from weakening the proven spike configuration.
- Setup: a production executor is wired through a closed, authenticated adapter and owns a unique run ID.
- Prompt: submit one allowed Implementor or Assessor fixture command and one request containing a forbidden environment key or unauthorized mount/network capability.
- Expected observations:
  - the allowed request produces the same daemon, probe, machine-evidence, and cleanup facts as B1;
  - the forbidden request is rejected before container creation and produces no side effect;
  - replay returns the saved terminal result without creating another container;
  - an interrupted execution becomes `outcome_uncertain` and is not retried automatically.
- Required evidence: invocation-bound Gate decision, container identity/config digest, execution result digest, replay or uncertain journal state, and cleanup proof.
- Skip/block rules: this scenario remains blocked until an official authenticated AgentTeams/Matrix Implementor and Assessor turn reaches the now-materialized professional-role tools through the broker. B1 proves feasibility, B2 proves the local executor, and B3 proves the closed container-identity broker; none alone is model-tool proof.

## Maintenance notes

- Keep model prose, RunnerPort state, Docker execution, and cleanup as separate facts.
- Derive forbidden environment names and network targets from `runner-policy.mjs`; do not maintain a divergent smoke allowlist.
- B1 seeds run-owned named volumes through a labeled setup container because host bind-mount visibility varies across Docker contexts. B2 narrows this further: the command runner receives one read-only fixture volume and a bounded writable scratch tmpfs.
- Do not mount the Docker socket, AgentTeams storage, Worker home, provider config, deployment target, or Collector credentials into the runner.
