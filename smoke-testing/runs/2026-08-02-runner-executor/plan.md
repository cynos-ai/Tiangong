# RunnerPort Docker executor focused run

> Date: 2026-08-02
>
> Status: **PASS at the local Docker executor boundary**
>
> Promotion: production executor module implemented; superseded for adapter status by the later closed-broker run

## Purpose

Replace the shell-only feasibility proof with a code-owned disposable Docker executor behind `RunnerPort`, while preserving the previously proven credential, socket, network, mount, resource, ownership, timeout, Evidence, and cleanup boundaries.

This run does not mount the Docker socket into an AgentTeams Worker and does not claim that a model can reach the executor. AgentTeams v1.2.0 Worker resources have no public custom-volume field. The subsequent B3 broker run therefore keeps Docker authority outside the Worker rather than mutating an upstream-managed Worker container.

## Implementation under test

- `worker/agent/runner/docker-executor.mjs`
- `worker/agent/runner/runner-port.mjs`
- `worker/agent/runner/journal.mjs`
- `worker/agent/runner/runner-policy.mjs`
- `smoke-testing/support/run-runner-executor-smoke.mjs`
- `smoke-testing/fixtures/runner-isolation/`

## Boundary truth table

| Case | Expected Docker side effect | Expected RunnerPort outcome |
|---|---|---|
| Valid fixture, immutable image, matching daemon config | One exact invocation's seed/runner containers and fixture volume; bounded scratch tmpfs; owned resources removed | Durable `executing` → `completed`; exact replay returns the saved result without another container |
| Mutable image tag | None | Constructor rejects before execution |
| Fixture root or entry is a symbolic link | None | Executor throws; RunnerPort fails closed |
| Exact resource name already belongs to another owner | Foreign resource is preserved; no replacement or removal | `outcome_uncertain` |
| Daemon reports a reachable control-plane network instead of `none` | Runner command is never started; owned setup resources are removed | `outcome_uncertain` |
| Image/daemon injects an unexpected environment key | Runner command is never started; owned setup resources are removed | `outcome_uncertain` |
| Executor Evidence uses another invocation key | No additional execution | `outcome_uncertain` with `RUNNER_EVIDENCE_INVALID` |
| Command exceeds its timeout | Runner container is force-removed with exact ownership checks | Durable `outcome_uncertain`; exact replay does not execute |
| Completed invocation is replayed from the journal | No second executor call | Saved completed result with `replayed=true` |

## Machine observations

Focused RunnerPort, journal, and Docker executor tests: **22 passed**.

The real Docker run used the locally built Implementor image resolved to immutable ID:

`sha256:f2897becff4a10266a8f46d87b181eeb38e3d2eceecff349b78804ca91e3ad17`

Observed markers:

- `runner_executor_daemon_policy=pass`
- `runner_probe=pass`
- `runner_executor_machine_evidence=pass`
- runner policy digest `d08931365e2730f966df7744fce5fcad7d3164b2514eab29063e69d97e753ee0`
- copied fixture digest `a1d02f2718b45e2a8013119646d76d5c7bbb7789bfcd60d3207029bd970b2d5f`
- `runner_executor_journal=pass`
- `runner_executor_timeout_uncertain=pass`
- `runner_executor_cleanup=pass`

The executor inspected the daemon-owned command container before start and required:

- immutable image ID;
- `network=none`;
- read-only root filesystem;
- all capabilities dropped and `no-new-privileges`;
- non-root `65532:65532` command identity;
- one CPU, 256 MiB memory, 128 PIDs, and a bounded no-exec tmpfs;
- exactly one read-only fixture volume and one writable, no-exec, 64 MiB scratch tmpfs;
- no forbidden environment key, all known image-level proxy/runtime defaults neutralized, and no runtime socket mount;
- exact run, invocation, owner, policy, and copied-fixture digest labels.

The trusted seed container receives only the run-owned fixture volume, has no network and a read-only root, and temporarily adds only `FOWNER` after dropping all capabilities so copied fixture modes can be normalized. It independently rejects links and unsupported entries, recomputes the copied fixture manifest digest, and must match the pre-copy digest before the command container can exist. It never receives the command or platform credentials.

## Ownership and cleanup

Every daemon resource name is derived from the validated run UUID and invocation digest. Every container and fixture volume carries exact `io.tiangong.owner`, `io.tiangong.run-id`, `io.tiangong.invocation-key`, policy-digest, and fixture-digest labels. Cleanup inspects those labels before removal, refuses foreign resources, and verifies post-removal absence. Both the completed probe and interrupted command left no matching container or volume.

## Honest limit and next step

The Docker executor and append-only, hash-chained runner journal are real and machine-tested. The later B3 focused run now proves the closed container-identity broker, Implementor ChangeRevision sealing, and exact-digest read-only Assessor materialization. Full runner completion remains blocked on an official AgentTeams/Matrix professional-role turn. Directly mounting the Docker socket into each model-facing Worker remains forbidden: the stock Worker CRD cannot express that mount, and changing an upstream-managed container out of band would weaken ownership and reconciliation.
