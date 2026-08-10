# Evidence-backed team control

> Status: target design.
>
> This document defines what Tiangong should be. It is implementation-independent.

## 1. Purpose

Tiangong coordinates a team of AI agents for open-ended professional work. It
provides enough durable structure for delegation, handoff, recovery, and safe
external action without turning one preferred team method into a workflow
engine.

The central division of responsibility is:

- the **Leader** makes semantic judgments;
- agents choose professional methods within their delegated work;
- code enforces identity, capabilities, concurrency, and external-effect
  safety; and
- records preserve what Humans, agents, tools, and external systems actually
  did without copying the same fact into several ledgers.

A Team may analyze, plan, challenge, implement, integrate, review, test,
release, research, or perform other work. These are ordinary Tasks, not Kernel
stages. Small Work may need no delegation. Complex Work may use many agents in
parallel. Tiangong does not require a fixed role roster, task taxonomy,
dependency graph, review sequence, or independent-verification step.

## 2. Scope and trust boundary

### 2.1 Deployment model

One Tiangong deployment serves one enterprise. An enterprise may run many
Teams, each with its own Leader, members, routes, capabilities, and external
systems.

The design assumes that infrastructure administrators, database
administrators, and host administrators are trusted. It does not attempt to
prove integrity against a malicious administrator or host.

The design addresses failures that remain plausible inside that trust model:

- model mistakes and prompt injection;
- incorrect Team, Work, Task, workspace, or channel routing;
- capability escalation through prose, Skills, retrieved content, or tool
  output;
- credential disclosure to agent-controlled processes;
- accidental source disclosure through network access;
- concurrent writers and stale coordination commands;
- duplicate, interrupted, or outcome-uncertain external actions;
- misleading completion claims; and
- late events after Task or Work termination.

### 2.2 Product ownership

AgentTeams owns the platform Team, Worker/container, channel identity,
delivery, and storage integration layer.

Tiangong owns its Worker control runtime, professional delegation, session
context, prepared execution boundary, tools, external-system Adapters,
Operation policy, exact Approval, recovery, and product experience.

Channel authentication identifies a Human or Worker. It does not by itself
grant Tiangong tool, data, approval, or external-effect authority.

### 2.3 Permanent non-goals

Tiangong is not:

- a hostile-administrator tamper-proof log;
- a multi-enterprise isolation proof;
- a content-addressed archival platform;
- a fixed software-development lifecycle;
- a universal scheduler DAG;
- a registry of every executable that may run inside Bash; or
- a substitute for repository branch protection, CI, change-management, or
  incident-response systems.

Allowlisted network access trades some isolation for practical Git, package,
documentation, and research access. Capability separation and monitoring reduce
residual disclosure risk; they do not make that risk zero.

## 3. Design principles

### 3.1 Semantic authority belongs to the Leader

The Leader decides:

- what the Human means;
- whether clarification is sufficient;
- whether and how to delegate;
- which agent reports are useful;
- whether more work, review, testing, or challenge is needed; and
- whether a Work is complete or should stop.

The Kernel does not infer these judgments from criterion identifiers, result
outcome enums, role names, or a process graph.

### 3.2 Machine authority belongs to code

Code, not prompts, owns:

- authenticated identity and Team routing;
- member admission and actual capabilities;
- readable and writable paths;
- process, network, and credential boundaries;
- Operation policy and exact Approval;
- command idempotency and optimistic concurrency;
- single-writer and single-active-execution rules;
- external-effect outcome and recovery checks; and
- atomic Task termination and Work closure.

WorkSpec, TaskSpec, messages, Skills, model output, retrieved content, and MCP
responses cannot grant machine authority.

### 3.3 Keep different facts separate

Tiangong distinguishes four sources of fact:

| Source | Record |
|---|---|
| Human and Leader communication or coordination | Work timeline |
| An agent's final report | Result |
| What a top-level tool observed | ToolResult |
| What happened to an external write | Operation events |

One fact is not copied into a second evidence wrapper. In particular, there is
no separate machine-evidence object or store.

### 3.4 Structure assists autonomy

WorkSpec, TaskSpec, Result, stable content references, and typed Operation
requests help agents recover and collaborate. They do not prescribe a
professional method.

A coordination Skill may offer planning patterns, challenge prompts, review
checklists, or release practices. The Leader may use, reorder, replace, or skip
them.

### 3.5 Uncertainty is not success or failure

When an external action may have taken effect but its state cannot be
confirmed, Tiangong records uncertainty and blocks conflicting effects. Time,
model confidence, and Human risk acceptance cannot turn an unknown external
state into a known one.

### 3.6 Hard controls must justify their friction

A new Kernel Gate, field, or state must identify:

1. the concrete threat or concurrency error it prevents;
2. why a Skill, MemberConfig, Adapter, or external system is insufficient;
3. how code verifies the property; and
4. the additional friction imposed on agents.

Without that case, Tiangong improves defaults and capabilities instead of
expanding the Kernel.

## 4. Core facts

The durable coordination model contains only:

