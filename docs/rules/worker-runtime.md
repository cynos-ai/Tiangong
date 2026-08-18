# Worker runtime rules

> Status: target engineering rules. Existing code may lag behind these rules;
> do not claim compliance without verification.

Use these rules for `worker/`, AgentTeams/OpenClaw integration, sessions, tools,
prepared execution, exact Approval, recovery, and Work closure.

## Ownership boundary

- AgentTeams supplies Team, Worker/container, channel identity, delivery, and
  storage integration plus Worker-scoped Gateway credentials.
- Official OpenClaw owns Matrix login, E2EE behavior, allowlists, mentions, room
  lifecycle, sync, typing, media, queueing, and delivery.
- Tiangong owns its Worker control runtime, professional delegation, logical
  sessions, prepared execution boundary, top-level tools, Skills, Adapters,
  Operation policy, exact Approval, recovery, and product experience.
- Keep `worker/plugin/index.mjs` a thin OpenClaw control-plugin entrypoint. Do
  not place Tiangong business logic in the Channel adapter or model runtime.
- Do not add a Tiangong-owned model runtime; OpenClaw and its official Codex
  app-server own provider turns and conversation state.
- Do not enable an OpenClaw Agent Harness fallback that can hide a Tiangong
  failure.

## Model and logical-session boundary

- Claim only explicitly supported providers and copy only allowlisted non-secret
  provider metadata.
- Inject the Worker Gateway credential through the model runtime in memory.
- Disable automatic discovery of external tools, extensions, Skills, prompt
  templates, and repository context until Tiangong owns and validates those
  inputs.
- Use one independent Leader logical session per Work and one member logical
  session per Task. Each session processes one turn at a time.
- Treat a session as a convenience, not authority. It may be released while
  waiting and rebuilt from durable Work, Task, Result, ToolResult, and Operation
  facts.
- Persist Tiangong session and control state only beneath the fixed Worker state
  root, outside the agent execution domain.

## Control and prepared-execution boundary

- Separate the Worker control runtime from agent-launched Bash, builds, tests,
  and scripts. The entire execution process tree must be unable to read control
  credentials, provider keys, channel identity material, session/runtime state,
  pending Operation state, production credentials, container sockets, or host
  control endpoints.
- Give each member a long-lived credential-free prepared execution area. Do not
  rebuild an environment for every Work, Task, or Bash command.
- Put stable operating-system packages, shells, Git, language runtimes,
  compilers, and sandbox helpers in immutable versioned images.
- Synchronize source through a local mirror or cache followed by exact
  `git fetch` and checkout/reset/worktree operations. Do not default to
  `git pull` and an implicit merge.
- Reuse package, build, and test-service caches only under explicit toolchain,
  lockfile, platform, namespace, and reset keys. A cache is not a machine fact
  about correctness.
- At environment activation and every new turn, verify actual mounts, writable
  roots, and egress bindings against current MemberConfig and the runtime
  capability binding. Missing or mismatched state fails closed.
- Run execution processes as non-root with dropped capabilities,
  no-new-privileges, bounded resources, a read-only system root, explicit
  writable paths, clean environment variables, and whole-process-tree network
  policy.
- Keep control and ordinary temporary paths `noexec`; allow execution only in
  explicit workspace/build paths which need compiled programs or tests.
- Cancellation, budget termination, and environment recycling must kill and
  confirm the complete process tree.

## Tools, paths, and network

- Provision only finite top-level tools and Adapters enabled by MemberConfig,
  and wrap every top-level call to bind actor, Work/Task, runtime environment,
  resources, and a bounded ToolResult.
- Distinguish local execution tools, versioned external-system Adapters, and
  Kernel coordination commands. MCP is only a transport and grants no
  authority.
- Expose Bash as a first-class local tool inside the prepared execution
  boundary. Do not build a closed registry of the executables, pipelines,
  redirects, package managers, build tools, or scripts which Bash invokes.
- Shell-text analysis may improve UX or reject an obvious mistake, but it is
  not the path, credential, or network security boundary.
- Bundled local file tools use the same execution capability boundary as Bash
  and must reject workspace escape, symlink traversal, runtime state, and
  credential-bearing paths.
- Apply MemberConfig network policy to the whole process tree. Child processes
  and scripts must not bypass destination, protocol, metadata, host-control, or
  internal-network restrictions.
- Validate data scope and egress together. A member with broad search or
  documentation egress must not receive core private source; a source-bearing
  member receives only purpose-limited repository fetch, package, and named
  test-service access.
- Keep Git, package, deployment, database, notification, and other external
  credentials inside scoped proxies or Adapters, never in Bash.
- Treat an extension which holds credentials or mutates external state as an
  Adapter subject to Operation policy, even when MCP or another extension
  mechanism transports the call.
- Apply current identity, data-scope, and sanitization checks to external reads.
  Reads are not Operations, but they are not ungoverned.

