# Focused run — AgentTeams v1.2.0 Leader oracle

> Status: PARTIAL — dynamic structured-file oracle pending
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
- The running stock Leader exposed Project `plan.md` and legacy Task progress
  paths. Subsequent static inspection of the v1.2.0 live Manager image's
  deployed `project-management` / `task-management` Skills and scripts
  established the deployed file-format contract: Project `meta.json` +
  `plan.md`, and Task `meta.json` + `spec.md` + `result.md`; state is
  synchronised with `agentteams-sync` (`/usr/local/bin/agentteams-sync`) and
  `mc cp`/`mc mirror`; completion is signalled by @mentioning the coordinator.
  This static oracle supports format-compatible implementation, but does not
  prove that a model-driven stock Leader dynamically creates and consumes all
  of these records in a real Team.
- `/opt/openclaw/skills/taskflow` exists in the image but is **not** deployed
  to the leader.

## Dynamic closure still required

This oracle is not complete until a fresh stock v1.2.0 `team_leader`, prompted
through its supported model in a real disposable Team, creates a Project and
Task without Tiangong pre-creating their platform files. The run must capture
from Team remote storage:

1. the stock Leader-created Project `meta.json` and `plan.md`;
2. the delegated Task `meta.json` and `spec.md`;
3. the assigned Worker-created `result.md` and its Matrix completion mention;
4. the stock Leader consuming that result and updating the platform records;
5. exact cleanup or an explicit failed-cleanup verdict.

Until those artifacts exist, report the deployed formats as **static-oracle
backed, dynamically unproven**. The Tiangong product-Leader smoke cannot close
this stock-Leader oracle.

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
  stack reset (`make uninstall`) is the reliable cleanup path. The historical
  oracle Workers remained residue until a later confirmed reset removed them;
  that reset does not upgrade the original run's cleanup verdict.

## Implication for TeamTaskPort

TeamTaskPort does **not** wrap a `projectflow`/`taskflow` MCP (it does not
exist). Following the architecture baseline §7 / contract §5 contingency, it
is grounded on:

- AgentTeams-owned Project/Task records under
  `/root/agentteams-fs/shared/projects/{project-id}/` and
  `/root/agentteams-fs/shared/tasks/{task-id}/` are the sole coordination
  truth. Tiangong-owned immutable binding/Evidence supplements live only in
  each bound record's `tiangong/` subdirectory; there is no second Project/Task
  state tree.
- **Authorization** against the immutable `roleBindings` / `assignee` from the
  authenticated Worker identity, never Task prose.
- **@mention + sync** side effects behind injected adapters; **idempotent**
  dispatch / submit / decision (re-dispatch and re-submit do not re-notify or
  overwrite); `accept` requires a submitted result.

The initial implementation named here was superseded after review. The current
port also drives native AgentTeams records, binds producer/profile/Skill/result
and Leader decisions, uses authenticated Matrix Team-room delivery, and fails
closed when Team roster or durable Evidence cannot be proved.

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