- a Work and its append-only timeline;
- the Work's current WorkSpec projection;
- Tasks with immutable TaskSpecs;
- at most one immutable Result per Task;
- immutable ContentRefs;
- bounded ToolResults in the execution-record layer;
- immutable Operations and append-only Operation events; and
- TeamConfig, MemberConfig, and ControlProfile.

Task labels such as “queued”, “running”, “waiting for approval”, “reported”, or
“cancelled” are UI projections from actual facts. They are not a second Task
state machine.

Leader actions are commands which append typed Work timeline facts. Each fact
carries its direct subject, a bounded reason, the authenticated actor, and time.
There is no generic coordination-decision object or decision ledger.

The authoritative control inputs remain distinct:

| Actor | Controlled input | Durable fact |
|---|---|---|
| Leader | `create-task`, `cancel-task`, `complete-work`, or `stop-work` | Typed Work timeline fact |
| Task assignee | `submitResult` | Immutable Result keyed by Task ID |
| Authenticated Human | Approve or reject one exact Operation | Operation event |
| Recovery controller or authenticated Operator | Reconcile an unresolved Operation | Read-only observation and, only when verified, an Operation event |

This table describes actors and fact ownership. It is not a shared action enum
or workflow.

## 5. Work, WorkSpec, and Human communication

### 5.1 Message admission and Work creation

An authenticated Human message enters through the channel integration. Its
platform message identifier is the ingress idempotency key.

- A message explicitly associated with an open Work is appended to that Work's
  timeline.
- A message with no clear association creates a new Work and its first timeline
  entry atomically.
- Ambiguous input defaults to a new Work so unrelated contexts are not silently
  combined.
- Attachments use ContentRefs. Ordinary text remains an ordinary message.

A Work projection may initially be:

```json
{
  "workId": "work-123",
  "teamId": "team-a",
  "epoch": 1,
  "workSpec": null,
  "createdBy": "human-42",
  "createdAt": "2026-08-09T10:00:00Z"
}
```

The original request is the first Work timeline entry. It is not duplicated in
the projection above.

### 5.2 Correcting an ambiguous association

When the Leader asks whether an ambiguous message belongs to an earlier Work
and the Human confirms that it does:

1. the original platform-message reference and confirmation are appended to the
   earlier Work;
2. the placeholder Work receives a `work-stopped` fact whose reason identifies
   the earlier Work; and
3. the placeholder leaves active views but is not physically deleted.

The preserved placeholder is needed for message replay and historical
explanation. Tiangong does not add a general Work merge, reparenting, or
inheritance protocol.

Normally the placeholder remains at `workSpec: null` and receives no Task. If
work or external effects already occurred, the Leader handles those facts
explicitly; the runtime does not merge them automatically.

### 5.3 Forming and changing the WorkSpec

The WorkSpec is the Leader's concise current understanding of the whole Work.
It may contain:

```json
{
  "goal": "Deliver the requested behavior",
  "scope": ["repository service-a"],
  "constraints": ["preserve the public API"],
  "doneWhen": ["the requested behavior is available"],
  "unresolvedAssumptions": []
}
```

These fields are semantic guidance, not machine criterion identifiers.

Initial formation and every change append one `work-spec-changed` timeline
fact containing:

- the authenticated actor and time;
- a bounded reason;
- the complete new WorkSpec snapshot; and
- the relevant Human message or Leader rationale.

The current WorkSpec is a transactional projection of these same events. There
is no separate WorkSpec history store.

A non-null current WorkSpec is a machine precondition for creating a Task and
for `complete-work`. A Work may be stopped while its WorkSpec is null.

### 5.4 Existing Tasks do not silently change

A Task already dispatched does not automatically receive a later WorkSpec.
Its TaskSpec remains the delegation authority.

After a WorkSpec change, the Leader decides:

- an unrelated Task needs no update;
- useful but non-authoritative context may be sent as an explicitly targeted
  background message; or
- a material change requires safely cancelling the old Task and creating a new
  one.

An agent may query the current Work summary, but the response is labelled as
background and cannot rewrite the TaskSpec. Tiangong does not bind Tasks to
WorkSpec versions or introduce a general Task-update protocol.

### 5.5 Waiting for Human input

Clarification is ordinary Work communication, not an Approval object.

When Human input is needed, Tiangong clearly notifies the Human, stops
unnecessary active computation, may release the logical session, and may send
bounded deduplicated reminders.

If no safe default exists, elapsed time does not invent one. A clarification
request may leave the Work open with `workSpec: null` and a UI projection such
as “waiting for Human”. A later reply continues the same open Work.

Reminder timers, delivery retries, and waiting labels are infrastructure or
projections, not authoritative business objects.

### 5.6 Work termination

The Leader has two Work-terminal commands:

- `complete-work` — the Leader judges the current non-null WorkSpec satisfied;
- `stop-work` — the Work will not continue, with a bounded reason such as
  withdrawal, inability, duplication, or incorrect routing.

