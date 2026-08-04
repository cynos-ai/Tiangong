# RunnerPort disposable-container isolation spike

> Date: 2026-08-02
> Level: focused Basic feasibility spike
> Overall verdict: **FAIL — isolation boundary passed; owned AgentTeams stack cleanup first attempt failed**
> Promotion: no production executor claim

## Scope and contract

Prove that the Phase-1 RunnerPort isolation declaration is feasible with the actual Tiangong Implementor image built on the pinned AgentTeams v1.2.0 Worker base. This run does not wire or claim a production RunnerPort executor.

Owning contracts:

- `worker/agent/runner/runner-policy.mjs`
- `worker/agent/runner/runner-port.mjs`
- `smoke-testing/scenarios/runner-isolation.md` B1

No model or provider call is part of this scenario. The AgentTeams control stack was locally active during the passing probe. The runner received no host/provider credentials.

## Owned resources

- Runner identity: `run-073547f9-2a9c-4397-a658-df16f5b5e9e9`
- Runner container prefix: `tiangong-runner-spike-`
- Setup container prefix: `tiangong-runner-seed-`
- Fixture/scratch volume prefixes: `tiangong-runner-fixture-`, `tiangong-runner-scratch-`
- All runner resources required exact `io.tiangong.owner=runner-isolation-spike` and matching run-ID labels.
- A dedicated local AgentTeams stack was created as the live control-plane precondition because the preflight `make verify` showed no stack.

Cleanup could remove only the exact names above with matching labels. Stack cleanup could remove only the Tiangong-owned v1.2.0 manager/controller/network/volumes and `.runtime/agentteams` targets.

## Execution and observations

### Preflight

- `make verify`: blocked because the previously reset AgentTeams stack was absent.
- `make up`: v1.2.0 controller, manager, Matrix, MinIO, Gateway, consoles, and Dashboard started; Manager `welcomeSent` did not become ready within 120 seconds, so the setup command remained failed.
- The runner boundary did not require Manager model readiness. It required a live control plane to test the no-network boundary.

### Driver findings before the proving run

1. The policy-export helper initially used invalid dynamic-import syntax. Classification: test driver. No runner resource was created; cleanup passed.
2. Docker Desktop's daemon namespace could not see a newly created WSL subdirectory as a bind source. Classification: adapter/host contract. The driver switched to two run-owned named volumes seeded by a labeled, networkless setup container; it did not weaken the runner mount boundary.
3. The first daemon-policy oracle had an invalid jq expression. Classification: test oracle. A bounded diagnostic containing environment key names—not values—and mount policy facts identified the error.
4. Docker copy did not retain a runner-writable scratch result mode. Classification: setup adapter. The networkless setup container now changes only the pre-created result file mode before disposal.

### Passing runner boundary

Command: `make test-runner-isolation`

Machine evidence:

```text
runner_daemon_policy=pass
runner_probe=pass
runner_machine_evidence=pass run_id=run-073547f9-2a9c-4397-a658-df16f5b5e9e9 image_id=sha256:25e3e18146710098ff16ebd41587dea2d73901062197be3942b1e4cdd1fe5568
runner_cleanup=pass
```

The daemon-owned configuration proved:

- immutable local image ID;
- non-root `1000:1000` execution;
- `network=none`;
- read-only root filesystem;
- all capabilities dropped and `no-new-privileges`;
- 128 PID, 256 MiB memory, and one-CPU limits;
- exactly one read-only fixture volume and one writable scratch volume;
- no RunnerPort-forbidden environment key names.

The executed probe proved:

- exact fixture bytes were readable;
- fixture and root writes were rejected;
- only the pre-authorized scratch result was writable;
- `/var/run/docker.sock` was absent;
- only loopback interfaces existed;
- every RunnerPort-forbidden control-plane name was unresolvable;
- the result was bound to the run ID and fixture digest.

All exact runner containers and volumes were absent after the command.

## Deterministic verification

- Focused RunnerPort tests: 8 passed.
- Complete Worker suite: 245 passed.
- Repository policy, AgentTeams bootstrap contract, peer-mention contract, Reviewer smoke contract, and Skill validation passed.
- Bash syntax and ShellCheck 0.10.0 passed for all 21 repository shell entry points.

## Cleanup and verdict

The upstream AgentTeams uninstaller removed controller, Dashboard, data volumes, and generated credential state, but `agentteams-manager` restarted before the wrapper's absence check. The wrapper therefore correctly returned failure. A subsequent exact dedicated-stack reset validated the v1.2.0 manager image and Tiangong runtime mounts, then removed the remaining manager, network, and runtime tree. Final absence checks passed.

Per cleanup discipline, the later reset does not upgrade the original run verdict: this focused run remains **FAIL**. The RunnerPort isolation feasibility boundary itself is **PASS** and may inform the frozen executor topology. The production executor, RunnerPort invocation Evidence, replay, and interrupted-command behavior remain **BLOCKED/not proven in smoke**.

## Follow-up

1. Wire a closed runner controller/adapter without exposing the container-runtime socket to Implementor or Assessor Workers.
2. Bind the proven image/config/mount policy digest to each RunnerPort invocation and Evidence record.
3. Run durable scenario F1 for allowed, forbidden, replay, interruption, and cleanup paths.
4. Fix and regress the upstream-uninstall manager recreation race separately; do not rewrite this run as green.
