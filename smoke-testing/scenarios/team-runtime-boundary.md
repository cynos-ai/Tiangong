# Team runtime boundary smoke scenarios

## Ownership

- Related implementation: `worker/`, `smoke-testing/support/run-team-runtime-smoke.sh`, and the pinned AgentTeams Team contract
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`
- Related state/Evidence: Team/member resource state, authenticated Matrix room membership, role environment facts, Tiangong Harness marker, member-local Evidence chains, and cleanup proof
- Update triggers: changes to the AgentTeams Team schema, Team member container naming, role injection, Matrix topology, OpenClaw channel readiness, Tiangong Harness selection, Worker state roots, or Team deletion behavior

## Boundary truth table

| Boundary | Intended observation | Rejected shortcut |
|---|---|---|
| Leader runtime | explicit fixture contract + actual `tiangong-worker:dev` container + OpenClaw health + `team_leader` role fact + Tiangong Harness | lossy synthesized Leader `runtime`/`image` fields or Team `Active` alone |
| Worker runtime | explicit `openclaw` + `tiangong-worker:dev` + `worker` role fact | model self-identification |
| Team room | Leader and Worker joined; Manager absent | room ID existence alone |
| Leader room | Manager and Leader joined | Matrix invite without channel readiness |
| Worker room | Leader and Worker joined; Manager absent | prose claiming delegation |
| Harness | real read completion and `harness=tiangong-pi` for each member | OpenClaw health alone |
| Restart | role facts, required rooms, and prior Evidence terminal hash persist | container running alone |
| Cleanup | Team, both containers, exact reserved Matrix aliases, and exact reserved storage prefixes absent | successful delete command alone |

## Basic smoke

### B1: Custom Tiangong Leader and Worker in an AgentTeams Team

- Purpose: Prove that the pinned AgentTeams stack can run both the required Team Leader and one Team Worker with Tiangong's public image and OpenClaw runtime without falling back to a stock Agent Harness.
- Target resources:
  - Team `tiangong-team-smoke`;
  - Leader `tiangong-team-smoke-leader`;
  - Worker `tiangong-team-smoke-engineer`;
  - only their exact Agent and Team storage prefixes.
- Setup:
  1. deterministic Team smoke contract tests pass;
  2. `make verify` passes;
  3. reserved resources do not exist;
  4. build `tiangong-worker:dev`;
  5. apply `smoke-testing/fixtures/pi-smoke-team.yaml`.
- Prompts:
  1. Manager mentions the Leader in the Leader's room and requests one gated read of a random Leader-local probe;
  2. Leader mentions the Worker in the Worker's room and requests one gated read of a random Worker-local probe.
- Expected observations:
  - Team reaches `Active` with one ready Leader and one ready Worker;
  - the Worker synthesized resource retains the explicit image and `runtime=openclaw`;
  - the Leader's actual container uses `tiangong-worker:dev`, OpenClaw is healthy, and the Tiangong Harness handles its real turn; its known lossy synthesized runtime/image projection is recorded but is not accepted as runtime truth;
  - container environment exposes `team_leader` only to the Leader and `worker` to the Worker;
  - Team room, Leader room, and Worker room membership match the delegation boundaries in the truth table;
  - both Matrix turns use the Tiangong Harness and produce one successful read completion in the correct member-local Evidence chain;
  - after sequential member restarts, required room joins and role facts return, and the prior Evidence terminal hashes are unchanged;
  - cleanup removes only the reserved Team, member containers, copied helpers, two exact reserved Matrix aliases, and exact reserved storage prefixes.
- Required evidence:
  - `member_team_leader_runtime=pass` and `member_worker_runtime=pass`;
  - three `matrix_room_*_topology=pass` observations;
  - `team_leader_matrix_to_pi=pass` and `team_worker_matrix_to_pi=pass`;
  - `team_leader_restart_persistence=pass` and `team_worker_restart_persistence=pass`;
  - `matrix_alias_team_cleanup=pass`, `matrix_alias_leader_dm_cleanup=pass`, Team/member absence, and empty exact prefixes during cleanup.
- Skip/block rules:
  - block if Docker, the pinned AgentTeams stack, Gateway model, Matrix, reserved identity ownership, or required public image is unavailable;
  - refuse to replace any existing reserved Team, synthesized member, or container;
  - do not use model prose as role, topology, execution, restart, or cleanup evidence;
  - do not broaden cleanup from the three fixed storage prefixes.

## Full smoke

No Full scenario is defined in this phase. Work Ledger, Assignment/Result protocols, approvals, independent Review, and Leader failover are outside this runtime-boundary spike.

## Maintenance notes

- **Current pinned-stack status (2026-07-26): BLOCKED.** AgentTeams `v1.2.0-beta.1` drops inline `leader.runtime` and `leader.image` at the embedded Team HTTP request boundary, and its installed Team CRD schema also omits and prunes those fields. Direct config publication therefore cannot bypass the blocker. Keep the actual-image assertion red until a reviewed public release provides the decoupled Worker + `Team.spec.workerMembers` contract already present on upstream `main`. See `smoke-testing/runs/2026-07-26-team-runtime-boundary/plan.md`.
- The fixture intentionally does not enable AgentTeams packages, Skills, or MCP servers. Tiangong's runtime continues to disable automatic discovery.
- The Team uses the legacy inline `leader` / `workers` schema because AgentTeams `v1.2.0-beta.1` assigns member roles and creates both containers on that path. This smoke records the pinned platform contract; it does not make the deprecated schema a Tiangong product API.
- In that pinned version, the aggregated Worker API hardcodes a legacy Team Leader response to `runtime=copaw` and omits its image even when `spec.leader.runtime` and `spec.leader.image` create the requested container. The smoke records this compatibility limitation and verifies actual selection from the fixture, container image/environment, OpenClaw health, and real Tiangong Harness execution.
- The pinned legacy Team delete path does not remove the Team and Leader-DM Matrix aliases. The test-only cleanup helper logs in as the configured local Admin inside the Controller container, removes only those two hard-coded reserved aliases, logs out, never prints the token, and keeps cleanup failure red. This is cleanup support, not Tiangong runtime ownership of Matrix.
- Runtime/model responses prove only real integration. Role, image, topology, Evidence, and cleanup assertions are deterministic machine observations.