Both append a typed timeline fact with a bounded reason and atomically update
the Work terminal projection. A terminal Work is not reopened. Later needs
create a new Work.

Work completion and stopping are internal semantic decisions and do not require
Kernel-level Human confirmation. Teams may request customer acceptance through
ordinary messages, Skills, or external systems.

## 6. Task delegation and Result handoff

### 6.1 Task creation

Only the Leader creates a Task. Creation is atomic with a `task-created` Work
timeline fact, its bounded delegation reason, and Work epoch advancement.

```json
{
  "taskId": "task-456",
  "workId": "work-123",
  "assigneeId": "member-9",
  "taskSpec": {
    "objective": "Implement cancellation handling",
    "inputs": [
      {
        "repositoryId": "service-a",
        "commitSha": "abc123"
      }
    ],
    "constraints": ["do not change the public API"]
  },
  "createdBy": "leader-1",
  "createdAt": "2026-08-09T10:10:00Z"
}
```

The TaskSpec is the complete semantic delegation. It is immutable and contains
only the objective, inputs, and necessary ordinary-language constraints.

A Task does not copy:

- a WorkSpec version;
- a role or task-kind enum;
- a workflow stage;
- a dependency graph;
- a capability list;
- a policy snapshot;
- a workspace object; or
- an expected Result type.

If the objective or assignee must materially change, the Leader creates a new
Task.

### 6.2 Dynamic multi-agent work

The Leader may reason directly or create ordinary Tasks for analysis, planning,
challenge, research, implementation, integration, review, testing, release, or
any other responsibility.

The Kernel does not understand those professional labels. A later Task can cite
an earlier Task's unique Result by Task ID, a commit, or another ContentRef as
input. Tasks may run in parallel when their writable roots and other
capabilities do not conflict.

The Leader creates follow-up Tasks when their inputs are actually available;
Tiangong does not prebuild a scheduling DAG. An integration Task is an ordinary
Task. Review and testing are optional ordinary Tasks. Enterprises that require
hard review gates should enforce them in the relevant repository, CI, or
Adapter rather than add a universal Result subtype.

A Team may configure several members with similar responsibilities. The Kernel
does not limit a responsibility to one agent.

One member may execute several Tasks concurrently when current MemberConfig and
ControlProfile limits permit it. Each Task retains its own logical session and
execution owner, and concurrent writers use different writable roots.

### 6.3 Execution ownership

Each Task has at most one active agent turn or execution owner at a time. A
replacement is allowed only after the previous process tree is confirmed
stopped or isolated from the writable root.

The Task may have:

- no Result while work is continuing;
- exactly one immutable final Result; or
- a `task-cancelled` timeline fact when no Result exists.

A pending Operation may pause the same Task and later return a result to it. It
does not create an approval stage or a replacement Task.

### 6.4 Result

A Result is the assignee's final report, not a platform quality verdict.

```json
{
  "taskId": "task-456",
  "summary": "Implemented cancellation handling. One legacy edge case remains documented.",
  "deliverableRefs": [
    {
      "repositoryId": "service-a",
      "commitSha": "def456"
    }
  ],
  "toolResultRefs": ["tool-result-21"],
  "submittedBy": "member-9",
  "createdAt": "2026-08-09T11:00:00Z"
}
```

`deliverableRefs` and `toolResultRefs` are optional. The summary states what was
or was not achieved, limitations, and useful next steps.

There is no Result ID because a Task has at most one Result. There is no Result
outcome enum, verification subtype, producer relationship, verdict, digest,
version, or accept/reject disposition.

The Leader may use the Result, create a follow-up Task, or decide it is not
useful. Work completion is the Leader's later semantic judgment.

Before Result creation, code checks only that:

- the authenticated actor is the current assignee and remains admitted;
- the Task has neither a Result nor a cancellation fact;
- the bounded schema is valid;
- cited ContentRefs are accessible and stable;
- cited ToolResults belong to the actor and Task; and
- retention marks for cited ToolResults have succeeded.

The check does not judge quality, completeness, testing, WorkSpec coverage, or
business correctness.

### 6.5 Cancellation and races

Only the Leader may cancel a Task which has no Result.

Before committing cancellation, the runtime:

1. stops and confirms the entire active process tree;
2. releases the Task's writer lock or writable binding;
3. makes every pending, unstarted Operation `operation-not-executed`; and
4. refuses to hide an already-started Operation which still needs recovery.

Result submission and cancellation race in the database. The first committed
transaction wins; the loser is rejected. Successful cancellation appends a
`task-cancelled` Work timeline fact with the Leader's bounded reason. No Task
status field is rewritten.

## 7. Team, capability, Skills, and context

### 7.1 TeamConfig

A Team has exactly one Leader.

```json
{
  "teamId": "team-a",
  "leaderId": "leader-1",
  "routeScope": ["channel:room-a", "repository:service-a"],
  "controlProfileId": "enterprise-standard"
}
```

TeamConfig does not duplicate a member allowlist. An active AgentTeams identity
with an enabled MemberConfig for the Team is admitted. TeamConfig selects the
Leader, routes, and enterprise ControlProfile.

