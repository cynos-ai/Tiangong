# Focused run — AgentTeams v1.2.0 Leader oracle

> Status: evidence captured
> Date: 2026-08-01
> Branch: `feat/43-agentteams-v1.2-and-leader-spike`
> Scope: capture the real v1.2.0 team-collaboration contract so TeamTaskPort
> and the Tiangong Team Leader are grounded on what the platform actually does,
> not on design-doc aspirations.

## Context

The architecture baseline and the demo plan assumed a structured TeamHarness
`projectflow`/`taskflow` MCP surface (create/plan/delegate/ack/submit/check/
accept/report). This run verifies the actual v1.2.0 behaviour on a live stack
before building TeamTaskPort against it.

## Fixture

A disposable Team on the local v1.2.0 stack:

- `Worker` `tiangong-oracle-leader` — `runtime: openclaw`,
  `image: agentteams-worker:v1.2.0`, `role: team_leader`.
- `Worker` `tiangong-oracle-member` — `image: tiangong-worker:dev`,
  `role: worker`.
- `Team` `tiangong-oracle-team` — `spec.workerMembers` with exactly one
  `team_leader` (the v1.2.0 hard-cut Team model).

Both Workers reached `phase: Running`; the Team reached `phase: Active`. The
v1.2.0 `workerMembers` Team model is confirmed working.

## Observed contract (deterministic inspection of the Running leader)

The stock leader coordinates through **shared files + Matrix @mentions + MinIO
sync**, not a structured Project/Task RPC:

- `mcporter-servers.json` is empty; `openclaw.json` `plugins` contains only
  `matrix` and `memory-core`. **No `projectflow`/`taskflow` MCP server is
  wired into the leader worker.**
- Leader skills actually deployed: `file-sync`, `find-skills`, `mcporter`,
  `project-participation`, `task-progress` — **not** the documented
  `team-coordination` / `project-management` / `task-management`.
- Project = `/root/agentteams-fs/shared/projects/{project-id}/plan.md`;
  Task = `/root/agentteams-fs/shared/tasks/{task-id}/progress/`; state is
  synchronised with `agentteams-sync` (`/usr/local/bin/agentteams-sync`) and
  `mc cp`/`mc mirror`; completion is signalled by @mentioning the coordinator.
- `/opt/openclaw/skills/taskflow` exists in the image but is **not** deployed
  to the leader.

## Gaps vs design docs (step 6)

- `teamharness-boundary-and-contracts.md` lists `projectflow`/`taskflow` MCP
  tools and `teamharness-project-task-runtime-design.md` lists
  `ProjectMeta`/`TaskMeta`/`plan_dag`/`plan_loop`/`check_task`/
  `accept_task_result`. These are **target contracts, not deployed
  implementations** in the v1.2.0 leader.
- **Team cleanup does not cascade**: `agt delete team` (and the REST
  `DELETE /api/v1/teams/<name>`, HTTP 204) does not release `workerMembers`;
  member Workers cannot be deleted (`HTTP 409 worker is a member of team`).
  `PUT` of empty `workerMembers` does not release them either. A disposable
  stack reset (`make uninstall`) is the reliable cleanup path; ad-hoc oracle
  Workers are left in place until then.

## Implication for TeamTaskPort

TeamTaskPort does **not** wrap a `projectflow`/`taskflow` MCP (it does not
exist). Following the architecture baseline §7 / contract §5 contingency, it
is grounded on:

- Tiangong-owned **immutable Project/Task binding manifests** (content digest)
  written to the shared filesystem namespace
  `/root/agentteams-fs/shared/tiangong/`.
- **Authorization** against the immutable `roleBindings` / `assignee` from the
  authenticated Worker identity, never Task prose.
- **@mention + sync** side effects behind injected adapters; **idempotent**
  dispatch / submit / decision (re-dispatch and re-submit do not re-notify or
  overwrite); `accept` requires a submitted result.

Implemented (deterministic, 168 tests green at the time of capture):
`worker/agent/team/{manifest,shared-fs,manifest-store,team-context,
team-task-port}.mjs`.

## Sequencing note

The Tiangong runtime currently uses a closed **Practice** registry
(`practiceIds`, methodology, Reviewer targets, `if reviewer else kernel`
assembly). Adding a `leader` RoleProfile there would be throwaway: the
architecture baseline §5 mandates deleting the Practice model and writing a
role-neutral `WorkRunStore` with profile/registry-driven assembly and the five
roles (leader/designer/implementor/assessor/operator). The role-neutral
TeamTaskPort and RunnerPort contracts land cleanly into that Phase-2 runtime;
wiring the `leader` profile + TeamTaskPort tools therefore follows the
Practice clean cut rather than being grafted onto the Practice registry.
