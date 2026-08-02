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
- Skip/block rules: this scenario remains blocked while RunnerPort has no production disposable executor. The Basic feasibility spike must not be promoted to production-executor proof.

## Maintenance notes

- Keep model prose, RunnerPort state, Docker execution, and cleanup as separate facts.
- Derive forbidden environment names and network targets from `runner-policy.mjs`; do not maintain a divergent smoke allowlist.
- Seed run-owned named volumes through a labeled setup container because host bind-mount visibility varies across Docker contexts; the command runner still receives only the read-only fixture and writable scratch volumes.
- Do not mount the Docker socket, AgentTeams storage, Worker home, provider config, deployment target, or Collector credentials into the runner.