### 7.2 MemberConfig

MemberConfig defines a member's actual working capability, including:

- professional responsibility;
- accessible repositories and data scopes;
- execution-profile and writable-scope ceilings;
- network profile;
- exposed top-level local tools and Adapters;
- available professional and coordination Skills;
- allowed models; and
- member budgets and concurrency limits.

Data scope and network capability are validated together. A member with broad
search or documentation egress must not receive core private source. A member
with core private source receives only purpose-limited network paths
such as exact repository fetch, package download, and named test services.

Controlled ContentRefs and context assembly enforce configured data scopes.
Free-form prose can still carry sensitive text, so routing discipline,
sanitization, and monitoring remain necessary; Tiangong does not claim perfect
semantic data-loss prevention.

### 7.3 ControlProfile

ControlProfile is the enterprise ceiling. It defines:

- allowed, approval-required, and forbidden Operation classes;
- authorized approvers and Approval expiry;
- unknown-action behavior;
- process, filesystem, network, and data-boundary requirements;
- model allowlists and explicit fallback rules;
- budget and concurrency ceilings;
- Execution Record and Work retention; and
- sanitization and incident-escalation requirements.

Unknown external writes and unknown privileged tool classes are denied.
ControlProfile does not encode a professional workflow or universal
review/testing rule.

### 7.4 Effective authority

A call is allowed only when four distinct checks agree:

1. AgentTeams confirms the current identity and route;
2. ControlProfile permits the capability in principle;
3. MemberConfig grants that member the actual data, network, tool, or Adapter
   capability; and
4. the runtime binding identifies the current Work/Task, cwd, writable root, or
   Adapter target.

The runtime binding is a capability handle, not another editable policy.
Tiangong does not create a resolved Work policy or copy permissions into Tasks.

Every new turn, local tool call, and Adapter call checks current configuration.
Environment activation and every new turn also verify that actual data mounts,
writable roots, and egress bindings match the current MemberConfig and runtime
capability binding. Missing, stale, conflicting, or mismatched state fails
closed. Revocation stops or isolates unstarted local capability. An
already-started Operation retains only the restricted recovery path described
later.

### 7.5 Skills and context

Skills are versioned methods, instructions, and reusable code. They may provide
strong defaults, but they cannot grant capabilities, append privileged events,
or change Task and Work facts directly.

For a Task agent, context is layered by authority and purpose:

1. hard runtime boundaries and current configuration;
2. the immutable TaskSpec and runtime binding;
3. explicitly targeted Leader background and Work or Human messages selected
   for that Task;
4. enabled Skills as governed method defaults;
5. an explicitly queried current Work summary;
6. optional retrieval; and
7. older conversational history.

Task-specific background cannot rewrite the TaskSpec. Skills may raise risks or
suggest a better method, but they do not override the concrete delegation. A
later WorkSpec is not automatically inserted as a new Task instruction.

For the Leader, the current WorkSpec, Work timeline, Tasks, Results, and
Operations are the durable recovery context.

Retrieval is an optional local tool or Adapter. Its index is rebuildable and
never authoritative. Risks and disagreements are ordinary messages or Result
content; there is no dedicated concern object.

## 8. Prepared execution environments

### 8.1 Control and execution are separate security domains

A Worker control runtime handles identity, messages, sessions, Gates, and
provider access. Agent-launched Bash, builds, tests, and scripts run in a
prepared execution environment.

The following is a system invariant:

> An agent-controlled execution process tree cannot read Worker control
> credentials, model-provider keys, channel identity material, session or
> runtime state, pending-operation state, production credentials, a container
> socket, or a host-control endpoint.

This boundary may be implemented by an OS sandbox inside a Worker or by a
long-lived sidecar/container. The physical form is not a domain object. The
capability boundary is mandatory.

### 8.2 Preparing the environment

Stable operating-system packages, shells, Git, language runtimes, compilers,
and sandbox helpers belong in immutable versioned images. A project may add a
stable project toolchain image layer.

Mutable source does not become an image authority. A prepared environment uses
a local Git object mirror or cache and one or more checkouts/worktrees.
Synchronizing source uses `git fetch` followed by an exact commit checkout,
reset, or worktree. It does not default to `git pull` and an implicit merge.

Package-download and build caches may survive Tasks and Works. A dependency
tree is reused only when its image, platform, toolchain, and lockfile key match;
otherwise the environment performs an incremental install or rebuild. A cache
is an optimization, not an authoritative record.

Long-lived test services may be reused when their data is namespaced or reset
appropriately. Production systems are accessed only through Adapters.

An agent normally enters an already prepared cwd, performs a lightweight fetch
and key check, runs a health check, and starts work. Tiangong does not rebuild
an environment for every Work, Task, or Bash command. It recycles an
environment after contamination, toolchain change, security-domain change, or
an explicit clean-reproduction request.

### 8.3 Member workspaces and parallel writers

By default, each AgentTeams member has a long-lived Worker control runtime and
its own credential-free execution area. Members do not share a writable
filesystem.