## Capability, delegation, and concurrency

- Require TeamConfig to select exactly one current Leader for each Team; admit
  other members through enabled MemberConfig rather than a duplicated member
  list.
- Compute effective authority from current AgentTeams identity and route,
  ControlProfile, MemberConfig, and runtime capability binding. Recheck it for
  every new turn, local tool call, and Adapter call.
- Do not copy capabilities or policy snapshots into WorkSpec or TaskSpec. Prose,
  Skills, retrieval, and tool output cannot grant authority.
- Admit every Work from an authenticated, deduplicated Human message. Append
  complete WorkSpec snapshots to the Work timeline and keep the current
  WorkSpec only as their transactional projection.
- Keep actor inputs distinct: the Leader creates/cancels Tasks and
  completes/stops Work, the assignee submits its Result, an authenticated Human
  approves/rejects one Operation, and only a recovery controller or an
  authenticated Operator reconciles unresolved external state.
- Require a non-null current WorkSpec before Task creation or Work completion.
  Keep TaskSpec and assignee immutable; a material change requires safe
  cancellation and a new Task.
- Use Work epoch only for optimistic concurrency and actor-scoped `requestId`
  rows only for bounded command replay. Neither is a semantic version,
  completion criterion, or domain ledger.
- Project waiting, running, reported, and cancelled UI labels from direct facts.
  Do not add a second editable Task status state machine.
- Keep professional analysis, planning, challenge, implementation, review,
  testing, integration, and release as optional ordinary Tasks. Do not add a
  fixed task kind, role roster, workflow stage, DAG, or mandatory verification
  protocol to the Kernel.
- Allow one member to run several Tasks concurrently only within current
  ControlProfile and MemberConfig limits. Each Task has its own logical session
  and at most one active execution owner.
- Give concurrent writers different worktrees or writable roots. Never allow
  two active writers to own the same writable root.
- Validate Result submission only for actor, uniqueness, bounded schema, stable
  ContentRefs, ToolResult ownership, retention, and the cancellation race. Do
  not make the Kernel judge professional quality.

## Operation, Approval, and recovery

- Route every external write through a versioned Adapter which creates one
  immutable Operation containing its typed request and faithful bounded
  preview. Local edits, builds, tests, cache updates, and read-only queries are
  not Operations.
- Use the Operation ID as the sole business identity and backend idempotency key
  where supported. Do not add operation, Approval, or view digests as parallel
  authorization identities.
- Process exact Approval and rejection as authenticated Human actions outside
  the model loop. Persist the actual preview and delivery metadata, reference
  the Operation ID directly, and recheck current policy before execution.
- Waiting for Approval must not keep a Matrix turn, model call, or execution
  process alive. Resume the same Task from durable state after the Human action,
  rejection, or expiry.
- Serialize Approval, rejection, expiry, cancellation, policy denial, and
  execution-start races. `operation-not-executed` must never follow a recorded
  execution start.
- Append `operation-execution-started` durably before invoking the Adapter. Do
  not automatically replay a started write after a crash, timeout, or lost
  response.
- Let Adapter code append success or safe failure only after it verifies the
  declared postcondition or absence of unresolved lasting effects.
- Treat uncertain and recovery-needed Operations as unresolved. Block
  conflicting writes and both forms of Work termination until observation or
  controlled repair establishes a known terminal event.
- Keep reconciliation on a privileged read-only Adapter interface. A recovery
  controller or authenticated Operator may invoke it; a Leader may only request
  it.
- A retry or later rollback is a new Operation with current policy and Approval.
  Immediate compensation belongs to the original invocation only when fully
  specified by its immutable request and preview.
- Keep immutable Operations and Operation events permanently in
  CoordinationStore. Keep bounded request replay rows as infrastructure state,
  not as a second domain ledger.

## Cancellation, budgets, and closure

- Before Task cancellation commits, stop and confirm the complete process tree,
  release its writer lock, terminate unstarted Operations as not executed, and
  preserve restricted recovery for every started unresolved Operation.
- Make Result submission and Task cancellation atomic competitors; the first
  committed transaction wins.
- On budget exhaustion, stop new model calls and local execution processes. Do
  not fabricate a Result, silently change model, or erase an already-started
  Operation.
- Before `complete-work` or `stop-work`, verify every Task has a Result or
  cancellation fact, no active turn/process/writer remains, every Operation has
  a known terminal event, no Approval or recovery path is pending, and every
  deliverable reference resolves.
- Keep semantic completion with the Leader. Closure checks enforce machine
  facts and must not encode a professional process.
- Commit closure, its timeline fact, terminal projection, and epoch update
  atomically. Reject late writes and never reopen a terminal Work.

## Verification

For a relevant runtime change, prove the deterministic contract first, then run
Basic or Full smoke according to `docs/rules/verification.md`. Preserve the
official Channel Plane in the real integration test.