Code moves between members as exact Git commits. Other stable content moves as
ContentRefs. Members may share controlled read-only Git objects, package and
build caches, content stores, and namespaced test services.

Sequential Tasks for the same member and Work may reuse a primary workspace.
Parallel writers use different worktrees or writable roots. Two active writers
must never own the same writable root.

Independent review, clean testing, untrusted source, or reproduction may use a
clean workspace or temporary sandbox when useful. It is not a universal Task
requirement.

### 8.4 OS capability boundary

The execution process tree uses defense-in-depth controls such as:

- a non-root identity;
- dropped capabilities and no-new-privileges;
- a read-only system root;
- explicit readable and writable mounts;
- clean environment variables;
- process, CPU, memory, and time limits;
- blocked host, control, and metadata endpoints; and
- network policy applied to the entire process tree.

Control paths, runtime paths, and unsuitable temporary mounts remain `noexec`.
Explicit build/workspace paths may allow execution when compilers, native
packages, or tests require it. Executability does not grant credentials,
network, or path escape.

Cancellation, budget termination, and environment recycling kill and confirm
the entire process tree, not only the parent shell.

## 9. Tools, network, and Adapters

### 9.1 Bash is a first-class local tool

Tiangong exposes Bash as a wrapped top-level model tool. Agents may use ordinary
shell syntax, pipelines, redirection, Git, package managers, build tools, and
scripts inside the prepared execution environment.

Tiangong does not register every executable invoked by Bash and does not create
a container for each command.

The runtime intercepts top-level tool calls to bind actor, Work/Task, and
execution environment, apply resource limits, and capture a bounded result.
Shell-text analysis may warn, improve UX, or reject an obvious mistake, but it
is not the filesystem, credential, or network security boundary. Shell grammar
cannot be reliably allowlisted.

Bundled local file tools such as read, edit, and write may also be exposed as
conveniences. They use the same environment capability boundary as Bash.

### 9.2 Per-member network capability

Network access is a MemberConfig capability.

A research-oriented member may receive read-oriented search and documentation
egress while having no core private source. This uses purpose-specific proxies
or Adapters rather than an arbitrary write-capable raw Internet socket. An
implementation-oriented member may receive core source with only
purpose-limited access to exact Git fetch, package registries, and named test
services.

Egress controls apply to the whole process tree through network namespaces,
proxies, or equivalent enforcement. Child processes, scripts, and `curl` do not
bypass them. Cloud metadata, host-control endpoints, platform control services,
and unapproved internal networks are always denied.

Private Git and package access use a scoped read-only proxy, credential helper,
or preparation service. Raw credentials are not exposed to Bash.

Allowlisted destinations can still be abused, dependencies can be hostile, and
free-form context can contain sensitive data. Capability separation is the
primary backstop; bounded monitoring supports detection and response rather
than claiming prevention proof.

### 9.3 Three top-level capability classes

Tiangong distinguishes:

1. **Local execution tools** — Bash and optional local file tools operating
   inside the prepared sandbox.
2. **External-system Adapters** — versioned, typed access to repositories,
   databases, logs, cloud systems, deployment systems, notifications, tickets,
   and other external services.
3. **Kernel commands** — creating or cancelling Tasks, submitting Results,
   terminating Work, handling exact Approval, and invoking recovery controls.

MemberConfig determines which finite top-level entries a member sees. This is
normal capability provisioning, not a global executable registry.

An extension which runs only inside the prepared sandbox may behave as a local
tool. An extension which executes in the control domain, holds credentials, or
can mutate external state must be an Adapter and cannot bypass Operation
policy.

### 9.4 Adapter contract

An Adapter:

- has a stable identity and version;
- validates a typed request and target;
- enforces the member's data or action scope;
- owns any scoped credential outside agent-visible memory;
- returns a bounded sanitized observation for reads;
- creates an immutable Operation for writes;
- verifies declared postconditions before reporting a safe terminal write
  fact; and
- provides privileged read-only reconciliation when its write can become
  uncertain.

External reads are not Operations, but they still require identity, data-scope,
and sanitization checks. External writes are always Operations. Unknown write
classes are denied.

Git push, package publication, deployment, database mutation, external
notification, ticket mutation, and production configuration are representative
Operations. Local edits, builds, tests, cache updates, and read-only queries are
not.

MCP is an optional transport for a local tool or Adapter. It creates no new
authorization layer. An MCP server with credentials or write capability remains
subject to Adapter and Operation rules. MCP output is untrusted input and
cannot grant permission.

## 10. Content and execution records

### 10.1 ContentRef

A Git commit is identified by:

```json
{
  "repositoryId": "service-a",
  "commitSha": "def456"
}
```

Other durable content is identified by an Adapter-owned immutable or versioned
reference:

```json
{
  "adapter": "document-store@1",
  "ref": "document-42/version-3"
}
```

A mutable path cannot be a Result deliverable. Its Adapter must first create a
snapshot or version. Display names and paths are UI metadata, not identity.

Tiangong does not require a universal content digest. An Adapter whose store
needs a digest may encode it in its own opaque reference.

Content becomes a formal Task deliverable only when a Result lists its
ContentRef. Tiangong does not build a general content repository around this
relationship.

A commit identifies source content, not correctness. Local integration is
ordinary Task work. A push of the integration commit is an Operation.

### 10.2 ToolResult

A ToolResult is an immutable, bounded observation of one top-level tool call in
the execution-record layer.

```json
{
  "toolResultId": "tool-result-21",
  "workId": "work-123",
  "taskId": "task-456",
  "actorId": "member-9",
  "tool": "bash",
  "requestSummary": {
    "command": "npm test",
    "cwd": "service-a"
  },
  "resultSummary": {
    "exitCode": 0,
    "summary": "tests passed"
  },
  "outputRef": null,
  "startedAt": "2026-08-09T10:30:00Z",
  "completedAt": "2026-08-09T10:31:00Z"
}
```

Task context is optional for Leader-level tools. Tool-specific details such as
Git HEAD, query scope, target, or duration belong in the bounded summaries when
relevant; they are not universal business fields.

A ToolResult proves what the wrapped tool observed. It does not prove that the
agent understood it, that semantic work is correct, or that an external write
occurred.

Credentials, raw sensitive payloads, unrestricted prompts, and unbounded logs
must not enter ToolResults. Large output is stored separately and referenced.

ToolResults for an active Task remain available until Result submission or
cancellation. A Result citation adds a retention mark through the Work's
retention period. Other ToolResults, traces, and logs may be sampled or expired
according to ControlProfile.

### 10.3 Storage classes

Tiangong uses:

- **CoordinationStore** for Work timelines and projections, Tasks, Results,
  Operations, and permanent append-only Operation events;
- **Execution Record storage** for ToolResults, bounded logs, traces, model and
  Skill invocation metadata, and diagnostics; and
- **Git and Adapter-owned content stores** for durable content.

Session state, prepared-environment mappings, writer locks, reminder timers,
and request replay rows are infrastructure state, not new domain records.

Operation events are never sampled from CoordinationStore. There is no second
machine-fact index, hash-chain ledger, or content manifest.

## 11. Operations and exact Approval

### 11.1 Immutable Operation

An Operation is one proposed external write:

```json
{
  "operationId": "op-123",
  "taskId": "task-456",
  "adapter": "deploy@1",
  "action": "deploy",
  "request": {
    "target": "staging",
    "commit": "def456"
  },
  "preview": "Deploy commit def456 to staging",
  "createdBy": "member-9",
  "createdAt": "2026-08-09T11:10:00Z"
}
```

After creation, the Operation ID, Adapter, action, request, target, and
risk-relevant preview are immutable. The trusted CoordinationStore record is
the exact authorization subject; Tiangong does not add an operation digest,
business invocation ID, approval ID, or approval-view digest.

All content which determines the external effect must be present in the typed
request and faithfully represented in the preview: target, action, commit,
query or mutation, configuration, destination, and message body as applicable.
If every risk-relevant attribute cannot be shown safely, the action cannot be
approved.

Adapter credentials are authentication material, not hidden action payload.
They do not enter the Operation, prompt, preview, Bash environment, ToolResult,
or diagnostics, and their values are not fingerprinted. An Adapter must not
derive target or action from a credential value.

For an action such as credential rotation, the request identifies the target,
principal, and generation policy; the Adapter or external secret manager
generates the random value. The minimal Kernel does not support an
agent-selected hidden payload which would change an action without being shown
to the approver.

### 11.2 Policy and Approval

At use time, ControlProfile classifies the immutable Operation as:

- automatically allowed;
- requiring exact Human Approval; or
- denied.

For exact Approval, the runtime sends and stores the actual bounded preview and
its channel delivery metadata. An authenticated Human action appends either
`operation-approved` or `operation-rejected`, directly referencing the
Operation ID. Rejection also terminates the Operation as
`operation-not-executed`. Ordinary chat text is not authorization. There is no
separate Approval object.

The runtime validates the current approver policy when handling the action and
again immediately before execution. Approval, rejection, expiry, cancellation,
and execution-start races are serialized so `operation-not-executed` can never
follow an execution-start fact. A deny decision, policy tightening which
invalidates the pending path, or Approval expiry terminates the Operation as
`operation-not-executed`; none of these executes, revives, or cancels the Task.
Bounded reminders may be sent before expiry.

The same Task may resume with the rejected or expired tool result and choose a
different approach. A later attempt is a new Operation.

### 11.3 Idempotent execution

A runtime replay row maps the same authenticated top-level tool call to the
same Operation ID. The row is local infrastructure state and is not part of the
business graph.

The Adapter uses the Operation ID as its backend idempotency key when the
backend supports one.

Before invoking the backend, the runtime durably appends
`operation-execution-started`. Once that fact exists, Tiangong never blindly
replays the forward invocation. A backend response which returns a result it
already stored for the same Operation ID is retrieval, not a new effect.

### 11.4 Known and unresolved outcomes

Only three events establish a known terminal Operation:

- `operation-not-executed` — external execution was not entered;
- `operation-succeeded` — Adapter code confirmed the request's declared
  postcondition; or
- `operation-safe-failure` — the request did not succeed, but Adapter code
  confirmed that no unresolved lasting effect remains.

Safe failure does not claim that no transient effect ever occurred. It may, for
example, confirm that an explicitly approved immediate compensation restored
the displayed baseline.

An Adapter must not append success or safe failure based only on a model claim,
transport status, or optimistic backend acknowledgement.

Two events leave the Operation unresolved:

- `operation-uncertain` — the external state cannot be confirmed;
- `operation-recovery-needed` — a wrong or partial effect is known and has not
  been repaired.

An unresolved Operation blocks conflicting writes for the same Adapter target
and blocks both forms of Work termination. It does not block unrelated safe
work. Human risk acceptance cannot convert an unresolved fact into a terminal
one.

Operation state is a projection of immutable events, not a separately editable
state field.

### 11.5 Reconciliation and escalation

Timeout, disconnect, crash, or ambiguous backend response after execution
started produces `operation-uncertain`.

Reconciliation uses a privileged read-only Adapter interface. It is not an
Operation and is not exposed as an ordinary model tool. A recovery controller
or authenticated Operator may trigger it; the Leader may request it.

Reconciliation may append a known terminal event only after it confirms the
requested postcondition, confirmed non-application, or confirmed restoration.
A known residual effect produces `operation-recovery-needed`. If the state
remains unknown, it remains uncertain.

Confirmation that an effect was not applied does not authorize another try. A
retry creates a new Operation with a new ID and passes the current Gate and
Approval policy.

Repeated automatic reconciliation failure escalates to an authenticated
Operator. The Operator may:

- perform deeper read-only investigation;
- initiate a new, fully controlled recovery Operation; or
- transfer handling to enterprise incident response.

Only actual observation or repair can establish a safe terminal event. An
incident handoff may be displayed as an escalation or pause, but it is not a
safe Operation outcome and does not permit Work termination. Recovery
responsibility remains with the original Work until the external state is
resolved.

### 11.6 Rollback

A rollback after a terminal Operation is another external write. It is a new
Operation with a new ID and current policy and Approval checks.

An Adapter may implement immediate compensation inside the original invocation
only when the immutable request and preview fully describe it. For example, a
deployment request may state the health condition and exact commit to restore
on immediate health failure. That compensation:

- is part of one approved compound action;
- runs only inside the original Adapter invocation;
- records both forward and compensation observations in the original Operation
  events; and
- cannot be invoked later as a reusable rollback phase.

Tiangong has no generic rollback plan, rollback phase identity, or second phase
idempotency protocol. An uncertain forward result is reconciled before any new
rollback Operation is considered.

## 12. Sessions, concurrency, budgets, and closure

### 12.1 Logical sessions

The Leader uses an independent logical session per Work. A member uses an
independent logical session per Task. Each session processes one turn at a
time.

A session is a convenience, not authority. It may be released while waiting for
Human input or after inactivity and rebuilt from the Work timeline, TaskSpec,
targeted background, Results, ToolResults, and Operation facts. Session
transcripts are potentially sensitive and follow Execution Record retention.

### 12.2 Models and budgets

ControlProfile and MemberConfig define allowed models, token/cost/time limits,
and concurrency. Model fallback is explicit; Tiangong does not silently change
provider or model when one fails.

Budget or resource exhaustion stops new model calls and local execution
processes, records the fact, and notifies the Leader. It does not fabricate a
Result or erase an already-started Operation; that Operation follows its normal
outcome and recovery rules. The Leader may cancel, redelegate, or reduce the
work. An authorized administrator may change current configuration; ordinary
chat cannot add budget.

### 12.3 Optimistic concurrency and command idempotency

Work `epoch` is an internal optimistic-concurrency token. A coordination write
provides the epoch it read and increments it atomically when it succeeds. Epoch
is not a WorkSpec version, semantic basis, idempotency key, or completion
criterion.

Within authenticated actor and command type, a `requestId` is atomically bound
to a normalized request and bounded response. Repeating the same request
returns the saved response; reusing the ID for different content conflicts.
Replay rows are bounded infrastructure state and do not appear in the Work
timeline.

The store provides atomic boundaries for at least:

- message admission and Work creation;
- WorkSpec event, projection, and epoch update;
- Task creation, timeline fact, and epoch update;
- Result submission versus Task cancellation;
- Work terminal event, projection, and epoch update; and
- Operation execution-start recording before an external call.

### 12.4 ResultGuard

`ResultGuard` is the local validation in `submitResult`, not a record or
service. It enforces only the checks in section 6.4 and the Result/cancellation
race. It does not judge professional quality.

### 12.5 CloseGuard

Before `complete-work` or `stop-work`, `CloseGuard` verifies machine facts:

- the actor is the current Leader and the Work is open;
- `complete-work` has a non-null current WorkSpec;
- every Task has a Result or cancellation fact;
- no Task has an active turn, process tree, or writer lock;
- every Operation is `not-executed`, `succeeded`, or `safe-failure`;
- no Approval is pending and no uncertain, recovery-needed, or unresolved
  incident path remains; and
- every referenced deliverable still resolves.

CloseGuard reads Task, Result, ContentRef, and Operation sources directly. It
does not build an intermediate evidence index or trust a caller-selected basis
list.

The Leader alone judges whether the WorkSpec is semantically satisfied.
Closure, its timeline fact, terminal projection, and epoch update are atomic.
Late Result, cancellation, Approval, and coordination writes are rejected after
termination.

## 13. Security model

### 13.1 Three layers against unauthorized effects and disclosure

Tiangong uses layered controls rather than a single command filter.

1. **Credential isolation.** Bash has no credentials for repository writes,
   deployment, production databases, token-bearing APIs, or platform control.
   Those credentials remain inside scoped Adapters.
2. **Network enforcement.** Egress policy limits credential-free external
   actions and disclosure to configured destinations and protocols. It applies
   to the whole process tree, not just the parent Bash command.
3. **Capability separation and monitoring.** Members with broad search or
   documentation egress do not receive core private source; members with core
   source receive only purpose-limited fetch, package, and test access. Bounded
   records and network monitoring support detection and response to residual
   misuse of allowed channels.

Shell-text analysis is auxiliary in all three layers.

### 13.2 Primary controls

The primary controls are:

- authenticated AgentTeams identity and route validation;
- current ControlProfile and MemberConfig checks;
- separation of Worker control and agent execution domains;
- non-root, least-capability process trees with explicit paths and network;
- data-and-egress capability pairing;
- scoped credentials held only by Adapters;
- immutable typed Operations and exact Approval events;
- execution-start-before-call and no blind replay;
- Adapter-verified terminal external outcomes;
- read-only reconciliation and Operator escalation;
- single active Task execution and single writable-root owner;
- Work epoch and request idempotency; and
- direct source retention for timeline, ToolResult citations, and Operation
  events.

### 13.3 Trust limits

This design does not protect against a trusted administrator rewriting the
CoordinationStore, replacing an Adapter, changing target configuration, or
controlling the host. It therefore does not add signing chains or content
anchors against those actors.

An external backend may lie or malfunction. Tiangong can require Adapter checks
and record observations, but cannot prove facts beyond the authority of its
trusted Adapter and external system.

Allowlisted network services, package registries, dependencies, and Human or
Leader prose remain possible disclosure channels. Member separation,
sanitization, and monitoring reduce this risk without eliminating it.

## 14. System invariants

1. Every Work begins with an authenticated, deduplicated Human message.
2. Ambiguous association never silently mixes unrelated Work; correction does
   not delete history or introduce a general merge protocol.
3. WorkSpec history consists of complete `work-spec-changed` timeline
   snapshots; the current WorkSpec is only their projection.
4. No Task is created while the current WorkSpec is null.
5. A TaskSpec and assignee are immutable; later WorkSpec changes do not
   silently alter them.
6. The Kernel has no task-kind, workflow-stage, dependency-DAG, fixed-role, or
   mandatory-verification protocol.
7. Each Task has at most one active execution owner and at most one Result.
8. Result submission and Task cancellation are atomic competitors.
9. A Result is an agent report, not a machine quality verdict, and requires no
   accept/reject disposition.
10. AgentTeams identity, ControlProfile, MemberConfig, and runtime capability
    binding are checked at each new controlled action.
11. Prose, Skills, retrieval, tool output, and MCP output cannot grant
    capability.
12. Agent-controlled processes cannot read control-plane, provider,
    production, container-runtime, or host-control credentials and state.
13. Two concurrent writers never own the same writable root.
14. Bash may run arbitrary local commands inside its capability sandbox; shell
    parsing is not the security boundary.
15. Broad search or documentation egress and core private source are not
    provisioned to the same member execution environment.
16. Every external write is an immutable Operation whose effect-defining
    request is visible in its risk preview.
17. Approval is an authenticated event for one immutable Operation ID; chat
    prose is not Approval.
18. The runtime records execution start before calling an external backend.
19. Success and safe failure are written only after Adapter code confirms their
    required external postconditions.
20. An uncertain or recovery-needed Operation is never retried blindly,
    declared safe by assertion, hidden by Task cancellation, or moved to
    another Work.
21. A later retry or rollback is a new Operation, except for immediate
    compensation fully contained in the original immutable request and
    invocation.
22. Operation events are permanent append-only CoordinationStore facts. Result
    citations retain their ToolResults through the Work retention period.
23. Work termination requires every Task and Operation to have a safe machine
    disposition and no active execution owner.
24. Only the Leader decides semantic Work completion; Kernel closure checks do
    not encode a professional process.
25. New hard controls require a concrete threat, machine-verifiable property,
    and explicit friction analysis before entering the Kernel.
