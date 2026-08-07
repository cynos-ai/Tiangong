# Evidence-backed team control architecture

> Status: accepted superseding target architecture; draft contract specification
> under closure. It replaces the fixed five-role, fixed-TaskKind, TeamPlaybook
> path as Tiangong's target direction. Public v0.2 remains the current
> implementation baseline until each target boundary is implemented and verified.
> This document does not authorize a delivery claim.
>
> Scope: target control contracts for coordination, trust and completion,
> external effects and authorization, organization and behavior shaping, quality
> and environment, knowledge retrieval, and runtime closure. Platform-specific
> adapters, physical topology, migrations, and unverified deferred contracts
> remain implementation work.

## 1. Purpose

Tiangong coordinates an AI team that can understand a software system, plan
work, delegate bounded Tasks, produce and verify deliverables, interact with
humans, and execute approved external effects.

The control architecture must preserve Agent and Team autonomy without trusting
model prose as machine fact. It therefore constrains critical boundaries rather
than prescribing every activity.

The target design is not a fixed software-delivery pipeline and is not a general
workflow DSL.

## 2. Design philosophy

### 2.1 Constrain rather than orchestrate

Neither an Agent nor the Team is driven through a predefined sequence of
activities. Agents may explore, edit, test, use tools, and revise their approach.
The Leader may create, parallelize, replace, or stop Tasks as the Work evolves.

The runtime intervenes at trust boundaries:

1. shape behavior with instructions, Skills, retrieved knowledge, and Concerns;
2. gate unauthorized or unsafe actions before they happen;
3. capture machine facts after trusted boundaries execute;
4. check the minimum machine-provable conditions before sealing a Result;
5. require a Leader or Human semantic decision where machine facts are not
   sufficient.

### 2.2 Two autonomous loops

The Agent loop is:

```text
Task
  -> instructions + Skills + RAG + Agent Concerns
  -> autonomous work
  -> Tool Gate + Evidence capture
  -> Result candidate
  -> Completion Check
  -> sealed Result or continued work
```

The Team loop is:

```text
Work
  -> Leader understanding and planning
  -> Task delegation
  -> Result submission
  -> Leader acceptance, replacement, or follow-up
  -> Human interaction when required
  -> Work completion decision or continued work
```

The framework owns deterministic safety, identity, persistence, recovery, and
proof. The Leader owns semantic interpretation, planning, delegation, and
communication.

Unique Leader means one coordination authority, not one global mutable model
session. Different Works may receive isolated Leader turns concurrently within
Team capacity. One Work has at most one current fenced Leader-turn lease, and
every coordination commit still uses Work-head compare-and-swap.

### 2.3 A Task never waits for a Human

A professional Agent does not suspend a Task while waiting for Human input or
authorization. Every dispatched Task ends with exactly one formal Result. An
undispatched Task may instead be terminally cancelled by CoordinationDecision:

- `completed`—the producer claims the Task objective was completed;
- `blocked`—an external decision, authorization, or dependency is required;
- `failed`—execution or a trusted machine boundary failed.

The Leader handles Human interaction and creates a new Task after the answer or
authorization is recorded. Exact high-risk authorization uses two Tasks:

```text
Prepare Task -> Human authorization -> Execute Task
```

### 2.4 Single source of truth

The same fact is not copied into multiple records.

Examples:

- Result does not store producer or creation time; trusted Evidence records the
  authenticated submitter and ledger time.
- Work does not store mutable status; it is projected from immutable records.
- Task does not contain a Result reference; Result points to Task.
- Supersession and acceptance are CoordinationDecisions, not mutable flags.
- A formal Task is the durable delegation that permits later scheduler dispatch;
  no separate DispatchIntent duplicates that authority.

### 2.5 Claim is not Evidence

The following are separate facts:

- model or Human claims;
- Artifact payloads;
- machine state;
- machine-captured Evidence;
- semantic acceptance;
- authorization.

A Result is a claim and a handoff. Evidence proves only that an authorized
Recorder recorded a bounded observation under an exact EventDefinition; its
assurance is limited by that Recorder and the deployment trust boundary. It does
not by itself prove an external effect, semantic correctness, or source truth.
Completion Check is a necessary machine-certification condition. An effective
Leader or Human-backed acceptance Decision is the authoritative semantic
disposition under exact policy, not proof that the Result is objectively
correct.

### 2.6 Meaning, legality, and strategy are separate

For an authoritative coordination action:

```text
action  -> what the record means
Guard   -> whether it is legal now
Leader  -> why and when to choose it
```

`CoordinationDecision.action` is therefore a code-owned semantic discriminator.
It does not define a process order. Display-only purpose and category labels are
non-authoritative.

### 2.7 Immutable facts, derived views

Work revisions, Tasks, Results, and CoordinationDecisions are immutable.
Ready, running, stale, accepted, rejected, superseded, and terminal are derived
views. Old facts are never rewritten to manufacture a cleaner history.

### 2.8 Superseding target and migration boundary

This architecture supersedes the current fixed delivery path as target
architecture, not as a claim about already deployed behavior. There is no
compatibility commitment requiring the target Kernel to preserve obsolete
workflow authority. Migration is vertical and fail closed: a target contract is
used only after its schemas, Guards, Evidence, recovery, and deterministic tests
exist together.

| Current public v0.2 mechanism | Target disposition |
| --- | --- |
| Five fixed RoleProfiles and role-specific images | Preserved as the first-party `software-change-delivery` TeamDefinition and AgentDefinition set; removed from Kernel enumeration. |
| Fixed `design`, `implement`, `assess`, and `release` TaskKinds | Removed as coordination authority; objectives and outputs move to WorkSpec, TaskSpec, Policy, Skill, and Checker contracts. |
| TeamPlaybook and TransitionPolicy stage path | Retained only as current implementation and reference material; not wrapped as a target workflow or DSL. |
| WorkRun, ProjectBinding, TaskBinding, and ResultEnvelope | Replaced by Work, Task, Result, CoordinationDecision, TaskRun, and ResolvedWorkPolicy records when the vertical target path is ready. |
| AgentTeams Project/Task files and Matrix messages | Adapter transport, storage carrier, or projection; prose and mutable platform files are not a second semantic authority. |
| File hash chain, idempotency store, Journal, and reconciliation | Useful implementation foundations upgraded to the exact ledger, Command, Operation, Anchor, fencing, and recovery contracts here. |
| Docker Runner and deployment clients | Replaceable Adapters under exact Workspace, Environment, Operation, Approval, Receipt, and cleanup contracts. |
| OpenTelemetry | Sanitized diagnostics only; never Evidence, authorization, or Completion proof. |

Current code and release documentation continue to describe v0.2 until migrated.
A first-party profile may preserve its proven professional separation without
making those roles or their order universal.

### 2.9 Ownership boundary

| Boundary | Owns | Does not own |
| --- | --- | --- |
| AgentTeams | Actual Team and Worker resource lifecycle, containers, platform storage transport, and platform identities and credentials. | Tiangong Work semantics, professional completion, Approval, Evidence meaning, or target roster admission. |
| OpenClaw | Matrix login, E2EE and room behavior, allowlists, mentions, sync, media, queueing, and delivery mechanics. | Agent capability, Human decision meaning, approval authority, or Result acceptance. |
| Tiangong | Worker runtime, TeamDefinition admission snapshot, Work, Task, Result, Decision, Policy resolution, Capability, Context, Gate, Evidence, Completion, Approval, quality, and recovery. | Platform resource creation or an unsupported platform isolation guarantee. |
| TeamDefinition | The immutable set of exact platform Team and Worker bindings admitted to one Tiangong roster generation. | Mutable platform presence, health, lifecycle, or automatic adoption of a platform roster change. |
| Runner, storage, model, index, and effect providers | Bounded physical execution or storage behavior exposed through reviewed Adapters. | Policy, Artifact identity, Evidence authority, Context authority, or authorization. |

Platform state is authoritative for whether a platform resource and authenticated
identity actually exist. TeamDefinition is authoritative for whether that exact
binding is admitted to a Work. Dispatch requires both to match. A platform
roster or Worker-generation change never mutates TeamDefinition; it requires a
new TeamDefinition and explicit Work revision.

AgentTeams files and messages may physically carry strict Tiangong records. Their
authority then comes from Tiangong schema, digest, Evidence, and Guard validation,
not from the file name, mutable prose, room role, or transport delivery. Tiangong
does not reimplement platform Team, container, Matrix, or storage lifecycle.

A deployment may claim tenant isolation only after end-to-end verification of
platform identity, Matrix, storage, containers, network, credentials, Runner,
knowledge realm, model provider, and administration boundaries. Otherwise its
security profile is explicitly single-tenant even if identifiers contain a
tenant field.

### 2.10 Threat model and assurance limits

The model, model prose, Human prose, Skills, retrieved content, repository and
document bytes, Workspace output, external responses, and mutable transport
state are untrusted inputs. A model cannot become trusted by repeating a Policy,
Evidence event, tool response, or source document.

The trusted computing base is intentionally bounded to authenticated platform
identity adapters; the versioned Control and Completion Kernels; schema and
registry validation; Policy resolution; Guards and Checkers; Artifact, protected
payload, Journal, and Evidence stores; Anchor signing and trust-root services;
fencing and lease managers; and each Recorder or effect Adapter only for its
allowlisted observation. Every member is pinned, revocable, least privileged,
and independently unable to expand its own authority.

Assurance limits are explicit:

- Evidence proves an authorized Recorder recorded the defined observation; a
  compromised or defective Recorder may forge facts within its authority.
- An Anchor detects later mutation, truncation, gaps, and forks relative to a
  trusted signed frontier; it does not prove that an event was true when
  recorded or that an omitted pre-Anchor action never happened.
- Receipt plus verified postcondition, not Recorder prose alone, establishes an
  external-effect outcome to the bounded assurance of the Adapter and provider.
- A Worker or container compromise invalidates the event families and secrets
  exposed to that boundary. Container isolation and possession of a Docker
  socket are not a hostile-host security boundary.
- A platform or host administrator is trusted in the local single-tenant
  profile. A hostile-administrator or multi-tenant claim requires a separately
  verified profile with separated credentials, storage, networks, signing keys,
  Runners, indexes, and administrative authority.
- Unknown identity, key status, schema, integrity, isolation, provider outcome,
  clock health, or recovery state fails closed. Availability loss may delay
  dispatch or abort execution but never widens permission or manufactures proof.

Supported deployment profiles are finite, reviewed Policy packages. The initial
public profile is local, single-tenant, and operator-trusted. A stronger profile
is a new verified contract, not an inference from the target architecture.

## 3. Concept layers

### 3.1 Business plane

The user and Leader reason primarily about:

```text
Work -> Task -> Result
```

- Work: one evolving Team engagement for a Human objective.
- Task: one immutable delegation to one accountable Agent.
- Result: the immutable terminal handoff for one Task.

### 3.2 Trust foundation

Four concepts form the trust chain:

- Artifact: what was produced;
- Evidence: what a trusted machine boundary observed;
- Operation: an external side effect;
- Approval: authorization for an exact or bounded Operation.

Artifact and Evidence are orthogonal. Artifact is an output carrier; Evidence
records a bounded observation by an authorized Recorder. Execution assurance
comes from the exact event sequence and, for external effects, Receipt and
verified postcondition. Operation is reserved for external side effects and does
not represent every read, write, or test tool call.

### 3.3 Lightweight organization

A Finding is a structured entry in `Result.findings`. It is not an independent
aggregate. The Leader may reference it from a later Task or promote it to a
long-lived issue or Artifact.

There is no universal Change object. Code, configuration, documentation, and
test changes are Artifact kinds.

### 3.4 Supporting coordination record

A CoordinationDecision is a required immutable backend record. It expresses
acceptance, rejection, Work revision linkage, Task replacement, Result
carry-forward, cancellation, Work termination, and explicit revocation.

An Evidence event authenticates who recorded the Decision and supplies trusted
ledger time within the Recorder and deployment assurance boundary; it does not
replace the Decision's semantics. Leader turns use runtime Evidence and leases but do not
create LeaderRun or CoordinationTurn business aggregates. Authority remains in
the Work, Task, Result, and CoordinationDecision records that a turn successfully
commits.

## 4. Common record and command discipline

All coordination records:

- use the canonicalization contract in section 4.1;
- have a versioned `schema`;
- are immutable after sealing;
- compute `contentDigest` over every field except the record's own
  `contentDigest` field;
- reject unknown fields;
- contain no generic metadata or extension bag;
- omit self-reported actor and time;
- use exact references containing identity and content digest;
- reject bare IDs and dangling references.

Record authenticity and trusted time come from the Evidence ledger.

### 4.1 Canonicalization, SchemaRef, and digest encoding

All signed or hashed JSON uses the versioned Tiangong JCS profile over
[RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785).
The `tiangong-jcs/v1` profile requires valid I-JSON input, UTF-8 encoding, no
duplicate object names, no lone Unicode surrogates, no Unicode normalization,
and no values outside the bound schema. JSON numbers are limited to safe
integers; decimal quantities, money, high-precision counters, and timestamps use
schema-defined canonical strings. NaN, infinity, negative zero, `undefined`, and
implementation-specific numeric values are invalid.

JCS object ordering is authoritative. Array order is preserved and semantic;
when order is irrelevant, the owning schema defines a unique sort key and rejects
duplicates. Omission and `null` are distinct: an optional absent field is omitted,
and `null` is legal only where the exact schema requires it.

A digest is lowercase `sha256:<64 lowercase hexadecimal characters>` over the
exact bytes selected by the owning contract. For a record `contentDigest`, the
input is the JCS encoding after removing only that record's own
`contentDigest`; nested referenced digests remain. Signature and event hashing
state their own selected fields explicitly. Digest and signature values in this
document's examples, including `"sha256"` and `"sha256:<64hex>"`, are
non-validating placeholders unless explicitly identified as test vectors.

A SchemaRef is the exact reference for a non-executable structural schema:

```json
{
  "schemaId": "tiangong.schema/work-spec",
  "version": "1",
  "contentDigest": "sha256:<64hex>"
}
```

Schema packages are immutable, reviewed, content addressed, and retained for the
records that use them. A schema change creates a new version and digest; current
registry selection never changes historical interpretation. Cross-language
Adapters must pass common canonicalization and digest fixtures before they may
write authoritative records.

### 4.2 CommandEnvelope and idempotent replay

Every authoritative command enters a trusted command boundary through a strict
CommandEnvelope:

```json
{
  "schema": "tiangong.command-envelope/v1",
  "commandId": "cmd-123",
  "commandType": "create_work",
  "commandDefinitionRef": {
    "implementationId": "command/create-work",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "payloadDigest": "sha256",
  "expectedStateRefs": [],
  "contentDigest": "sha256"
}
```

The exact CommandDefinition pins payload SchemaRef, identity derivation,
authenticated authority rule, Guard, expected-state schema, atomic output schema,
EventDefinitions, redaction, and recovery behavior. It is reviewed code, not a
Prompt-defined command.

The authenticated ingress, Leader runtime, scheduler, Agent runtime, or
administrative boundary derives or allocates `commandId` in its own collision-
resistant namespace. A model-supplied ID is never trusted directly. Examples of
stable source identities are exact channel-message identity for ingress, TaskRef
plus dispatch generation for scheduler dispatch, and TaskRunRef plus Context
invocation and call ordinal for an Agent command. Authenticated actor and trusted
time come from execution context and Evidence, not the envelope.

Before any authoritative output becomes visible, the command boundary durably
persists the bounded CommandEnvelope and reserves its idempotency identity. Raw
or protected command payload remains in the protected store when recovery needs
it and is bound only by `payloadDigest`; it does not enter the envelope or
Evidence.

The idempotency store binds command boundary, CommandDefinitionRef, commandId,
envelope digest, and committed output refs. Identical replay returns the exact
saved output without re-execution. The same identity with another envelope or
payload digest conflicts. Expected-state refs are CAS preconditions, not command
identity. A multi-record command uses one transaction or a write-ahead intent,
outbox, and visibility commit that provides the same replay semantics. Envelope,
idempotency binding, and output refs remain available for their audit and replay
horizon.

## 5. Package 1: coordination — Work contract

Package 1 comprises sections 5–15 and defines Work, Task, Result,
CoordinationDecision, scheduling legality, completion exit, Evidence meanings,
recovery, and concurrency without prescribing a workflow.

Work has a stable logical `workId` and one or more immutable physical revisions.

```json
{
  "schema": "tiangong.work/v1",
  "workId": "work-123",
  "revision": 1,
  "teamRef": {
    "teamId": "team-1",
    "contentDigest": "sha256"
  },
  "specRef": {
    "artifactId": "work-spec-1",
    "contentDigest": "sha256"
  },
  "policyRef": {
    "policyId": "resolved-work-policy/work-123-r1",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins interpretation. |
| `workId` | Connects immutable revisions to one logical engagement. |
| `revision` | Supports monotonic scope versioning, concurrency checks, and missing-revision detection. |
| `teamRef` | Pins the accountable Tiangong TeamDefinition and admitted roster snapshot. |
| `specRef` | Pins the objective, scope, acceptance criteria, and Human constraints. |
| `policyRef` | Pins resolved budget, quality, reporting, and approval policy. |
| `contentDigest` | Lets Tasks and Decisions bind an exact Work revision. |

Work excludes mutable status, current flags, inline scope copies, requester,
timestamps, role bindings, progress, arbitrary metadata, and a direct
supersession field. Revision relationships are CoordinationDecisions.

### 5.1 Human ingress and Work identity

Each independent Human objective creates an independent Work. A reply to an
exact HumanInteraction or Work reference appends input to that Work; an explicit
scope change may produce a new Work revision. Exact channel-message replay
returns the original admission result. Ambiguous input never silently mutates an
existing Work and instead creates a new Work when policy permits.

IngressPolicy is a strict platform- or tenant-administrative Policy evaluated
before Work creation and may be narrowed for an exact team identity. It is not a
TeamPolicy slot and is never materialized into ResolvedWorkPolicy. It controls
authentication, deduplication, routing, abuse and hard-tenant quotas, and initial
HandlingPolicy selection. It cannot decide Work semantics, create Agent
capability, authorize an Operation, or substitute for Leader judgment.

Ingress has one non-circular admission protocol:

```text
record human-request.received in the administrative ingress ledger
-> evaluate exact IngressPolicy and authenticated routing facts
-> on denial, append human-request.admission-denied
-> on allowance, reserve workId and the Work ledger
-> atomically or outbox-equivalently commit:
     Work + work.recorded + human-request.admitted(WorkRef)
-> make the Work visible to Leader scheduling only after all three bindings verify
```

`create_work` consumes the received EvidenceRef and current positive policy
evaluation; it does not require a pre-existing `human-request.admitted` event.
The admitted event is the durable positive decision and binds the resulting
WorkRef, Work recording EvidenceRef, exact IngressPolicyRef, and received
EvidenceRef. If administrative and Work ledgers use different physical stores, a
write-ahead intent and outbox recover the exact reserved identities; partial
output remains invisible until the visibility commit. Replay completes that
outbox or returns the original Work and never allocates another Work.

Each ingress event binds exact IngressPolicyRef, trusted channel-message identity,
and bounded payload digest. Raw Human content is a Claim Artifact under
HandlingPolicy. Denied input remains a bounded administrative fact rather than
disappearing from audit.

Every authenticated, policy-admissible request is durably captured even when no
Leader or Task execution slot is available. Execution capacity may delay a
Leader turn or Task dispatch but cannot create an undefined pre-Work queue.
`maxOpenWorksPerTeam` is therefore not an execution-concurrency control; tenant
admission and abuse limits belong only to IngressPolicy.

Different Works have independent revisions, ResolvedWorkPolicy, Human authority,
Evidence Ledger, Tasks, Results, Decisions, budget, reporting, Context, and
Handling boundary. Sharing a TeamDefinition or Leader never merges their
transcripts, confidential content, or authoritative order.

### 5.2 WorkSpec and TaskSpec Artifacts

WorkSpec and TaskSpec are strict typed Artifact payloads. Their formal identity
is the outer ArtifactRef from section 19; their payload does not carry another
ID or content digest. A minimal WorkSpec payload is:

```json
{
  "schema": "tiangong.work-spec/v1",
  "objective": "Deliver the bounded Human objective.",
  "scope": {
    "included": [],
    "excluded": []
  },
  "acceptanceCriteria": [
    {
      "criterionId": "criterion-1",
      "statement": "The requested behavior is delivered and independently verified."
    }
  ],
  "inputRefs": [],
  "humanConstraintRefs": []
}
```

A minimal TaskSpec payload is:

```json
{
  "schema": "tiangong.task-spec/v1",
  "objective": "Produce the exact delegated outcome.",
  "workCriterionIds": ["criterion-1"],
  "expectedOutputs": [
    {
      "artifactSchemaRef": {
        "schemaId": "tiangong.artifact-schema/change-set",
        "version": "1",
        "contentDigest": "sha256"
      },
      "minimumCount": 1,
      "maximumCount": 1
    }
  ],
  "semanticConstraints": []
}
```

Strings and arrays are bounded by their exact SchemaRefs. WorkSpec `inputRefs`
are exact committed RecordRefs or ArtifactRefs; `humanConstraintRefs` are exact
Claim ArtifactRefs captured under HandlingPolicy. Criterion IDs are unique and
stable only inside that exact WorkSpec Artifact.

TaskSpec `workCriterionIds` are unique and must resolve to criteria in the exact
WorkSpec bound by Task WorkRef. Expected-output entries have unique SchemaRefs,
non-negative safe-integer cardinalities, and `maximumCount >= minimumCount`.
They state expected delivery shape but do not create pending prerequisites;
Task.inputRefs remains the complete already-committed execution input set.

Criteria and semantic constraints are Claims, not machine proof or permission.
WorkSpec and TaskSpec contain no role, stage, TaskKind, workflow edge, tool grant,
Approval, mutable status, or extension bag. TaskSpec cannot silently add Work
scope. CompletionPolicy and ClosurePolicy provide the separate machine-
certification contracts.

## 6. Task contract

Task is one immutable delegation. It has no revision. Any change to its scope,
assignee, inputs, execution constraints, or completion contract creates a new
Task.

```json
{
  "schema": "tiangong.task/v1",
  "taskId": "task-123",
  "workRef": {
    "workId": "work-123",
    "revision": 2,
    "contentDigest": "sha256"
  },
  "assigneeRef": {
    "memberId": "member-implementor",
    "memberBindingDigest": "sha256"
  },
  "specRef": {
    "artifactId": "task-spec-123",
    "contentDigest": "sha256"
  },
  "inputRefs": [],
  "executionPolicyRef": {
    "policyId": "task-execution/default",
    "version": "1",
    "contentDigest": "sha256"
  },
  "completionPolicyRef": {
    "policyId": "task-completion/code-change",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins interpretation. |
| `taskId` | Provides stable Team routing and Human-readable identity. |
| `workRef` | Pins the exact scope revision. |
| `assigneeRef` | Selects one exact Team member binding within the Task WorkRef. |
| `specRef` | Pins the Task objective, expected outcomes, and semantic constraints. |
| `inputRefs` | Pins the complete immutable baseline and already-committed inputs. |
| `executionPolicyRef` | Pins tool, environment, budget, and effect constraints. |
| `completionPolicyRef` | Pins the minimum machine-provable completion contract. |
| `contentDigest` | Lets Result bind the exact delegation. |

`assigneeRef` is a bounded MemberRef composite. The Task WorkRef resolves one
exact TeamDefinition; `memberId` selects one member and
`memberBindingDigest = digest("sha256", jcs("tiangong-jcs/v1", exact member
entry))` binds its workerRef and AgentDefinitionRef without copying them into
Task. Dispatch re-resolves that
entry, verifies the digest and live platform binding, and derives provider,
Worker generation, AgentDefinition version, and member concurrency limits.

Task excludes TaskKind, mutable status or phase, Task revision, supersession,
duplicate dependency fields, inline semantic specification, Skill selection,
environment and budget copies, Result references, Operation and Approval
references, actor and time, parent Task, and attempt count.

Task creation is a real delegation eligible for deterministic scheduler dispatch,
not a draft planning card and not proof that capacity exists. Leader plans that
are not yet authorized for dispatch remain reasoning or a non-authoritative
planning Artifact whose payload is a Claim and grants no Task creation or
dispatch authority.

## 7. Result contract

```json
{
  "schema": "tiangong.result/v1",
  "taskRef": {
    "taskId": "task-123",
    "contentDigest": "sha256"
  },
  "outcome": "completed",
  "claim": "The Task objective was completed.",
  "artifactRefs": [],
  "evidenceRefs": [],
  "findings": [],
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins interpretation. |
| `taskRef` | Binds the handoff to an exact Task. |
| `outcome` | Gives a machine-readable terminal meaning: `completed`, `blocked`, or `failed`. |
| `claim` | States what the producer says was achieved or prevented. |
| `artifactRefs` | Identifies the formal outputs. |
| `evidenceRefs` | Identifies machine facts offered in support of the claim. |
| `findings` | Preserves individually addressable discoveries for Leader disposition. |
| `contentDigest` | Gives the Result immutable identity. |

A minimal Finding contains a statement and Evidence references. A Finding is
addressed by Result digest and JSON Pointer; it has no independent ID or mutable
status.

Result excludes a separate ID, WorkRef, producer, timestamps, assignee, input
copies, Skill references, acceptance policy, Completion Check outcome, acceptance
state, Operation and Approval references, next action, blocker taxonomy,
revision index, duplicate summary, and extension metadata.

## 8. CoordinationDecision contract

```json
{
  "schema": "tiangong.coordination-decision/v1",
  "action": "accept-result",
  "subjects": [
    {
      "role": "result",
      "ref": {
        "taskId": "task-123",
        "contentDigest": "sha256"
      }
    },
    {
      "role": "target-work",
      "ref": {
        "workId": "work-123",
        "revision": 2,
        "contentDigest": "sha256"
      }
    }
  ],
  "basisRefs": [],
  "claim": "The Result satisfies the current Work revision.",
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins interpretation. |
| `action` | Tells deterministic Projection what the record means. |
| `subjects` | Names exact affected records and their directional roles. |
| `basisRefs` | Pins facts and Artifacts used as the decision basis. |
| `claim` | Records the semantic rationale without pretending it is Evidence. |
| `contentDigest` | Enables exact reference and explicit revocation. |

The authoritative action vocabulary is:

| Action | Required subject roles |
| --- | --- |
| `revise-work` | `source-work`, `target-work` |
| `accept-result` | `result`, `target-work` |
| `reject-result` | `result`, `target-work` |
| `supersede-task` | `source-task`, `target-task` |
| `carry-forward-result` | `source-result`, `source-work`, `target-work` |
| `cancel-task` | `task`, `target-work` |
| `complete-work` | `target-work` |
| `fail-work` | `target-work` |
| `cancel-work` | `target-work` |
| `revoke-decision` | `decision`, `target-work` |
| `revoke-approval` | `approval`, `target-work` |

A new action requires a code-owned subject schema, Guard, Projection rule,
truth table, and deterministic tests. Skills, TeamPolicy, and models cannot
invent actions.

CoordinationDecision excludes a separate ID, non-authoritative type, arbitrary
payload, actor, timestamp, mutable status, a reversed flag, resulting state,
metadata, and extension fields.

## 9. Coordination invariants

### 9.1 Records

1. Work, Task, Result, and CoordinationDecision are immutable.
2. Every reference resolves to a committed record with a matching digest.
3. Actor and time come from Evidence.
4. Operational views are derived and never written back into immutable records.
5. Identical command replays are idempotent; the same command identity with
   different input is a conflict.

### 9.2 Work

1. Genesis revision is `1`.
2. A new revision is current revision plus one.
3. Only the current effective head may be revised.
4. Revision forks and cycles are forbidden.
5. A new revision changes no earlier record.
6. The current head is derived from valid `revise-work` Decisions.

### 9.3 Task

1. One Task has exactly one assignee.
2. Task has no revision.
3. One Task has at most one sealed Result.
4. A Task never waits for a Human.
5. Every input must be committed, resolvable, and authorized before Task creation.
6. `inputRefs` point only to earlier immutable records or Artifacts. There is no
   pending prerequisite or scheduler-owned dependency edge.
7. New Tasks bind the current Work revision.
8. An undispatched old-revision Task cannot be dispatched.
9. A running old-revision Task may finish, but its Result is not automatically
   eligible under the new Work revision.
10. Task supersession targets only the current supersession leaf and cannot
    fork or cycle.
11. A valid formal Task is the durable scheduler authority for its exact
    delegation; there is no separate DispatchIntent.
12. Dispatch eligibility requires the Task to be current, undispatched,
    uncancelled, unsuperseded, without Result or TaskRun; every exact input must
    remain resolvable, available, permitted, and unrevoked; all policies and
    security facts must remain valid.
13. Capacity shortage leaves the Task undispatched with no TaskRun, waiting
    Agent, or fabricated blocked Result.
14. Dispatch atomically reserves exact capacity, records `task.dispatched`, and
    opens the Task's one TaskRun.

### 9.4 Result and acceptance

1. Every outcome passes its applicable CompletionPolicy before sealing.
2. A failed Completion candidate is not a Result.
3. `blocked` and `failed` cannot be accepted as completion.
4. Completion Check pass is necessary. An effective Leader or Human-backed
   acceptance Decision is authoritative semantic disposition under policy, not
   proof of objective correctness.
5. Accept and reject cannot both be effective for one Result.
6. A Result from an ancestor Work revision requires an effective
   `carry-forward-result` before acceptance in the current revision.
7. Carry-forward requires the Result to have been accepted in its source Work.

### 9.5 Decision

1. `action` is an authoritative semantic discriminator.
2. Subject roles and cardinality match the action schema.
3. Decision legality is determined by Coordination Guard.
4. Decisions are append-only.
5. Reversal is a new `revoke-decision`; the original remains historical fact.
6. A revoke cannot target another revoke.
7. Coordination revocation cannot erase an external side effect.
8. Decision references point backward in the committed ledger and cannot cycle.

### 9.6 Scheduling

1. Scheduler is trusted machine coordination, not business authority.
2. It may choose when an eligible Task consumes capacity under code-owned
   FairnessPolicy and Guards.
3. It cannot create Tasks, change assignee or scope, infer semantic priority from
   model prose, bypass policy, or manufacture capacity.
4. Queue, slot, lease, and availability are mutable machine state and rebuildable
   Projection, never Work or Task status fields.
5. Fairness prevents one Work from consuming all Team slots; only strict,
   authority-checked priority inputs may affect ordering.

### 9.7 Action-specific Decision revocability

`revoke-decision` is deliberately narrow. “No unhandled irreversible dependency”
is implemented as an exact reverse-dependency Projection and the following
code-owned matrix:

| Target action | Revocable? | Additional deterministic conditions |
| --- | --- | --- |
| `accept-result` | yes, while Work is open | Result has no effective dependent Task execution, accepted downstream Result, carry-forward, QualityAssessment consumption, Operation, Approval, Human disposition, or Work closure. |
| `reject-result` | yes, while Work is open | No effective replacement, dependent Task execution, Human disposition, or terminal Work Decision depends on the rejection. |
| `carry-forward-result` | yes, while Work is open | Target-scope Result has not been accepted or consumed by a downstream Task, quality fact, effect, or closure. |
| `revise-work` | no | Correction creates a later Work revision or a new Work; committed descendants are never orphaned. |
| `supersede-task` | no | Correction creates another replacement from the current effective leaf. |
| `cancel-task` | no | A new Task is required; the cancelled delegation is not silently revived. |
| `complete-work`, `fail-work`, `cancel-work` | no | Terminal Work is never reopened; correction or recovery starts from a new Work. |
| `revoke-decision`, `revoke-approval` | no | Revocation cannot revoke itself or restore consumed authority. |

Any effective dependent Decision that is itself revocable must be revoked first,
producing reverse topological order. Immutable dependent records remain history,
but the Guard requires their effective authority to be removed or terminally
resolved. A TaskRun start, external execution start, consumed Approval, delivered
HumanInteraction, or terminal Work Decision is irreversible for coordination
purposes. Revocation never deletes Evidence, Artifact, Receipt, Journal, or
external state.

Revoking acceptance or rejection leaves the Result without an effective
semantic disposition. Revoking carry-forward removes only target-revision
eligibility and never changes source acceptance. Commit serializes on the target
Decision, current Work head, reverse-dependency frontier, and current Leader
epoch; a concurrent descendant or terminal Decision wins or conflicts rather
than being missed.

## 10. Scope revision and staleness

A scope change creates a new Work revision and a `revise-work` Decision.

- An undispatched Task on the prior revision must be replaced.
- A running Task may finish to preserve Task atomicity.
- Its Result remains historically valid for the exact Task.
- It is not eligible for current-revision acceptance without carry-forward.
- An accepted Result remains an accepted historical fact.
- Current Work closure considers only current accepted Results and explicitly
  carried-forward ancestor Results.

Staleness is therefore a relationship, not a mutable Result status:

```text
Result.Task.WorkRef != current WorkRef
and no effective carry-forward to current WorkRef
```

A carry-forward Decision binds all three directions explicitly: source Result,
source Work revision, and target Work revision.

Work revision, Task cancellation or supersession, and dispatch linearize against
the same current Work head and Task execution ownership. If invalidation commits
first, dispatch is denied. If dispatch commits first, the Task is running and
must terminate through Result; a later Work revision may make that Result stale
but cannot pretend the execution never started.

## 11. Coordination commands and Guards

| Command | Deterministic Guard | Atomic or recovery-equivalent output |
| --- | --- | --- |
| `create_work` | Exact received ingress Evidence; current positive IngressPolicy evaluation; authenticated authority; reserved new workId and ledger or identical CommandEnvelope replay; revision 1; valid Team and Spec; ResolvedWorkPolicy source matches TeamPolicy and Kernel | Work + `work.recorded` + `human-request.admitted` through one transaction or visibility-gated outbox, or original WorkRef for identical replay |
| `revise_work` | Current Leader-turn fencing epoch; source is current head; target is same workId and revision +1; no fork; no executing or uncertain Operation; Team and ResolvedWorkPolicy provenance coherent; changes authorized | target Work + revise Decision + Evidence |
| `create_task` | Current open Work; valid Team member and Agent definition; valid inputs; Task policies derive from ResolvedWorkPolicy and do not expand permission; creation is immediate scheduler delegation | Task + Evidence |
| `dispatch_task` | Task is current, undispatched, uncancelled, unsuperseded, without Result or TaskRun; exact inputs remain resolvable, available, permitted, and unrevoked; MemberRef and live platform binding match; exact Team, Work, provider, Runner, budget, Workspace, policy, security, and resource capacity reserved | atomic slot reservation + dispatch Evidence + one TaskRun |
| `submit_result` | Authenticated assignee or trusted framework; exact TaskRef; no prior Result; valid refs; applicable CompletionPolicy passes | Result + Completion/recording Evidence |
| `accept_result` | Completed Result; Completion Check valid and anchored; no conflicting disposition; current scope or valid carry-forward; exact semantic authority under policy | accept Decision + Evidence |
| `reject_result` | Existing Result; no conflicting disposition; bounded rationale and basis | reject Decision + Evidence |
| `supersede_task` | Source is an unsuperseded non-running leaf with no effective acceptance; replacement is a new valid current-revision Task; no cycle or branch | replacement Task + supersede Decision + Evidence |
| `carry_forward_result` | Source Result accepted in source Work; source is ancestor of current target; Evidence remains fresh | carry-forward Decision + Evidence |
| `cancel_task` | Task is undispatched and has no Result or prior cancellation/supersession | cancel Decision + Evidence |
| `complete_work` | Current head; exact complete-work ClosurePolicy branch passes; required Results accepted; required QualityAssessment is fresh and satisfied; no required Human response, running Task, pending effect, or unresolved uncertainty | anchored `closure.checked(pass)` -> complete Decision + recording Evidence + terminal Anchor visibility commit |
| `fail_work` | Current head; exact fail-work ClosurePolicy branch passes; safe continuation exhausted; effects resolved or explicitly uncertain; failure and recovery Evidence complete | anchored `closure.checked(pass)` -> fail Decision + recording Evidence + terminal Anchor visibility commit |
| `cancel_work` | Current head; exact cancel-work ClosurePolicy branch passes; authorized cancellation; Tasks and effects safely terminated; Human decision when required | anchored `closure.checked(pass)` -> cancel Decision + recording Evidence + terminal Anchor visibility commit |
| `revoke_decision` | Target action is revocable under section 9.7; Work remains open; authenticated authority; current Leader epoch and Work head; exact reverse-dependency frontier has no effective descendant or irreversible fact | revoke Decision + Evidence |

A dispatched Task is not cancelled by a coordination flag. If execution must be
stopped, the runtime terminates the TaskRun, preserves Evidence, resolves or
marks external effects uncertain, and seals a failed Result.

## 12. Completion exit and Work closure

```text
completed candidate
  -> Completion Check pass -> sealed Result
  -> Completion Check fail
       -> normal repair inside the Task
       -> blocked candidate when an external condition is truly required
       -> failed candidate when recovery is not possible
       -> framework-produced failed Result when execution budget is exhausted
```

Completed, blocked, and failed outcomes have different minimum policies. A
blocked policy must prevent the Agent from using `blocked` to bypass completed
requirements. It verifies that existing outputs and Evidence are preserved,
no effect remains active, and the blocker is supported as far as machine facts
permit.

### 12.1 ClosurePolicy contract

ClosurePolicy is the deterministic Work-terminal certification contract selected
through the `work-closure` ResolvedWorkPolicy slot:

```json
{
  "schema": "tiangong.closure-policy/v1",
  "policyId": "work-closure/software-change-delivery",
  "version": "1",
  "kernelRef": {
    "kernelId": "tiangong-closure-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "outcomeChecks": {
    "complete-work": [],
    "fail-work": [],
    "cancel-work": []
  },
  "contentDigest": "sha256"
}
```

Each list contains exact deterministic CheckerRefs with strict parameters. The
Closure Kernel always revalidates current Work head and Team; WorkSpec and policy
provenance; effective Result dispositions; required accepted criteria and
Artifacts; Completion and Anchor validity; required fresh QualityAssessment;
Human decisions; TaskRun, lease, and resource termination; Operation, Approval,
Journal, uncertainty, compensation, and recovery state; required reporting; and
retention pins. Each terminal action has a distinct branch, so failure or
cancellation cannot bypass disclosure and safety requirements.

ClosurePolicy contains no stage list, TaskKind, workflow edge, model checker,
arbitrary script, or boolean-expression DSL. A machine pass makes a terminal
Decision eligible; it does not choose the semantic outcome or prove the Work
objective objectively correct.

A closure check binds an `inputFrontier` containing the pre-check Work-ledger
terminal EvidenceRef and a digest of every Work head, effective Decision,
Task/Result/TaskRun, Human, quality, resource, Operation, Approval, Journal,
Policy, and retention fact consumed by the Checkers. It appends
`closure.checked(pass)` as the next Work-ledger event and synchronously Anchors
through that event. Anchor audit events live in the administrative security
ledger and do not alter the Work frontier.

The terminal commit accepts only the exact `inputFrontier` followed by that one
expected `closure.checked` event. It rechecks current Leader epoch, Work head,
reverse dependencies, live revocations, and all external mutable preconditions
before appending the terminal Decision and `decision.recorded`. Any unrelated or
changed Work-ledger event, projection digest, or live fact makes the check stale
and creates no Decision. A final Anchor and visibility commit make termination
authoritative to consumers. Crash recovery completes this exact staged outbox or
leaves the Work open; it never guesses termination from a partial write.

## 13. Required Evidence semantics

Package 1 requires these event meanings. Package 2 supplies the common Evidence
envelope, and each owning package supplies the strict event-specific facts
schema and Recorder authority:

| Event | Required binding |
| --- | --- |
| `human-request.received` | trusted channel-message identity, bounded payload digest, exact IngressPolicyRef |
| `human-request.admitted` | received EvidenceRef, exact IngressPolicyRef, WorkRef, TeamRef, and `work.recorded` EvidenceRef |
| `human-request.replayed` | original received and admission EvidenceRefs; no new Work |
| `human-request.admission-denied` | received EvidenceRef, exact IngressPolicyRef, stable denial code |
| `work.recorded` | Work digest, authenticated actor, exact CommandEnvelope digest |
| `leader-turn.started` | exact WorkRef and head, Leader, Evidence frontier, SchedulerPolicyRef, Team slot and lease epoch |
| `leader.context.assembled` | started EvidenceRef, policy-filtered context digests, runtime and model identity |
| `leader-turn.completed` | started EvidenceRef and committed record EvidenceRefs, if any |
| `leader-turn.aborted` | started EvidenceRef and stable abort or stale-owner code |
| `task.recorded` | Task digest, WorkRef, Leader actor, started Leader-turn EvidenceRef |
| `capacity.observed` | exact administrative scope, code-owned metric and unit, bounded capacity values, generation, validity deadline, exact Adapter implementation |
| `team-scheduler-policy.selected` | stable team identity, exact SchedulerPolicyRef, prior selection when present, monotonic selection generation and administrative authority |
| `scheduler.slot-reserved` | TaskRef, Team, Work, member, Worker, exact SchedulerPolicyRef, slot IDs, capacity generation, source capacity EvidenceRefs and lease epoch |
| `scheduler.capacity-unavailable` | eligible TaskRef, exact SchedulerPolicyRef, bounded unavailable dimensions and observed capacity EvidenceRefs |
| `scheduler.slot-released` | reservation EvidenceRef, terminal or fenced release basis and current epoch |
| `scheduler.lease-suspect` | reservation EvidenceRef, last known owner generation and stable suspect code |
| `scheduler.lease-reconciled` | suspect EvidenceRef, fencing result and released or resumed disposition |
| `workspace.binding-prepared` | TaskRef, exact WorkspaceBindingRef, Runner generation and lease epoch |
| `workspace.resource-lease-acquired` | normalized resource identity, owner TaskRunRef, policy, generation, epoch and expiry |
| `workspace.resource-lease-released` | acquisition EvidenceRef, fenced owner and release basis |
| `task.dispatched` | TaskRef, assignee, TaskRunRef and slot-reservation EvidenceRef |
| `completion.checked` | TaskRef, candidate digest, policy digest, checker outcomes |
| `closure.checked` | WorkRef, proposed terminal action, ClosurePolicy, Kernel and Checker digests, exact projection frontier, outcome and reason codes |
| `result.recorded` | Result digest, TaskRef, authenticated submitter |
| `decision.recorded` | Decision digest, action, authenticated actor |
| `coordination.command.denied` | exact CommandEnvelope digest, subject digests, stable reason code |
| `task-run.budget-exhausted` | TaskRef, TaskRunRef, execution policy |
| `task-run.terminated` | TaskRef, TaskRunRef, known failure or uncertain effect outcome |

Ingress events are emitted only by the trusted Ingress Recorder in an
administrative ingress ledger. Leader-turn events are emitted only by the
trusted Leader Runtime Recorder in the exact Work ledger. Scheduler events are
emitted only by the trusted Team Scheduler Recorder. Workspace and resource-
lease events are emitted only by the trusted Workspace or Runner Manager
Recorder. Capacity Adapter events are emitted into an administrative capacity
ledger only by the exact Adapter implementation allowlisted for that code-owned
metric. `team-scheduler-policy.selected` is emitted only by the trusted
administrative Policy Registry Recorder. `completion.checked` is emitted only by
the Completion Kernel Recorder for the exact TaskRun; `closure.checked` is
emitted only by the Closure Kernel Recorder for the exact current Work frontier.

`capacity.observed` facts have a strict schema: exact scope reference, metric
enum, unit enum, non-negative bounded values, source generation, `validUntil`,
and Adapter implementation digest. Unknown metrics or units, inconsistent
values, missing generation, expired observation, or Recorder mismatch fail
closed. Scheduler Evidence cites capacity EvidenceRefs rather than impersonating
the Adapter.

`scheduler.slot-reserved` proves machine allocation only; `task.recorded` is the
delegation authority and `task.dispatched`, committed with TaskRun opening, is
the authoritative dispatch fact. Successful `work.recorded`, `task.recorded`,
and `decision.recorded` events and denied `coordination.command.denied` events
may reference the earlier `leader-turn.started`; no duplicate leader-command
event meanings exist.

Recording Evidence is not included in the recorded object's own references;
that would form a digest cycle. Trust is verified through the Evidence ledger's
reverse binding to the object digest.

## 14. Recovery and bounded concurrency

Recovery validates schemas, object digests, exact references, Evidence,
SchedulerPolicy, capacity generations, leases, and fencing epochs before
projecting state. It reconstructs Work heads, Task relationships, Results,
dispositions, carry-forward, revocation, and terminal decisions from immutable
records. Forks, cycles, missing references, conflicting Results, invalid
Evidence, and stale ownership fail closed. Model transcripts are not authority.

### 14.1 Leader turns

The unique Leader is reentrant across isolated Works. Each Leader turn binds one
exact WorkRef, current Work head, ResolvedWorkPolicy, accepted Results, Team
Concern snapshot, policy-filtered cross-Work resource facts, Evidence frontier,
runtime, model, and context digests. There is no global mutable Leader
conversation.

One Work has at most one current coordination-turn lease. Lease acquisition or
ownership transfer increments a monotonic fencing epoch. The lease reduces
duplicate reasoning but sits above the correctness boundary: every coordination
commit verifies current epoch, expected Work head, Evidence frontier, and
relevant facts, then performs compare-and-swap. Expiry, crash, delayed messages,
or split ownership cannot turn stale model output into authority. A stale turn
is aborted and replanned from current facts. Different Works may run Leader
turns concurrently within live Team capacity.

### 14.2 Dispatch and capacity

The scheduler selects only eligible undispatched Tasks already authorized by
Leader creation. It applies immutable Work ceilings, live Team and Worker
capacity, FairnessPolicy, infrastructure observations, budgets, and resource
leases. It does not create or reinterpret Tasks.

Dispatch reserves exact slots and WorkspaceBinding, appends reservation and
dispatch Evidence, and opens the one TaskRun in one transaction or recovery-
equivalent write-ahead protocol. The internal transaction intent is not a
business DispatchIntent and grants no authority beyond the Task. If preparation
or capacity is unavailable, the Task remains undispatched and the scheduler may
retry its Guard without a Leader polling loop.

Work revision, cancellation, supersession, and dispatch compare the same current
head and Task ownership facts at their linearization boundary. Invalidation first
makes the Task ineligible. Dispatch first creates running execution that must
terminate through Result.

Effective concurrency is the minimum of immutable Work and member ceilings,
live Team and Worker slots, model-provider quotas, CPU and memory, Runner and
container slots, Workspace and storage capacity, external-service quotas, cost
and token budget, resource leases, and useful independent work. A model cannot
claim capacity or override backpressure.

### 14.3 Lease fencing and recovery

Every reclaimable Leader-turn, TaskRun execution-owner, scheduler slot, Runner,
Workspace, and internal resource lease carries a monotonically increasing
fencing epoch. Ownership transfer invalidates the old epoch before capacity is
reused. Authoritative mutation boundaries verify the current epoch, including
Evidence append, Artifact sealing, Result sealing, Task dispatch, Operation
Journal attempts by a TaskRun, and lease transitions.

Raw filesystem writes cannot always inspect an epoch. Workspace and Runner
fencing therefore terminates or isolates the old process or container and binds
a new generation. Bytes produced by a stale epoch may remain physical but cannot
be sealed as a trusted Artifact or Result. Capacity is released only after the
old owner is fenced from authoritative writes.

A lost TaskRun never causes a second TaskRun for the same Task. Recovery marks
its lease suspect, inspects TaskRun, tool and Operation Journals, Evidence,
Workspace, and external uncertainty, fences the old execution, and resumes the
same runId under a current epoch only when every exact binding remains valid.
Otherwise the framework seals a failed Result and the Leader may create a
replacement Task.

### 14.4 Narrow serialization and shared resources

Concurrency uses compare-and-swap and narrow locks:

- Work revision compares the expected current head digest;
- Result submission serializes per Task;
- supersession compares the expected source leaf;
- conflicting dispositions serialize per Result;
- carry-forward rechecks the target head at commit;
- Work completion rechecks all closure facts at commit;
- one Work Evidence Ledger serializes only its short append transaction.

Same-digest replay succeeds. Same identity with different content is a conflict.
Last-write-wins is forbidden. Multi-record commands use a transaction or write-
ahead intent plus Evidence outbox and commit marker. Uncommitted records are
invisible to Projection.

Parallel Tasks share immutable input digests but use separate
WorkspaceBindings. Tasks that produce independent files or modules preserve
independent Artifacts. Overlapping output uses non-overlapping ownership known
before dispatch, independent patch Artifacts plus a later integration Task, or
an exclusive internal resource lease. Two TaskRuns never mutate the same
physical workspace, and last writer wins is forbidden.

Internal shared resources use normalized identity, strict ResourceLeasePolicy,
generation, owner TaskRunRef, fencing epoch, expiry, and trusted Workspace or
Runner Manager Evidence. External branches, environments, services, databases,
tickets, and publication targets additionally use Operation Gate preconditions,
idempotency, and Operation Journal serialization. Model cooperation is never the
resource lock.

## 15. Coordination truth table

| Scenario | Decision |
| --- | --- |
| Two independent admissible Human objectives arrive while execution is saturated | durably capture both requests, atomically admit two independent Works, and defer execution |
| Positive ingress evaluation has no WorkRef yet | reserve workId and ledger, then commit Work and admitted Evidence together |
| Crash after one side of cross-ledger admission writes | keep Work invisible and recover the exact outbox; never allocate another Work |
| Exact Human channel message replays | return original admission; no duplicate Work |
| Human replies to an exact Interaction or Work | bind input to that Work |
| Ingress correlation is ambiguous | never silently mutate an existing Work |
| IngressPolicy attempts semantic Work decision or permission grant | deny |
| Create revision 1 with valid Team, Spec, and Policy refs | allow |
| Create a second revision 1 for the same workId | deny |
| Revise the current head to revision +1 | allow |
| Revise a non-head Work revision | deny |
| Create a Task for the current Work revision | allow and make it eligible for scheduler dispatch |
| Record a planning Artifact without a formal Task | no dispatch authority |
| Create or dispatch a Task for an old Work revision | deny |
| Dispatch a cancelled or superseded Task | deny |
| Eligible Task has no execution slot | remain undispatched; no TaskRun or blocked Result |
| Eligible Task gains capacity | atomically reserve, dispatch, and open one TaskRun |
| Revision, cancellation, or supersession wins before dispatch | Task becomes ineligible |
| Dispatch wins before cancellation | terminate only through Result, not cancellation flag |
| Scheduler changes Task assignee, objective, or semantic priority | deny |
| Let an already-running old-revision Task finish | allow Result sealing; mark not currently eligible |
| Submit Result by the exact assignee with passing Completion Check | allow |
| Submit Result by another Agent | deny |
| Completion candidate fails | do not seal; continue the Task |
| External information is truly missing and blocked policy passes | seal blocked Result |
| Execution budget expires without a valid candidate | seal framework-produced failed Result |
| Replay identical Result for one Task | replay success |
| Submit a different second Result for one Task | conflict |
| Accept completed, current-scope, Completion-Check-valid Result | allow semantic disposition under policy |
| Accept blocked, failed, or Completion-Check-invalid Result | deny |
| Accept ancestor Result without carry-forward | deny |
| Carry forward an accepted ancestor Result to the current descendant | allow |
| Carry forward an unaccepted, reverse-direction, or cross-Work Result | deny |
| Supersede the current non-running Task leaf with a valid replacement | allow |
| Supersede a running Task | deny; terminate it and seal Result first |
| Supersede an accepted, already replaced Task or create a branch/cycle | deny |
| Cancel an undispatched Task | allow |
| Cancel a running Task by setting a flag | deny; terminate execution and produce Result |
| Complete Work with passing closure policy and no live effects | allow |
| Complete Work with a live Task or unresolved effect | deny |
| Revoke open-Work acceptance with an empty effective reverse-dependency frontier | allow as a new Decision |
| Revoke rejection or carry-forward under the exact section 9.7 conditions | allow as a new Decision |
| Revoke revision, supersession, cancellation, terminal Work, revocation, or consumed effect authority | deny |
| Concurrent descendant commits before revocation | revocation conflicts and must re-evaluate |
| Modify the original acceptance | deny |
| Revoke a revoke or erase an irreversible effect | deny |
| Same Leader handles isolated turns for different Works | allow within live Team capacity |
| Two Leader turns target one Work | one current lease epoch; stale epoch denied and CAS remains final defense |
| Two independent Tasks target available members | dispatch concurrently within all limits |
| Two Tasks target a member or Worker with one available slot | dispatch one; leave the other undispatched |
| Two Runs share one model session, mutable tool state, or physical Workspace | deny runtime implementation |
| Parallel Tasks produce overlapping patches | preserve both; use an integration Task |
| Concurrent Events target one Work Ledger | serialize append only and retain exact TaskRun subjects |
| Different Works append to different Ledgers | allow; do not invent global ordering |
| Slot lease expires while the old execution may write | fence and reconcile before reuse |
| Unauthorized Recorder emits Scheduler or capacity Evidence | deny and fail closed |
| Concurrent Work revisions | one commit, one stale-head conflict |
| Concurrent different Results for one Task | one commit, one conflict |
| Recovery finds a fork, cycle, digest mismatch, missing ref, or stale epoch | fail closed |

## 16. Package 2: trust and completion

Package 2 defines three orthogonal mechanisms:

- Artifact identifies what immutable content was produced;
- Evidence records what a trusted machine boundary observed;
- Completion checks whether those facts satisfy the minimum machine-provable
  contract for one Task outcome.

Artifact provenance does not prove semantic correctness. Evidence does not prove
an arbitrary claim merely because it was recorded. Completion is necessary for
Result sealing; effective Leader or Human-backed acceptance is authoritative
semantic disposition under exact policy and never proof of objective correctness.

## 17. Evidence contract

Evidence is an immutable machine event emitted by an authorized Recorder. It is
not model prose, raw logging, Artifact content, or mutable state.

```json
{
  "schema": "tiangong.evidence/v1",
  "ledgerId": "work:work-123",
  "sequence": 42,
  "eventKey": "sha256",
  "eventType": "tool.execution.completed",
  "eventDefinitionRef": {
    "implementationId": "evidence-event/tool.execution.completed",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "recorderRef": {
    "recorderId": "tiangong-worker-runtime",
    "implementationDigest": "sha256"
  },
  "actorRef": {
    "actorKind": "agent",
    "actorId": "worker-7"
  },
  "subjects": [
    {
      "role": "task",
      "ref": {
        "taskId": "task-123",
        "contentDigest": "sha256"
      }
    }
  ],
  "facts": {
    "toolName": "run_test_command",
    "invocationDigest": "sha256",
    "exitCode": 0,
    "outputDigest": "sha256"
  },
  "recordedAt": "2026-08-05T08:30:00.000Z",
  "previousHash": "sha256",
  "hash": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins the Evidence envelope and hashing semantics. |
| `ledgerId` | Identifies the hash chain that verifies the event. |
| `sequence` | Establishes authoritative order and exposes gaps and forks. |
| `eventKey` | Makes trusted capture idempotent and detects conflicting replay. |
| `eventType` | Supplies the stable human-readable event meaning selected by the exact definition. |
| `eventDefinitionRef` | Pins facts SchemaRef, subject roles, Recorder allowlist, event-key derivation, and handling rules. |
| `recorderRef` | Identifies the trusted machine boundary that recorded the bounded observation. |
| `actorRef` | Identifies the authenticated actor or system that caused the action. |
| `subjects` | Binds the fact to exact registered records or Artifacts, including Work, Task, Result, TaskRun, Human interaction, and Operation. |
| `facts` | Carries bounded, event-specific machine observations. |
| `recordedAt` | Supplies trusted ledger time for audit and explicit temporal freshness. |
| `previousHash` | Binds the event to the preceding chain position. |
| `hash` | Protects the event content and gives EvidenceRef its integrity identity. |

`eventType` is an authoritative semantic discriminator only together with its
exact immutable EventDefinitionRef. EventDefinition is a reviewed implementation
package that binds the stable eventType, envelope and facts SchemaRefs, required
subject roles and cardinalities, authorized Recorder implementations, actor
rules, event-key derivation, sensitive-data policy, and size bounds. A semantic,
schema, Recorder, or key-derivation change creates a new definition version and
digest. Historical verification never resolves “latest.” `facts` is not a
free-form payload.

`actorRef` answers who caused an action. `recorderRef` answers which trusted
boundary recorded the observation. The Agent may influence tool input but cannot
choose its authenticated actor, EventDefinition, Recorder, sequence, time,
predecessor, or hash. Recorder authorization limits who may state the fact; it
does not make a compromised Recorder truthful.

Evidence excludes a separate content digest or event ID, generic mutable status,
severity, metadata and extension bags, self-reported actor or time, raw prompts,
model responses, credentials, raw write payloads, unbounded logs, Artifact
payloads, bare Work or Task IDs, and natural-language success assertions.

### 17.1 EvidenceRef

```json
{
  "ledgerId": "work:work-123",
  "sequence": 42,
  "hash": "sha256"
}
```

The tuple identifies the ledger, exact order position, and immutable event. No
additional event ID is required.

### 17.2 Evidence event discipline

Evidence distinguishes proposal, Gate decision, execution start, execution
completion, replay, failure, rollback start, rollback completion, and uncertain
outcome. An earlier event never proves a later phase. In particular, an Agent or
tool-loop success message does not prove a backend effect.

Raw content that requires later inspection is stored as an Artifact payload.
Sensitive recovery payload is stored in a separate protected store and bound by
digest. Evidence contains only bounded normalized facts, digests, sizes, and
stable error codes.

## 18. Evidence Ledger and anchoring

Each Work has one logical Evidence Ledger. Agent and tool execution remains
parallel; only the short append transaction is serialized. A Work reserves its
ledger before its initial Human input and WorkSpec are recorded.

Administrative Catalog, schema, authority, revocation, security, Human ingress,
and cross-Work capacity facts use separate namespace-scoped administrative
ledgers with the same envelope, ledger-specific genesis, anchoring, Recorder,
and fail-closed rules. Ingress and capacity ledgers are members of this existing
administrative-ledger family, not new unguided stores. They do not merge
unrelated Work orders into a false global sequence. A Work ledger records exact
adoption and use of external Catalog, ingress, and capacity EvidenceRefs, while
live security revocation and capacity freshness are also checked at dispatch,
context, tool, Gate, and recovery boundaries.

The first event uses a ledger-specific genesis value:

```text
genesisHash = digest("sha256", jcs("tiangong-jcs/v1", {
  schema: "tiangong.evidence-ledger/v1",
  ledgerId
}))
```

Each event hash is:

```text
hash = digest("sha256", jcs("tiangong-jcs/v1", eventWithoutHash))
```

Append validates the current terminal, next sequence, previous hash, event key,
event and facts schemas, Recorder authority, subjects, and sensitive-data rules
before atomically appending and syncing the record.

A hash chain is only tamper-evident relative to a trusted terminal hash. Package
2 therefore requires signed Evidence Anchors held outside model and ordinary
Worker write authority. An Anchor is an immutable security record:

```json
{
  "schema": "tiangong.evidence-anchor/v1",
  "anchorId": "anchor-work-123-42",
  "ledgerId": "work:work-123",
  "range": {
    "firstSequence": 1,
    "lastSequence": 42
  },
  "previousAnchorRef": null,
  "terminalEvidenceRef": {
    "ledgerId": "work:work-123",
    "sequence": 42,
    "hash": "sha256"
  },
  "rangeDigest": "sha256",
  "anchorServiceRef": {
    "implementationId": "evidence-anchor-service/default",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "signingKeyRef": {
    "keyId": "evidence-anchor-key-1",
    "version": "1",
    "publicKeyDigest": "sha256"
  },
  "signatureAlgorithm": "Ed25519",
  "signature": "base64url-without-padding",
  "contentDigest": "sha256"
}
```

AnchorRef contains `anchorId` and Anchor `contentDigest`. `rangeDigest` covers a
canonical ordered list of sequence and event-hash pairs for the range. The
terminal EvidenceRef must equal its last pair and current Ledger terminal at
signing. A non-genesis Anchor begins at the prior Anchor's last sequence plus one
and binds `previousAnchorRef`; ranges cannot overlap, skip, fork, or cross
ledgers.

For `tiangong.evidence-anchor/v1`, signature input is the SHA-256 digest of JCS
bytes after omitting `signature` and `contentDigest`; the signature is Ed25519
over those digest bytes. `contentDigest` then covers the complete signed record
except its own field. Signature encoding is unpadded base64url. Another algorithm
requires a new Anchor schema and reviewed verifier; algorithm negotiation is not
accepted from the record.

The trust-root store contains allowlisted public keys, validity epochs, rotation
links, and compromise/revocation facts and is inaccessible to models and
ordinary Workers. Private keys remain in the Anchor service. Rotation requires
an out-of-band configured trust root or a transition authorized by the current
trusted key plus administrative Evidence. Compromise handling identifies the
last externally trusted Anchor frontier. Anchors after that frontier are invalid;
when the safe cutoff is unknowable, high-risk consumption is indeterminate and
fails closed. Rotation never rewrites earlier Anchors or Evidence.

The Anchor service records bounded `evidence.anchor.recorded`,
`anchor-key.rotated`, and `anchor-key.compromised` administrative events under
exact EventDefinitions and authorized security Recorders. Recording Evidence
binds AnchorRef, ledger range, service and key refs, and trusted time without
entering the Anchor signature cycle. Signature verification does not depend on
that later event, while audit and key-state projection require it.

An Anchor protects chain integrity and continuity after trusted signing. It does
not prove Recorder truth, external-effect outcome, pre-genesis completeness, or
absence of an action that no authorized Recorder captured. Evidence is not
automatically deleted.

Anchor checkpoints and physical segment rotation are separate:

- a critical boundary synchronously signs a small terminal checkpoint over the
  active tail;
- segment rotation, export, and archival may run asynchronously;
- Result sealing need not wait for a large file rotation;
- Result acceptance requires the relevant completion and recording events to be
  covered by a trusted Anchor.

The following uses require anchored Evidence: formal Completion pass, Leader or
Human acceptance, high-risk Artifact consumption, Work termination, Operation
approval or reconciliation, and formal Evidence export. Agent Concerns may read
an unanchored active tail only as provisional observation.

A trusted active clock supplies `recordedAt`, but sequence remains ordering
authority. Temporal checkers are used only where facts genuinely expire. If
clock health is unknown, a temporal checker returns `indeterminate`.

### 18.1 Evidence invariants

1. Only trusted Recorders append Evidence.
2. Event authority is checked per event type and Recorder.
3. Events are immutable and append-only.
4. Reading and appending validate the chain; tampering is never silently
   truncated or repaired.
5. Duplicate event keys with identical facts replay; different facts conflict.
6. Sequence gaps, forks, invalid anchors, unknown event types, and schema
   mismatches fail closed.
7. Sequence, not wall-clock time, determines order.
8. Tool proposal, start, completion, replay, rollback, and uncertainty remain
   distinct facts.
9. Evidence never stores credentials, unrestricted logs, or raw protected
   payloads.
10. Rotation and retention preserve chain continuity and verification material.
11. Anchor verification resolves exact schema, service, key, algorithm, range,
    prior Anchor, signature, and current compromise facts.
12. Missing, forked, untrusted, or compromise-ambiguous Anchor state fails closed
    for every use that requires anchoring.

## 19. Artifact contract

Artifact is an immutable Manifest that binds semantic type, payload identity,
machine provenance, and handling policy.

```json
{
  "schema": "tiangong.artifact/v1",
  "artifactId": "artifact-123",
  "artifactSchemaRef": {
    "schemaId": "tiangong.artifact-schema/test-report",
    "version": "1",
    "contentDigest": "sha256"
  },
  "payload": {
    "mediaType": "application/json",
    "byteLength": 1842,
    "digest": "sha256"
  },
  "provenanceEvidenceRefs": [
    {
      "ledgerId": "work:work-123",
      "sequence": 38,
      "hash": "sha256"
    }
  ],
  "handlingPolicyRef": {
    "policyId": "artifact-handling/internal",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins Manifest interpretation and digest rules. |
| `artifactId` | Provides stable delivery identity and external mapping. |
| `artifactSchemaRef` | Selects semantic parsing and deterministic validation. |
| `payload` | Binds media type, byte length, and exact delivered bytes. |
| `provenanceEvidenceRefs` | Proves trusted materialization or capture of the payload. |
| `handlingPolicyRef` | Pins classification, access, export, retention, and destruction rules. |
| `contentDigest` | Gives Result an immutable Manifest identity. |

Manifest digest and payload digest are distinct. The first protects semantic
packaging and provenance; the second protects delivered bytes. Different
Artifacts may legitimately reference the same payload.

An ArtifactRef contains `artifactId` and Manifest `contentDigest`. Physical
storage location is maintained by Artifact Store as mutable machine state keyed
by payload digest; it is not part of Artifact identity. Composite Artifacts use
a canonical payload manifest that transitively binds their members.

Artifact excludes actor and time, generic Work or Task fields, storage paths or
URLs, inline payload, mutable status, revision, duplicate summary or claim,
Evidence bodies, generic lineage metadata, direct Operation and Approval fields,
and extension bags.

### 19.1 Provenance sequence

```text
trusted input/tool/Runner boundary
  -> payload written to content store
  -> digest and byte length verified
  -> artifact.materialized Evidence
  -> Artifact Manifest referencing earlier materialization Evidence
  -> artifact.recorded Evidence referencing the Manifest digest
```

`artifact.recorded` is not included in the Artifact's own provenance because
that would create a digest cycle. Formal validation follows the reverse Evidence
binding.

Artifact validity requires a valid Manifest and payload, a resolvable Artifact
schema, anchored provenance from an authorized Recorder, a matching
materialization descriptor, reverse recording Evidence, and a handling policy
that permits the requested use. This proves origin and byte identity, not
semantic quality.

### 19.2 Artifact invariants

1. Manifest and payload are immutable.
2. One artifact ID maps to one Manifest digest.
3. Identical payloads may be deduplicated across different Artifacts.
4. Payload is fully written, synced, and verified before Manifest sealing.
5. Provenance references only earlier Evidence.
6. Payload reads re-verify digest and byte length.
7. Missing or corrupt payload makes the Artifact unavailable; the Manifest alone
   cannot authorize a re-verification claim.
8. Missing reverse recording Evidence excludes the Manifest from the trusted
   projection.
9. Handling policy is enforced at read, model-context, export, retention, and
   destruction boundaries.
10. Accepted Result references establish retention pins. Payload deletion makes
    future verification impossible and therefore requires an explicit guarded
    destruction Operation; it is never silent.
11. Rejection or Work cancellation does not automatically delete an Artifact.
12. AI-produced content may be an Artifact, but remains a claim-bearing output.

ArtifactSchema and HandlingPolicy are referenced, immutable, content-addressed
packages. ArtifactSchema supplies deterministic payload validation and never
runs arbitrary model or tool code. HandlingPolicy governs classification and
lifecycle without changing Artifact identity or provenance.

### 19.3 Retention and destruction

RetentionPolicy is a strict Policy package that defines minimum and maximum
retention, accepted-Result and audit pins, legal and security holds, protected-
payload treatment, eligible destruction authority, and required verification.
It never mutates Artifact or Evidence.

Payload destruction is a Task-origin maintenance Operation under Package 3. Its
spec binds exact Artifact and payload digests, storage realm, current retention
PolicyRef, complete pin/hold frontier, expected physical state, and desired
absence. Guard denies destruction while any accepted Result, Evidence export,
Operation or Approval audit horizon, uncertain recovery, legal hold, active
retrieval reader, or stricter HandlingPolicy still requires the payload. Human or
standing policy authority produces an exact Approval; neither retention expiry
nor cache deletion is implicit authorization.

Success requires an OperationReceipt and machine-proved absent or cryptographic-
erasure postcondition from the exact storage Adapter. Manifest, destruction
Operation, Approval, Receipt, and Evidence remain retained under their audit
policy and make later payload reads fail as unavailable rather than pretending
the Artifact never existed. Cache eviction of a rebuildable non-authoritative
index is not authoritative Artifact destruction.

## 20. CompletionPolicy contract

CompletionPolicy is a content-addressed machine certification contract. It is
not a Skill, Prompt, workflow, or semantic reviewer.

```json
{
  "schema": "tiangong.completion-policy/v1",
  "policyId": "task-completion/code-change",
  "version": "1",
  "kernelRef": {
    "kernelId": "tiangong-completion-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "outcomeChecks": {
    "completed": [
      {
        "checkerRef": {
          "checkerId": "required-artifact-schema",
          "version": "1",
          "implementationDigest": "sha256"
        },
        "parameters": {
          "requiredSchemaRefs": []
        }
      }
    ],
    "blocked": [],
    "failed": []
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins Policy interpretation. |
| `policyId` | Supplies stable registry identity. |
| `version` | Supports explicit review and upgrade. |
| `kernelRef` | Prevents Kernel changes from silently changing an existing Task. |
| `outcomeChecks` | Gives completed, blocked, and failed distinct minimum contracts. |
| `contentDigest` | Lets Task bind the exact resolved policy. |

Every outcome branch is explicit, even when it adds no checks beyond Kernel.
This prevents blocked or failed outcomes from becoming an escape hatch.

Each Checker reference binds code identity and version. Its parameters conform
to the Checker's strict parameter schema; they are not arbitrary payload. The
resolved Policy is flat and does not contain a general boolean expression DSL.

CompletionPolicy excludes workflow steps, Prompt or Skill text, model-based
checkers, arbitrary scripts, warnings, mutable enable flags, actor and time,
free-form metadata, Human approval, semantic quality scores, and recovery
workflows. Advisory checks belong to Concerns.

## 21. Checker contract

A Checker is a code-owned, deterministic, side-effect-free function over an
immutable snapshot of Task, Result candidate, Work projection, Evidence,
Artifacts, TaskRun, and validated parameters. It does not call a model, execute
a tool, mutate state, or read undeclared mutable global state.

It returns:

```text
verdict: pass | fail | indeterminate
reasonCode
subjectRefs
EvidenceRefs
```

`indeterminate` fails closed. Diagnostic text is bounded, sanitized, and derived
from stable reason codes. Concerns and Skills explain recovery; Checkers do not
become a methodology engine.

Combination is fixed:

```text
all Kernel Checkers pass
AND
all Checkers for the selected outcome pass
```

Checkers do not consume one another's output. If two checks require ordered
state, they form one reviewed Checker. This prevents evaluation order from
changing the verdict.

### 21.1 Mandatory Kernel Checkers

The versioned Completion Kernel always performs:

- candidate schema and digest integrity;
- Task, TaskRun, and authenticated submitter binding;
- exact Artifact and Evidence reference integrity;
- Evidence chain, Anchor, event authority, and facts-schema validation;
- Evidence subject and digest binding to the current Task and outputs;
- Artifact payload, schema, provenance, recording, and handling validation;
- Finding Evidence-subset validation;
- completed, blocked, and failed outcome consistency;
- terminal-effect safety once Package 3 supplies Operation facts.

A blocked Checker can verify machine facts such as missing dependencies, Gate
denials, preserved outputs, and absence of live effects. It cannot prove the
semantic assertion that an Agent has tried every reasonable approach. The
Leader decides whether the blocker is justified.

Policy-selectable Checkers include required Artifact schemas, required Evidence
events, payload schema, command exit outcome, subject digest binding,
environment binding, temporal freshness, independent producer, test outcome,
test coverage, deployment receipt, and Approval receipt. Packages 3 and 5
supply the corresponding domain facts; implementation registers the reviewed,
code-owned Checker modules.

## 22. Completion execution

Framework canonicalizes the Result candidate and computes the same digest the
sealed Result will receive. It resolves the exact Task, CompletionPolicy,
Kernel, Checker implementations, Artifact set, Evidence set, and immutable
frontier.

A failed or indeterminate attempt records bounded `completion.checked` Evidence
with candidate digest, policy and implementation digests, Checker reason codes,
and Evidence frontier. It does not create a Result. The Agent continues, submits
a valid blocked or failed candidate, or reaches its execution budget and receives
a framework-produced failed Result.

A passing attempt atomically seals:

```text
Result
+ completion.checked(pass)
+ result.recorded
+ Evidence outbox
```

The active ledger tail is then synchronously Anchor-checkpointed. Segment
rotation does not block this path.

A pass event binds candidate/Result digest, outcome, CompletionPolicy, Kernel,
Checker results, Evidence frontier, verdict, and optional `validUntil`.
Recording and completion events are not included in Result.evidenceRefs because
that would form a digest cycle.

Historical anchored pass Evidence remains a historical fact even if the
executable Checker package later becomes unavailable. Re-evaluation,
carry-forward, or pending acceptance that requires current computation fails
closed when the exact implementation cannot be loaded. Immutable Checker
packages and registry manifests should be retained for the applicable audit and
re-evaluation horizon, but package loss does not rewrite an already recorded
historical decision.

Repeated failed checks remain Evidence. They may be rotated, archived, and
summarized into an Artifact for observability, but are not automatically deleted
or semantically collapsed.

## 23. Freshness

Freshness is a predicate relative to a subject, policy, environment, and time;
it is never a mutable flag on Evidence or Artifact.

- Structural freshness requires exact subject and payload digests.
- Scope freshness compares Task WorkRef with the current Work and uses Package 1
  carry-forward rules.
- Policy freshness binds CompletionPolicy, Kernel, Checker, Team, and environment
  policy digests where required.
- Temporal freshness is used only for facts that genuinely expire and uses a
  trusted backend completion time or ledger time.
- Causal freshness requires Evidence after and bound to the exact materialized
  Artifact or environment state.

Clock health uncertainty makes temporal checks indeterminate. Sequence remains
the ordering authority.

Leader acceptance revalidates the anchored pass, policy suitability,
`validUntil`, Artifact availability, scope relationship, and later Operation
uncertainty. A sealed Result never receives additional Evidence. If its fixed
Evidence is no longer suitable, the Leader creates a new verification Task and
Result.

## 24. Capture boundary

Evidence is emitted automatically by trusted wrappers and adapters, including
coordination ports, tool wrappers, Runner brokers, Artifact Store, Approval
service, deployment adapters, and browser or external-service adapters. Models
do not receive a generic append-Evidence tool.

Small safe facts enter Evidence. Full outputs needed for later review enter
Artifact Store. Sensitive restart material remains in a protected payload store
and is referenced only by digest. Unbounded low-value logs are summarized and
bounded rather than copied into Evidence.

## 25. Package 2 recovery and concurrency

Recovery verifies Ledger genesis, Anchors, segment ranges, chain hashes, active
tail, event-key uniqueness, event and facts schemas, Recorder authority, and
EvidenceRef indices. Gaps, forks, conflicting event keys, invalid Anchors, and
unknown types fail closed.

Artifact recovery validates Manifest digest, schema and handling references,
provenance, reverse recording Evidence, and payload-location indices. Payload is
rehashed when accessed. Availability is a Projection, not a Manifest field.

Completion recovery reconstructs all attempts and passing attestations from
Evidence. Missing policy or implementation makes required re-evaluation
indeterminate. It does not erase an anchored historical event.

Multi-record writes use write-ahead intent, immutable records, Evidence outbox,
and commit marker. Records without a complete commit are invisible. Recovery
may finish an exact durable outbox but never asks a model whether the action
probably completed.

Evidence append uses a per-Work lock or compare-and-swap on terminal hash.
Payload publication uses temporary write, sync, digest verification, and atomic
content-addressed publish. Same payload bytes deduplicate; digest collision or
mismatch is a security failure. Artifact IDs and Task Result submission reject
last-write-wins conflicts.

Completion runs on a fixed snapshot of Task, candidate digest, policies,
Artifacts, Evidence, frontier, and TaskRun. New concurrent Evidence does not
enter an existing candidate. Final sealing rechecks that no Result or terminal
conflict was committed concurrently.

Concurrent TaskRuns for one Work serialize only the short Ledger append and
retain exact TaskRun subjects and fencing epochs; their model, tools, and output
work remain parallel. Different Work ledgers have no invented global order.
Administrative capacity observations are temporally fresh machine facts. Missing,
expired, conflicting, chain-invalid, or unauthorized capacity Evidence cannot
widen execution and instead narrows the affected dimension to unavailable until
a valid observation exists. Anchoring follows the same usage rules as every
other administrative ledger.

## 26. Package 2 truth table

| Scenario | Decision |
| --- | --- |
| Authorized Recorder emits valid event facts | allow |
| Agent chooses Recorder, sequence, or time | deny |
| Recorder emits an unauthorized or unknown event type | deny |
| Same event key and facts replay | replay existing EvidenceRef |
| Same event key with different facts | conflict and fail closed |
| Chain gap, fork, hash mismatch, or invalid Anchor | fail closed |
| Valid but unanchored active event | provisional only |
| Tool proposal without completion Evidence | does not prove execution |
| Valid payload, schema, provenance, and handling policy | seal Artifact |
| Payload digest mismatch or missing provenance | deny |
| Manifest without reverse recording Evidence | exclude from trusted projection |
| Same Artifact ID and digest replay | replay success |
| Same Artifact ID with different digest | conflict |
| Different Artifacts share identical payload | allow |
| Payload moves and still verifies by digest | allow |
| Payload is missing or corrupt | unavailable; cannot reverify |
| AI report has valid provenance | proves production, not semantic correctness |
| Kernel and outcome Checkers all pass | seal Result |
| Any Checker fails or is indeterminate | do not seal |
| Evidence belongs to another Task or revision | fail |
| Blocked candidate meets machine minimum | seal blocked Result; Leader judges blocker semantics |
| Failed candidate lacks failure Evidence | fail |
| Policy or implementation digest mismatches Task | fail closed |
| Passing Evidence expires before acceptance | deny acceptance; create new verification Task |
| Result is sealed and new Evidence appears | do not mutate Result |
| Completion failure attempts accumulate | retain, rotate, archive, and optionally summarize; do not auto-delete |
| Historical anchored pass exists but implementation package is unavailable | preserve historical fact; current re-evaluation is indeterminate |
| Result record exists without committed completion and recording Evidence | exclude from projection |
| Recovery finds payload without Manifest | orphan payload, not an Artifact |

## 27. Package 3: external effects and authorization

Package 3 controls lasting effects outside a Task's isolated workspace:

```text
Task or HumanInteraction -> Operation -> exact Approval -> Gate allow
                         -> execution Evidence -> receipt Artifact
```

Operation covers external, shared, public, costly, security-sensitive, or
irreversible effects such as push, publish, deploy, cloud mutation, database
write, external notification, ticket mutation, secret rotation, production
command, resource deletion, and authoritative Artifact payload destruction.
Reading, searching, isolated workspace edits, builds, tests, internal Artifact
persistence, rebuildable cache eviction, Evidence append, and read-only
reconciliation are not Operations.

The effect boundary is determined from actual semantics, not tool name. Wrapping
`publish` or `deploy` in a shell command does not bypass Operation controls.

## 28. Operation contract

Operation is an immutable, approvable, idempotently executable external-effect
intent. It is not an execution status or a tool-call log.

```json
{
  "schema": "tiangong.operation/v1",
  "operationId": "operation-123",
  "origin": {
    "kind": "task",
    "ref": {
      "taskId": "task-prepare-17",
      "contentDigest": "sha256"
    }
  },
  "adapterRef": {
    "adapterId": "deployment-adapter",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "scope": {
    "workspaceBindingRef": {
      "artifactId": "workspace-binding-1",
      "contentDigest": "sha256"
    },
    "environmentRef": {
      "environmentId": "pre-production",
      "contentDigest": "sha256"
    }
  },
  "specSchemaRef": {
    "schemaId": "tiangong.operation-schema/deploy",
    "version": "1",
    "contentDigest": "sha256"
  },
  "spec": {
    "schema": "tiangong.operation/deploy/v1",
    "targetRef": {
      "serviceId": "orders-api",
      "contentDigest": "sha256"
    },
    "artifactRef": {
      "artifactId": "image-123",
      "contentDigest": "sha256"
    },
    "expectedTargetStateDigest": "sha256",
    "desiredEffectDigest": "sha256",
    "protectedPayloadDigest": null
  },
  "effectPolicyRef": {
    "policyId": "effect-policy/pre-production-deploy",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins Operation envelope semantics. |
| `operationId` | Supplies stable journal, idempotency, and recovery identity. |
| `origin` | Binds the effect intent to its exact Task or HumanInteraction origin. |
| `adapterRef` | Pins the trusted implementation that interprets and executes the spec. |
| `scope` | Binds workspace, tenant, environment, and other authority boundaries. |
| `specSchemaRef` | Pins the exact structural schema interpreted by the Adapter. |
| `spec` | Binds exact target, inputs, preconditions, and desired effect. |
| `effectPolicyRef` | Pins authorization, risk, idempotency, verification, retry, compensation, and recovery rules. |
| `contentDigest` | Lets Approval and Journal bind the exact Operation. |

`spec.schema` must match the exact immutable `specSchemaRef`; that schema and the
pinned Adapter allowlist define the code-owned Operation type. Neither may
resolve a mutable latest version. The spec never contains an arbitrary shell command.
Credentials and raw protected payload do not enter Operation or Evidence. When
restart requires such material, a model-inaccessible protected store holds the
payload and Operation records only its digest.

Operation excludes mutable status, Approval reference, actor and time,
idempotency key, attempts, execution result, rollback status, arbitrary raw
commands, credentials, raw protected payload, free risk labels, Human-facing
approval prose, metadata, and extensions.

### 28.1 Operation invariants

1. Operation is immutable; any target, input, precondition, or desired-effect
   change creates a new Operation.
2. One operation ID maps to one digest.
3. Only the pinned authorized Adapter may execute the pinned Operation schema.
4. Origin kind is code-owned: ordinary effects bind a Task; formal Human
   delivery binds a HumanInteraction. No other implicit system origin exists.
5. Task-origin scope must be allowed by Agent capability, Task execution policy,
   and ResolvedWorkPolicy together. Interaction-origin delivery must be allowed
   by Leader coordination capability plus resolved Human, reporting, audience,
   channel, and effect policies.
6. Effect policy is resolved by code and cannot be weakened by a model.
7. `operation.recorded` proves a sealed intent, not execution.
8. Every actual execution has an exact Approval for the same Operation digest.
9. One Operation has one stable external idempotency identity.
10. Uncertain outcome blocks automatic retry.
11. Result rejection or Work cancellation never erases a real effect.
12. A new Operation attempt requires the origin Work revision and the exact
    Approval Work revision to be current. It also requires an open Work except
    for a code-owned, policy-authorized Interaction-origin terminal or recovery
    `inform` delivery. Prior attempts remain historical facts, but revision
    invalidates future retry of the old intent.

## 29. OperationProposal Artifact

A Prepare Task seals the Operation and produces a typed OperationProposal
Artifact. Its payload has no inner identity or content digest:

```json
{
  "schema": "tiangong.operation-proposal/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "safeSummary": {
    "target": "orders-api pre-production",
    "effect": "promote the exact image Artifact"
  },
  "inputRefs": [],
  "configurationRefs": [],
  "environmentRef": {
    "environmentId": "pre-production",
    "contentDigest": "sha256"
  },
  "risk": {
    "riskClass": "high",
    "maximumCostMinorUnits": 1000,
    "currency": "USD"
  },
  "failureImpact": {
    "summary": "The target may remain unavailable until recovery completes.",
    "affectedScopeRefs": []
  },
  "preconditionRefs": [],
  "verificationPlanRef": {
    "artifactId": "operation-verification-plan-123",
    "contentDigest": "sha256"
  },
  "recoveryPlanRef": {
    "artifactId": "operation-recovery-plan-123",
    "contentDigest": "sha256"
  },
  "compensationPlanRef": null
}
```

The exact Artifact schema binds the OperationRef, bounded safe summary, exact
inputs, configuration and environment, policy-derived risk and maximum cost,
preconditions, verification plan, failure impact, and recovery and optional
compensation plans. Input, configuration, scope, verification, recovery, and
compensation refs resolve exactly and must be permitted by Operation and
EffectPolicy. Failure-impact and summary prose are bounded Claims for review and
cannot alter Operation semantics. Raw protected payload and credentials are
excluded.

Human authorization presentation is deterministically generated from Operation,
EffectPolicy, and Proposal. Approval binds Operation digest, Proposal Artifact
digest, and presentation digest so Leader prose cannot substitute another
effect after review.

## 30. Approval contract

Approval is an immutable authorization grant. It does not prove execution or
semantic Result acceptance.

```json
{
  "schema": "tiangong.approval/v1",
  "approvalId": "approval-123",
  "grant": {
    "schema": "tiangong.approval-grant/exact-human/v1",
    "operationRef": {
      "operationId": "operation-123",
      "contentDigest": "sha256"
    },
    "workRef": {
      "workId": "work-123",
      "revision": 2,
      "contentDigest": "sha256"
    },
    "validUntil": "2026-08-05T10:00:00.000Z"
  },
  "basisRefs": [
    {
      "kind": "artifact",
      "artifactId": "operation-proposal-123",
      "contentDigest": "sha256"
    },
    {
      "kind": "evidence",
      "ledgerId": "work:work-123",
      "sequence": 80,
      "hash": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins the Approval envelope. |
| `approvalId` | Supplies stable consumption and revocation identity. |
| `grant` | Defines exact or bounded authority, Work scope, limits, and validity. |
| `basisRefs` | Binds policy, Human presentation, and authenticated answer evidence. |
| `contentDigest` | Lets Gate and Journal bind the exact grant. |

The authenticated grantor and trusted time are recorded by
`approval.recorded` Evidence rather than copied into Approval.

Approval excludes self-reported grantor and time, mutable status, consumed or
use-count fields, a revoked flag, Operation outcome, Leader prose, raw Human
messages, arbitrary scope expressions, reusable bearer tokens, metadata, and
extensions.

### 30.1 Grant kinds

- `exact-human` binds one Operation and current Work after authenticated Human
  authorization.
- `bounded-human` binds strict Operation schemas, targets, environments, count,
  cost, and validity limits. It cannot execute directly.
- `exact-derived` atomically consumes bounded authority for one Operation and
  cannot widen the parent.
- `exact-policy` records that a specific Operation was allowed by a pinned
  standing EffectPolicy.

Every actual execution uses an exact grant. Bounded Human and standing policy
authority are never passed directly to an Adapter.

### 30.2 Approval invariants

1. Only a trusted Authorization boundary creates Approval.
2. Human grants require an authenticated Human and the exact presentation that
   was shown.
3. Exact Approval binds one Operation identity and current Work revision.
4. Bounded authority cannot execute and every derived grant consumes quota
   atomically.
5. Policy-derived exact Approval pins the policy version used at the time.
6. Expired or effectively revoked Approval cannot begin or retry execution.
7. Expiry after execution begin does not prevent completion recording or
   reconciliation.
8. Approval first-use allocation and Operation Journal begin are atomic; a
   same-Operation retry revalidates the exact grant without authorizing another
   Operation.
9. Human denial creates no Approval.
10. Revocation is a new `revoke-approval` CoordinationDecision and never erases
    an execution that already began.
11. Approval, Proposal, and authority Evidence remain retained with the
    Operation audit horizon.

Package 3 extends CoordinationDecision with `revoke-approval`, whose subjects
are `approval` and `target-work`. Revocation stops unconsumed or future authority;
it does not manufacture a claim that an in-flight or completed effect never
occurred.

## 31. Task and authorization flows

Exact Human authorization uses separate Tasks:

```text
Prepare Task
  -> Operation + OperationProposal Artifact + completed Result
Leader
  -> authorize interaction
  -> authenticated exact-human Approval + anchored Evidence
Execute Task
  -> inputs include OperationRef and ApprovalRef
  -> Gate -> effect -> receipt Artifact -> Result
```

A Task never suspends for Human approval.

Standing policy and bounded preauthorization do not require a per-Operation
Human round trip:

```text
concrete Operation
  -> policy or bounded-scope check
  -> exact-policy or exact-derived Approval
  -> execute
```

If an unexpected Human grant is required, the current Task seals Operation and
Proposal, returns a blocked Result without executing, and ends. Leader requests
authorization and creates a new Execute Task.

## 32. Gate layers

Gate is code, not an Agent. It checks in order:

1. **Schema and integrity**—Operation, Approval, Registry, digest, reference,
   and sensitive-data validity.
2. **Capability**—for Task origin, dispatch, assignee, Agent capability, and
   Task policy; for HumanInteraction origin, Leader and trusted delivery-runtime
   capability; in both cases resolved scope, workspace, channel, and environment.
3. **Effect policy**—target, risk, cost, data classification, authorization
   mode, verification, and compensation requirements.
4. **Approval**—exact grant, anchored authority Evidence, Operation and Work
   match, expiry, revocation, parent scope, quota, and approver authority.
5. **Idempotency and recovery**—completed replay, executing conflict,
   uncertain reconciliation requirement, and protected-payload availability.
6. **Preconditions**—current target state, inputs, configuration, environment,
   lease, and execution-plan digest immediately before execution.

Gate returns `allow`, `deny`, `approval-required`, or `reconcile-required` and
records strict `gate.decided` Evidence. Approval-required never suspends a Task
or Matrix turn. Preconditions that changed normally require a new Operation,
not mutation of the old one.

## 33. Effect execution protocol

Effect lifecycle is a small code-owned safety protocol, not a Team workflow.
Operational views are derived from Journal and Evidence:

```text
recorded -> authorized -> execution-started
  -> succeeded
  -> failed-no-effect
  -> partial-effect
  -> uncertain
  -> compensated or recovery-required
```

Execution order is:

```text
Operation and Anchor
-> exact Approval and Anchor
-> Gate allow
-> atomic Approval first-use allocation or same-Operation retry validation + Journal begin
-> durable and anchored execution.started
-> backend call
-> receipt and postcondition verification
-> terminal Evidence
-> OperationReceipt Artifact
```

Success requires a trusted backend receipt and verified postcondition. HTTP
success or model text alone is insufficient. Failure is `failed-no-effect` only
when the Adapter proves no external effect occurred. A timeout, process loss
after start, unverifiable receipt, Journal/backend conflict, or unsupported
idempotency defaults to uncertain.

## 34. Operation-centric idempotency and Journal

The stable key is independent of model session and turn:

```text
idempotencyKey = digest("sha256", jcs("tiangong-jcs/v1", {
  schema: "tiangong.operation-idempotency/v1",
  operationId,
  operationDigest
}))
```

Completed replay returns the saved safe Receipt without calling the backend.
Started without terminal is uncertain. Retry is allowed only after privileged
reconciliation proves `not-applied` and current policy and Approval still allow
it. Any spec change creates a new Operation and Approval.

A code-owned Operation Journal stores the immutable Operation binding,
idempotency key, protected-payload digest, and append-only attempts. Each
attempt binds its exact ApprovalRef, authorized TaskRun or trusted system
executor, invocation, durable begin and terminal facts, safe replay Receipt, and
reconciliation facts. The Journal is
machine state, not Evidence or a model-writable Artifact. It is serialized
across processes, validated on load, hash protected, and coordinated with
Evidence by an outbox. Uncertain entries retain recovery material and are never
automatically cleaned.

## 35. Compensation and reconciliation

An external rollback is itself an external effect and therefore a new Operation
with its own EffectPolicy, exact Approval, Evidence, and Receipt. The original
Operation remains historical fact. Only local temporary cleanup may remain an
internal Adapter lifecycle action.

Forward approval may separately authorize an exact compensation Operation, or
standing emergency policy may derive one. Otherwise Human authorization is
requested after failure.

Reconciliation is a model-inaccessible privileged service or CLI. It queries
backend state using OperationRef, idempotency key, target, and receipt, and
records `applied`, `not-applied`, `partially-applied`, or `still-uncertain`.
Read-only reconciliation is not an Operation. Any corrective mutation is a new
Operation.

- applied: verify postcondition and record success;
- not applied: allow same-key retry only when policy and Approval remain valid;
- partially applied: create a compensation or recovery Operation;
- still uncertain: remain recovery-required and deny retry.

## 36. Result and Completion binding

Execute Task Result refers to an OperationReceipt Artifact and execution,
reconciliation, or compensation Evidence; Result does not add Operation fields.
The Receipt is a typed Artifact payload with no inner identity or content digest:

```json
{
  "schema": "tiangong.operation-receipt/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "approvalRef": {
    "approvalId": "approval-123",
    "contentDigest": "sha256"
  },
  "adapterRef": {
    "adapterId": "deployment-adapter",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "idempotencyKeyDigest": "sha256",
  "journalTerminal": {
    "kind": "execution",
    "attemptId": "attempt-1",
    "reconciliationId": null,
    "eventType": "execution-succeeded",
    "journalSequence": 2,
    "journalHash": "sha256"
  },
  "attemptEvidenceRefs": [
    {
      "ledgerId": "work:work-123",
      "sequence": 90,
      "hash": "sha256"
    },
    {
      "ledgerId": "work:work-123",
      "sequence": 91,
      "hash": "sha256"
    }
  ],
  "outcome": "succeeded",
  "backendReceiptRef": {
    "artifactId": "backend-receipt-123",
    "contentDigest": "sha256"
  },
  "postcondition": {
    "verdict": "verified",
    "observedStateDigest": "sha256",
    "checkerRef": {
      "implementationId": "postcondition/deployment-state",
      "version": "1",
      "implementationDigest": "sha256"
    },
    "evidenceRefs": [
      {
        "ledgerId": "work:work-123",
        "sequence": 92,
        "hash": "sha256"
      }
    ]
  }
}
```

`journalTerminal` is a strict execution-or-reconciliation union and binds the
exact attempt, optional reconciliation identity, terminal event type, sequence,
and hash before Receipt sealing. The later `receipt-recorded` Journal event binds
the sealed Receipt Artifact and therefore cannot be referenced from its payload.
Attempt and postcondition EvidenceRefs must resolve to the same Operation,
attempt or reconciliation, Adapter, target, environment, and authenticated
execution boundary.

Outcome is a strict discriminated union over `succeeded`, `failed-no-effect`,
`partial-effect`, and `uncertain`; each branch defines required and prohibited
backend receipt, postcondition, and reconciliation fields. A later reconciliation
publishes a new Receipt Artifact bound to its new Journal terminal and never
mutates the earlier Receipt. Compensation is a separate Operation with its own
Approval and Receipt plus `operation.compensation.linked` Evidence; it is a
derived original-Operation disposition, not an OperationReceipt outcome or a
future reference inserted into an old Receipt. The Receipt binds exact target
and environment through Operation and observed facts. Backend raw response is a
separate bounded Artifact when retention is permitted. Only verified success
satisfies a completed effect requirement.

Package 2 `terminal-effect-safety` checks all Task-origin Operations associated
with the candidate Task. Work closure separately checks every Operation whose
Task or HumanInteraction origin belongs to that Work:

- completed requires exact Approval, verified success, Receipt Artifact, and no
  executing, partial, or uncertain effect;
- blocked permits a recorded but unexecuted Operation and Proposal with no
  execution start;
- failed permits known no-effect failure, explicit partial recovery,
  compensation, or disclosed uncertainty.

An uncertain started Operation cannot be softened into blocked. A failed Result
may truthfully preserve uncertainty, but Work cannot complete successfully until
recovery reaches an allowed terminal condition. Work may instead fail with an
explicit recovery-required condition. That terminal Decision does not close its
Evidence Ledger or Journal: later reconciliation facts append without changing
the failed Decision, while any corrective mutation is coordinated by a separate
recovery or incident Work.

## 37. Package 3 commands and Guards

| Command | Deterministic Guard and output |
| --- | --- |
| `record_operation` | Validate exact Task or HumanInteraction origin, corresponding capability and resolved policies, strict spec, Adapter, scope, EffectPolicy provenance, input refs, preconditions, and secret exclusion; write Operation and Evidence. |
| `request_authorization` | Require anchored Operation and valid Proposal; generate presentation from machine fields; record request Evidence and send Human authorize interaction without suspending a Task. |
| `record_exact_human_approval` | Authenticate Human, match request, Operation, Proposal, presentation, current Work, authority role, and validity; write Approval, Evidence, and Anchor. |
| `record_bounded_human_approval` | Require strict bounded scope, finite limits, authorized Human, and explicit generated presentation. |
| `derive_exact_approval` | Prove concrete Operation is within standing or parent authority; atomically consume quota; never widen scope; write exact Approval and Evidence. |
| `execute_operation` | Run all Gate layers; atomically allocate or revalidate exact Approval and begin Journal attempt; persist start before backend call. |
| `replay_operation` | Require verified terminal success and matching digest; return saved Receipt without backend call. |
| `reconcile_operation` | Allow only privileged reconciler for uncertain or partial Operation; perform read-only verified query and record Evidence. |
| `create_compensation_operation` | Require a real effect needing compensation, compatible schema and policy, valid current preconditions, bounded impact, and exact Approval. |
| `revoke_approval` | Append CoordinationDecision; serialize against execution begin; prevent future authority without erasing real effects. |

## 38. Package 3 Evidence

Required event meanings include:

```text
operation.recorded
approval.requested
approval.recorded
approval.derived
approval.consumed
approval.revoked
gate.decided
operation.execution.started
operation.execution.succeeded
operation.execution.failed-no-effect
operation.execution.partial
operation.execution.uncertain
operation.execution.replayed
operation.reconciliation.started
operation.reconciliation.completed
operation.compensation.linked
operation.receipt.recorded
```

Approval recording binds authenticated authority. Gate allow binds exact
Operation and Approval. Execution start is durable before backend invocation.
Timeout and exception never imply no-effect failure. Terminal Evidence binds a
verified backend Receipt and postcondition. Approval and execution-start
frontiers are anchored before the external effect. Evidence contains no
credentials, raw protected payload, or unrestricted backend response.

## 39. Effect recovery and concurrency

On restart:

- recorded with no Journal begin is known not executed by Tiangong;
- valid terminal Journal and Receipt can finish an exact Evidence outbox without
  another backend call;
- begin without terminal is uncertain;
- terminal Evidence with missing Journal requires verified backend receipt and
  privileged reconciliation before restoration;
- protected payload remains while pending, executing, or uncertain.

One Operation key serializes execution. Concurrent calls observe executing,
replay terminal Receipt, or receive reconcile-required. Bounded quota uses CAS;
a started Operation consumes quota even when it later fails.

Approval revocation and execution begin share a linearization point. Revocation
first denies execution; begin first means the effect started and revocation only
limits future use. Work revision and execution begin are likewise ordered. A
revision committed first invalidates old authority. If execution began first,
the revision sees an active effect; ordinary Work revision is denied while an
Operation is executing or uncertain. Emergency response uses a separate
recovery or incident Work rather than changing the meaning of the active
Operation.

## 40. Package 3 truth table

| Scenario | Decision |
| --- | --- |
| Isolated read, edit, build, or test | ordinary tool execution |
| Push, publish, deployment, external write, message, or deletion | require Operation |
| Shell command attempts to hide an external effect | deny raw command path |
| Unknown Operation schema, Adapter mismatch, or secret in spec | deny |
| Exact Human Approval matches Operation and current Work | eligible for Gate |
| Operation changes after Human review | Approval does not apply |
| Standing policy covers concrete Operation | derive exact-policy Approval |
| Bounded grant covers Operation and quota is available | derive exact-derived Approval |
| Bounded grant is passed directly to Adapter | deny |
| Operation exceeds bounded scope, cost, time, or target | deny and request new authority |
| Human denial or unauthenticated Leader claim of consent | no Approval |
| Task tries to wait for Human | deny; seal blocked Result and return to Leader |
| All Gate layers pass | begin one idempotent execution |
| Approval missing | approval-required; no effect |
| Operation uncertain | reconcile-required; no retry |
| Target precondition changed | deny; normally create new Operation |
| Backend succeeds and postcondition verifies | succeeded |
| Failure occurs before backend effect | failed-no-effect |
| Request sent then timeout or receipt cannot verify | uncertain |
| Backend partially applies effect | partial; recover or compensate |
| Completed Operation is invoked again | replay saved Receipt |
| Reconciliation proves not applied and authority remains valid | allow same-key retry |
| Reconciliation proves applied | verify and record success |
| Reconciliation remains uncertain | recovery-required |
| External rollback is hidden callback | deny target design |
| Separate compensated Operation has exact Approval | allow |
| Completed Result has an uncertain or partial Operation | Completion fail |
| Blocked Result has no execution start and valid Proposal | eligible for blocked checks |
| Failed Result explicitly preserves uncertain Evidence | may seal failed; Work cannot complete |
| Failed Work later receives reconciliation Evidence | append recovery facts; do not rewrite terminal Decision |
| Journal begin exists with no terminal after restart | uncertain |
| Two concurrent executes | one effect; others wait, replay, or reconcile |
| Approval revocation wins before begin | deny execution |
| Begin wins before revocation | execution fact remains |
| Work revision wins before begin | old Approval invalid |
| Begin wins before revision | revision sees active effect and ordinarily denies |
| Same operation ID with different digest | conflict and fail closed |

## 41. Package 4: organization and behavior shaping

Package 4 defines who belongs to a Team, which Agent definition a Worker runs,
what it is allowed to do, and how instructions, Skills, retrieved knowledge, and
Concerns shape autonomous behavior. Permission remains external to Prompt
content.

Package 4 adds TeamDefinition as a required immutable roster record. Without it,
Work.teamRef and Task.assigneeRef have no exact source for Leader identity,
membership, Worker binding, or AgentDefinition version.

## 42. TeamDefinition contract

```json
{
  "schema": "tiangong.team-definition/v1",
  "teamId": "team-1",
  "leaderMemberId": "member-leader",
  "platformTeamBinding": {
    "provider": "agentteams",
    "teamId": "agentteams-team-1",
    "generationDigest": "sha256"
  },
  "members": [
    {
      "memberId": "member-leader",
      "workerRef": {
        "provider": "agentteams",
        "workerId": "leader-worker",
        "bindingDigest": "sha256"
      },
      "agentDefinitionRef": {
        "agentDefinitionId": "delivery-leader",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "teamPolicyRef": {
    "policyId": "team-policy/default-delivery",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins roster and member-binding semantics. |
| `teamId` | Supplies stable Tiangong Team identity. |
| `leaderMemberId` | Identifies exactly one Leader without inferring a role name. |
| `platformTeamBinding` | Pins the authenticated platform Team and exact observed roster generation. |
| `members` | Binds each admitted Worker generation to an exact AgentDefinition. |
| `teamPolicyRef` | Pins Team defaults and configurable policy boundaries. |
| `contentDigest` | Lets Work bind the exact roster snapshot. |

A Team has exactly one Leader and any number of approved professional members.
Member and Worker identities are unique. The Leader definition must include
coordination capability. The Kernel has no fixed Designer, Implementor,
Assessor, or Operator enumeration.

`platformTeamBinding.generationDigest` is produced by an authenticated platform
Adapter over the exact Team identity and observed roster/resource generation. If
the platform exposes no native generation, the Adapter seals an exact roster
snapshot Artifact and derives the digest from it. Platform existence is a live
fact; Tiangong admission remains this immutable TeamDefinition. A mismatch,
missing Worker, or unproved platform generation denies new dispatch.

Several members may bind the same exact AgentDefinition while each binds a
different exact Worker. These pre-bound replicas are the preferred initial form
of horizontal professional capacity; AgentDefinition identity is not a runtime
lock. A scheduler cannot silently add, replace, or retarget a Worker. Replica or
roster change creates a new TeamDefinition, and an existing Work adopts it only
through a Work revision.

TeamDefinition is immutable. Roster or TeamPolicy change produces a new digest.
An existing Work adopts it only through a new Work revision. Old Task bindings
remain historical facts. Security revocation can prevent dispatch or execution
without rewriting the old TeamDefinition.

TeamDefinition excludes mutable presence or health, Work and Task references,
actor and time, mutable platform container or Matrix details, permission content, Skill
content, workflow, fixed professional role names, metadata, and extensions.

## 43. AgentDefinition contract

AgentDefinition packages stable responsibility instructions, machine capability,
and allowed methods while keeping their authority distinct.

```json
{
  "schema": "tiangong.agent-definition/v1",
  "agentDefinitionId": "backend-engineer",
  "version": "1",
  "responsibilityRef": {
    "artifactId": "agent-responsibility-backend-v1",
    "contentDigest": "sha256"
  },
  "capabilityPolicyRef": {
    "policyId": "capability/backend-engineer",
    "version": "1",
    "contentDigest": "sha256"
  },
  "skillRefs": [
    {
      "skillId": "code-implementation",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins the complete Agent definition. |
| `agentDefinitionId` | Supplies stable Catalog identity. |
| `version` | Supports explicit reviewed evolution. |
| `responsibilityRef` | Pins professional responsibility, boundaries, and judgment principles. |
| `capabilityPolicyRef` | Pins machine-enforced permission independently of instructions. |
| `skillRefs` | Supplies the approved method set for varied work in one profession. |
| `contentDigest` | Lets Team and Task bind the exact definition. |

SOUL is not a separate domain object. An existing SOUL document may be the
responsibility Artifact. It shapes professional behavior but cannot register a
tool, grant a path or environment, authorize an Operation, override Gate, or
decide Completion.

AgentDefinition excludes Worker and Team identity, Work and Task state,
model/provider, tool names, credentials, selected Skill state, Concern state,
retrieval results, transcript, mutable enabled flag, metadata, and extensions.

## 44. CapabilityPolicy contract

```json
{
  "schema": "tiangong.capability-policy/v1",
  "policyId": "capability/backend-engineer",
  "version": "1",
  "capabilityRefs": [
    {
      "capabilityId": "repository.read",
      "version": "1",
      "contentDigest": "sha256"
    },
    {
      "capabilityId": "repository.modify-isolated",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "scopePolicyRef": {
    "policyId": "resource-scope/backend-engineer",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

Capability references are code-owned grants such as team coordination,
repository read, isolated modification, isolated test, Artifact creation,
Operation preparation, or exact effect execution. Undeclared capability is
denied.

Effective permission is an intersection:

```text
Control Kernel
AND TeamPolicy ceiling
AND Agent CapabilityPolicy
AND Task ExecutionPolicy
AND live EnvironmentPolicy
```

Every layer can narrow and none can widen another. Skill, RAG, Task prose, and
model output grant no capability. Standing effect authorization does not imply
that an Agent has the capability to execute that effect.

CapabilityPolicy excludes Prompt and SOUL, Skill references, credentials,
arbitrary tool globs, default allow, runtime state, model identity, metadata,
and extensions.

## 45. TeamPolicy contract

TeamPolicy composes versioned defaults and bounded configurable policy modules.
It is not Control Kernel, workflow, roster, permission union, or Prompt.

```json
{
  "schema": "tiangong.team-policy/v1",
  "policyId": "team-policy/default-delivery",
  "version": "1",
  "controlKernelRef": {
    "kernelId": "tiangong-control-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "moduleBindings": [
    {
      "slot": "task-control",
      "policyRef": {
        "policyId": "task-control/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "execution-concurrency",
      "policyRef": {
        "policyId": "execution-concurrency/standard-work",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "effect-authorization",
      "policyRef": {
        "policyId": "effect-authorization/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "knowledge-access",
      "policyRef": {
        "policyId": "knowledge-access/internal",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "concern-selection",
      "policyRef": {
        "policyId": "concerns/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins TeamPolicy composition semantics. |
| `policyId` | Supplies stable policy identity. |
| `version` | Supports explicit Team-policy evolution. |
| `controlKernelRef` | Prevents Kernel changes from silently changing an existing Team. |
| `moduleBindings` | Selects strict code-known defaults and configurable modules. |
| `contentDigest` | Lets Team pin exact defaults from which Work policy is resolved. |

Code owns a finite slot catalog, including task control, execution concurrency,
resource budget, completion, work closure, quality baseline, effect authorization, environment access,
knowledge access, Concern selection, Human interaction, reporting, and
retention. Each slot has at most one resolved PolicyRef and a strict schema with defaults and bounded
override ranges. This is policy composition, not a workflow or expression DSL.

Work creation resolves Team defaults plus allowed Work overrides into an
immutable ResolvedWorkPolicy referenced by Work.policyRef. Omitted values are
materialized before hashing. Overrides cannot breach Kernel floors. TeamPolicy
updates do not retroactively change a Work; adoption requires a Work revision.

TeamPolicy excludes stages, fixed role lists, Agent tool grants, Skill content,
knowledge content, Concern evaluator code, arbitrary rule DSL, Prompt snippets,
mutable overrides, metadata, and extensions.

### 45.1 Execution concurrency and Team scheduler policy

The `execution-concurrency` slot materializes immutable ceilings attributable to
one Work. Its strict module schema is:

```json
{
  "schema": "tiangong.execution-concurrency-policy/v1",
  "policyId": "execution-concurrency/standard-work",
  "version": "1",
  "workLimits": {
    "maxConcurrentTaskRunsPerWork": 4,
    "defaultMaxConcurrentTaskRunsPerMemberForWork": 1,
    "memberLimits": []
  },
  "resourceLeasePolicyRef": {
    "policyId": "resource-lease/default",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

A `memberLimits` entry has exactly `memberId` and
`maxConcurrentTaskRunsForWork`. Entries may be above or below the same-package
default within reviewed TeamPolicy ranges. Every member ID is unique and must
resolve to the exact TeamDefinition bound by the Work revision; duplicate,
dangling, or conflicting entries fail closed. Each value remains bounded by the
Work maximum and live Team and Worker capacity. The Kernel fixes one current
Leader-turn lease per Work, so there is no configurable
`maxConcurrentLeaderTurnsPerWork`.

Team-global capacity is not copied from one Work's ResolvedWorkPolicy because
concurrent Works may bind different TeamPolicy versions. An immutable
administrative TeamSchedulerPolicy is selected by stable team identity:

```json
{
  "schema": "tiangong.team-scheduler-policy/v1",
  "policyId": "team-scheduler/team-1",
  "version": "1",
  "teamId": "team-1",
  "limits": {
    "maxConcurrentLeaderTurnsPerTeam": 1,
    "maxConcurrentTaskRunsPerTeam": 8,
    "maxConcurrentTaskRunsPerWorker": 1
  },
  "fairnessPolicyRef": {
    "policyId": "scheduler-fairness/weighted-fifo",
    "version": "1",
    "contentDigest": "sha256"
  },
  "capacityAdapterRefs": [
    {
      "adapterId": "team-runtime-capacity",
      "version": "1",
      "implementationDigest": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

The current TeamSchedulerPolicy mapping and live Capacity Adapter observations
are namespace-scoped administrative facts, not Work authority. Dispatch
Evidence binds the exact SchedulerPolicy, capacity generations, and observations
used. A policy update may immediately narrow new dispatch for safety without
implicitly cancelling running TaskRuns; an increase only relaxes the Team-side
bound and never expands a Work beyond its
immutable ResolvedWorkPolicy. FairnessPolicy is code-owned, strict, and may use
only bounded authority-checked priority inputs. It cannot interpret arbitrary
model urgency. FairnessPolicy and ResourceLeasePolicy are referenced Policy
packages resolved through the supporting Policy Registry in section 83; each
has an immutable reviewed entry and a strict code-owned schema.

```text
effective concurrency = min(
  immutable Work and member ceilings,
  live Team and Worker ceilings,
  fresh provider and Runner capacity,
  CPU, memory, Workspace, and storage capacity,
  external quotas and cost or token budget,
  compatible resource leases,
  amount of independent useful work
)
```

`maxOpenWorksPerTeam` is not part of either policy. SchedulerPolicy and capacity
state can delay execution but cannot reject or semantically modify an otherwise
admissible Work. Queue, slot, lease, current policy mapping, and capacity are
mutable machine Projection over immutable Policy and Evidence facts, not
business records.

## 46. Skill contract

Skill is an approved method package available to one or more compatible Agent
definitions. It neither changes profession nor grants permission.

```json
{
  "schema": "tiangong.skill/v1",
  "skillId": "regression-test-selection",
  "version": "1",
  "selectionDescription": "Select an evidence-backed regression set from impact analysis and core tests.",
  "instructionRef": {
    "artifactId": "skill-regression-test-selection-v1",
    "contentDigest": "sha256"
  },
  "resourceRefs": [],
  "requiredCapabilityRefs": [
    {
      "capabilityId": "repository.read",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins Skill package interpretation. |
| `skillId` | Supplies stable method identity. |
| `version` | Supports reviewed method evolution. |
| `selectionDescription` | Enables Task-relevant selection from the allowed set. |
| `instructionRef` | Pins exact method instructions. |
| `resourceRefs` | Pins scripts, templates, references, and assets. |
| `requiredCapabilityRefs` | Declares compatibility prerequisites without granting them. |
| `contentDigest` | Lets Context Evidence bind the exact loaded method to TaskRun. |

Professional Skills teach one Agent how to perform work. Leader coordination
Skills teach the Leader how to decompose, delegate, review, and report a classic
multi-Agent pattern. A coordination Skill still acts only through Leader tools
and Guards.

Task does not bind a mandatory Skill list. Runtime selects a subset from
AgentDefinition using TaskSpec hints, selection descriptions, and context, and
Context Evidence records exact loaded digests against TaskRun. An Agent may
load another allowed Skill during a Task. If a method must be machine-enforced, it becomes a Checker or
Gate rather than a Skill-name requirement.

Skill excludes tool-authority semantics, role switching, Practice or
PracticeRun, workflow state, Completion verdict, Approval override, arbitrary
runtime installation, private dependency, secrets, mutable progress, metadata,
and extensions. Bundled scripts remain supply-chain inputs and execute only
through Capability, Task Policy, Gate, and Evidence boundaries.

## 47. Knowledge and retrieval contracts

Tiangong treats retrieval as a constrained knowledge runtime, not a second
truth, authority, or orchestration plane. Knowledge sources first exist as
provenance-bearing Artifacts. Search indexes, embeddings, sparse terms, generated
summaries, ranking scores, and physical backend state are rebuildable derived
data. The exact source Artifact and slice digest remain authority.

Retrieved bytes are untrusted data, never system instruction. They cannot grant
Capability, authorize an Operation, override Kernel, Work, Task, Policy, Gate,
Approval, Skill, or Completion, or prove that a Claim is true. Model synthesis
of retrieved material is a Claim or Artifact, not Evidence. No requirement says
that every Task must use retrieval.

KnowledgeSourceSnapshot, KnowledgeIndexManifest, and RetrievalBundle are typed
Artifact payloads under section 19 rather than new business Aggregates. Their
formal identity and payload digest come only from the outer Artifact Manifest;
the payload does not repeat an Artifact ID or `contentDigest`.
SourceSliceRef is a bounded composite of existing ArtifactRefs, a strict locator,
and a digest; it is not an independent reference family. Physical index state is
a mutable Projection/cache and never receives a domain RecordRef.

### 47.1 Ownership and source lifecycle

Under the global ownership and threat boundaries in sections 2.9–2.10,
Tiangong owns knowledge schemas, source admission and promotion Guards,
KnowledgeAccessPolicy, Adapter allowlists, retrieval budgets, Bundle sealing,
Context admission, citation checks, Evidence events, Recorder allowlists,
recovery, and evaluation gates. AgentTeams supplies only the authenticated
platform identity and storage integration guarantees verified for the active
deployment profile. Storage, index, embedding, reranking, and model providers own
no Tiangong authority and cannot emit trusted Tiangong Evidence.

The code-owned source-kind catalog may admit exact repository snapshots,
architecture and interface documents, accepted requirements, SystemMaps,
TestDefinitions, TestSets, TestPlans, accepted TestRun summaries, approved
incidents and runbooks, organization rules, and explicitly promoted Results or
Findings. Source kind does not establish truth; every source retains its own
Artifact and Claim semantics.

A trusted Source Capture Recorder resolves authenticated scope and baseline,
enforces path, size, type, classification, handling, and retention limits, seals
the source Artifact and KnowledgeSourceSnapshot, and records bounded Evidence.
A repository source binds an immutable commit, tree, or equivalent baseline; it
never indexes a moving TaskRun Workspace in place. Current mutable Workspace
bytes are inspected through authorized direct tools and their own Evidence. A
sealed new source or patch may enter only a later explicit snapshot and index
generation.

No model output, Result, Finding, conversation summary, generated runbook, or
retrieval synthesis becomes reusable Team, tenant, or organization knowledge
merely because it was produced or accepted for one Task. Promotion uses a
separate administrative KnowledgePromotionPolicy and deterministic Guard that
verify eligible schema and provenance, exact target scope and classification,
required independent or Human review Evidence, unresolved Finding, effect and
revocation absence, retention and audience suitability, and trusted Recorder
authority. For example:

```json
{
  "schema": "tiangong.knowledge-promotion-policy/v1",
  "policyId": "knowledge-promotion/governed-technical-material",
  "version": "1",
  "eligibleSourceKinds": [
    "architecture-document",
    "accepted-result",
    "incident-record",
    "approved-runbook"
  ],
  "eligibleArtifactSchemaRefs": [
    {
      "schemaId": "artifact-schema/technical-document",
      "version": "1",
      "contentDigest": "sha256"
    },
    {
      "schemaId": "artifact-schema/accepted-result-export",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "targetScopeKinds": ["work", "team", "tenant"],
  "modelAuthoredDisposition": "independent-review-required",
  "requiredCheckerRefs": [
    {
      "implementationId": "knowledge-promotion/provenance-checker",
      "version": "1",
      "implementationDigest": "sha256"
    }
  ],
  "reviewAuthorityPolicyRef": {
    "policyId": "knowledge-review/technical-material",
    "version": "1",
    "contentDigest": "sha256"
  },
  "handlingPolicyRef": {
    "policyId": "handling/internal-source",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

KnowledgePromotionPolicy is an administrative Policy package, not a
ResolvedWorkPolicy slot. `knowledge-source.promoted` is distinct from source
creation, Result acceptance, and Work acceptance. No fixed Knowledge Curator
role is introduced; the actor must possess exact administrative capability and
authority.

Source correction creates a new Artifact and snapshot. Revocation is a new
administrative fact that blocks new retrieval without rewriting old sources or
historical Bundles. Physical index deletion is cache maintenance, not historical
erasure. Protected payload deletion remains governed by RetentionPolicy, legal
hold, Artifact pins, and explicit Evidence.

### 47.2 KnowledgeSourceSnapshot and SourceSliceRef

A KnowledgeSourceSnapshot binds one exact admitted source set:

```json
{
  "schema": "tiangong.knowledge-source-snapshot/v1",
  "scope": {
    "kind": "work",
    "ref": {
      "workId": "work-123",
      "revision": 2,
      "contentDigest": "sha256"
    }
  },
  "sourceKind": "repository-snapshot",
  "sourceArtifactRefs": [
    {
      "artifactId": "repository-snapshot-123",
      "contentDigest": "sha256"
    }
  ],
  "classification": "internal",
  "handlingPolicyRef": {
    "policyId": "handling/internal-source",
    "version": "1",
    "contentDigest": "sha256"
  },
  "captureImplementationRef": {
    "implementationId": "knowledge-source-capture/git",
    "version": "1",
    "implementationDigest": "sha256"
  }
}
```

The outer ArtifactRef, such as artifact ID
`knowledge-source-snapshot-123` plus Manifest digest, is the snapshot's formal
identity. `scope` is a strict discriminated union over exact platform, tenant, Team, Work,
or public-supply-chain references. Bare scope IDs are invalid. Source kind,
classification, and handling use finite strict catalogs. Actor and trusted time
remain Evidence.

A SourceSliceRef points into one exact source Artifact:

```json
{
  "sourceSnapshotRef": {
    "artifactId": "knowledge-source-snapshot-123",
    "contentDigest": "sha256"
  },
  "sourceArtifactRef": {
    "artifactId": "repository-snapshot-123",
    "contentDigest": "sha256"
  },
  "locator": {
    "kind": "source-line-range",
    "path": "worker/agent/runtime.mjs",
    "startLine": 120,
    "endLine": 178,
    "symbol": "Runtime.execute"
  },
  "sliceDigest": "sha256"
}
```

Locator is a code-owned discriminated union over source line range, syntax node,
document section, JSON pointer, table region, or whole bounded Artifact. Path
normalization rejects absolute paths, traversal, ambiguous Unicode, symlink
escape, and alternate encodings. The locator must reproduce bytes matching
`sliceDigest`. Slice metadata, sparse terms, vectors, and summaries inherit the
source classification.

### 47.3 Index build and activation

A Knowledge Index Builder consumes exact source snapshots through deterministic,
allowlisted parsers and chunkers. Structure-aware slicing precedes fixed-size
fallback. Parser output never executes source code, document macro, or embedded
payload. Unsupported, ambiguous, recursive, oversized, encrypted, malformed,
symlink-escaping, or binary inputs are rejected or captured as non-retrievable
Artifacts with a stable reason.

Each logical point identity derives from source snapshot digest, source Artifact
digest, locator, slice digest, and exact parser/chunker generation. Generated
titles or summaries, if indexed, are marked Claim-derived and never returned as
the cited source. A build produces a KnowledgeIndexManifest:

```json
{
  "schema": "tiangong.knowledge-index-manifest/v1",
  "indexId": "knowledge-index-team-1",
  "generation": 7,
  "securityRealmRef": {
    "policyId": "knowledge-realm/team-1",
    "version": "1",
    "contentDigest": "sha256"
  },
  "sourceSnapshotRefs": [
    {
      "artifactId": "knowledge-source-snapshot-123",
      "contentDigest": "sha256"
    }
  ],
  "backendRef": {
    "implementationId": "knowledge-index/qdrant",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "parserRefs": [
    {
      "implementationId": "knowledge-parser/tree-sitter-javascript",
      "version": "1",
      "implementationDigest": "sha256"
    }
  ],
  "chunkerRef": {
    "implementationId": "knowledge-chunker/structural",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "sparseEncoderRef": {
    "implementationId": "knowledge-sparse/bm25",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "embeddingRef": {
    "implementationId": "knowledge-embedding/default",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "metadataSchemaRef": {
    "schemaId": "knowledge-index-metadata",
    "version": "1",
    "contentDigest": "sha256"
  },
  "pointCount": 2400,
  "pointSetDigest": "sha256"
}
```

`indexId` and `generation` are logical activation coordinates, not Artifact
identity. The outer KnowledgeIndexManifest ArtifactRef is the exact manifest
identity. `securityRealmRef` is an authority PolicyRef. `embeddingRef` may be null for a
lexical-only generation. `pointSetDigest` covers a canonical sorted manifest of
logical point identities, exact source slices, indexed metadata, and encoder
output digests; it does not hash a backend's nondeterministic physical ANN graph.

Build completion does not activate an index. Trusted Index Manager code validates
source eligibility, point manifest, backend generation, policy, revocation, and
a bounded test set before appending `knowledge-index.activated`. The current
mapping is a CAS-controlled administrative Projection by exact security realm
and purpose. Concurrent builds may finish, but only one wins activation. Readers
pin one generation; retirement waits for pinned readers and retention.

A rebuild may reuse the same generation only when exact manifest inputs and
logical `pointSetDigest` reproduce. Otherwise it creates and validates a new
generation. Index loss never loses source authority.

### 47.4 KnowledgeAccessPolicy

KnowledgeAccessPolicy is the `knowledge-access` TeamPolicy slot materialized in
ResolvedWorkPolicy. It is strict and cannot contain Prompt text or an arbitrary
filter expression. A representative package is:

```json
{
  "schema": "tiangong.knowledge-access-policy/v1",
  "policyId": "knowledge-access/internal",
  "version": "1",
  "sourceAccess": {
    "allowedSourceKinds": [
      "repository-snapshot",
      "architecture-document",
      "system-map",
      "approved-runbook"
    ],
    "allowedScopeKinds": ["work", "team", "tenant", "public"],
    "allowDirectCrossWorkSources": false,
    "maximumClassification": "internal"
  },
  "retrieval": {
    "defaultRequirement": "optional",
    "allowedModes": ["exact", "sparse", "dense", "rerank"],
    "queryRewrite": "disabled",
    "maxQueryBytes": 4096,
    "maxCandidatesPerChannel": 50,
    "maxReturnedSlices": 12,
    "maxSourceBytes": 65536,
    "maxContextTokens": 8192,
    "maxLatencyMs": 5000,
    "maxRetries": 1
  },
  "processing": {
    "indexBackendRefs": [
      {
        "implementationId": "knowledge-index/qdrant",
        "version": "1",
        "implementationDigest": "sha256"
      }
    ],
    "embeddingDisposition": "local-only",
    "embeddingAdapterRefs": [
      {
        "implementationId": "knowledge-embedding/default",
        "version": "1",
        "implementationDigest": "sha256"
      }
    ],
    "rerankerAdapterRefs": [],
    "externalDestinationRefs": []
  },
  "freshnessPolicyRef": {
    "policyId": "knowledge-freshness/baseline-bound",
    "version": "1",
    "contentDigest": "sha256"
  },
  "handlingPolicyRef": {
    "policyId": "handling/internal-source",
    "version": "1",
    "contentDigest": "sha256"
  },
  "retentionPolicyRef": {
    "policyId": "retention/retrieval-bundle-default",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

The concrete schema materializes allowed source kinds and exact scopes, maximum
classification, Work/Team/tenant/public combination rules, source and index
freshness, exact lexical/dense/reranking dispositions and Adapter refs, local or
allowlisted external destinations, query/candidate/slice/byte/token/latency/cost
and retry budgets, query-rewrite disposition, protected-data retention, and
`required`, `optional`, or `forbidden` behavior as narrowed by Task
ExecutionPolicy.

Cross-Work content is denied by default. Team or tenant content requires an
explicitly admitted source snapshot and matching handling and audience policy.
A TeamWorkIndex is not a content-access bypass. KnowledgeAccessPolicy grants no
repository, storage, network, tool, capability, Approval, or effect authority.

KnowledgePromotionPolicy and KnowledgeRealmPolicy are administrative packages,
not ResolvedWorkPolicy slots. KnowledgeRealmPolicy owns exact hard security
namespace and current index-purpose mapping semantics; it does not contain
source bytes or business status.

### 47.5 Retrieval subject, algorithm, and Bundle

Retrieval subject is a code-owned discriminated union. A member invocation binds
one exact TaskRunRef. A Leader invocation binds exact WorkRef, Leader member,
AgentDefinition, and `leader-turn.started` EvidenceRef. The current fencing epoch
is intentionally a live Guard and Evidence fact rather than immutable subject
identity. This closes Leader retrieval without creating LeaderRun or
CoordinationTurn. The strict Leader variant is:

```json
{
  "kind": "leader-turn",
  "workRef": {
    "workId": "work-123",
    "revision": 2,
    "contentDigest": "sha256"
  },
  "leaderMemberId": "member-leader",
  "agentDefinitionRef": {
    "agentDefinitionId": "delivery-leader",
    "version": "1",
    "contentDigest": "sha256"
  },
  "turnStartedEvidenceRef": {
    "ledgerId": "work:work-123",
    "sequence": 42,
    "hash": "sha256"
  }
}
```

`leaderMemberId` resolves only within the exact TeamDefinition bound by WorkRef.
Request Guard and retrieval/Context Evidence additionally validate the live
epoch.

The guarded algorithm is:

```text
exact TaskRun or fenced Leader-turn subject + protected query
-> validate subject, epoch, capability, budget, and requirement
-> resolve exact KnowledgeAccessPolicy, HandlingPolicy, and live revocation
-> select exact active index generations
-> apply hard security-realm and metadata pre-filters
-> collect exact structural, sparse lexical, and optional dense candidates
-> perform deterministic bounded fusion and optional exact reranking
-> revalidate every source, slice digest, classification, and access
-> apply deterministic diversity and authority-preserving token packing
-> seal RetrievalBundle and append knowledge.retrieved
-> recheck revocation and admit Bundle to exact Context Assembly
```

Security filtering occurs before candidate retrieval and again before source
fetch and Context use. Post-filtering alone is insufficient. Exact identifier,
path, symbol, error, policy, and test-name channels remain available when dense
retrieval is enabled. Scores are observations with canonical finite
representation, not comparable truth.

RAG complements rather than replaces authorized repository read, search, and
inspection tools. Direct tools are authoritative for current mutable Workspace
state. A direct fallback uses exact source authorization and records its own
Artifact/Evidence facts; it is never silently represented as an index result.
A model-generated query or rewrite remains Claim-derived input and cannot change
source scope or policy. Evidence normally stores query digest, byte count, and
stable request identity rather than raw query text.

A RetrievalBundle records only slices actually admitted to Context:

```json
{
  "schema": "tiangong.retrieval-bundle/v1",
  "subject": {
    "kind": "task-run",
    "taskRunRef": {
      "runId": "run-123",
      "contentDigest": "sha256"
    }
  },
  "requestDigest": "sha256",
  "knowledgePolicyRef": {
    "policyId": "knowledge-access/internal",
    "version": "1",
    "contentDigest": "sha256"
  },
  "indexManifestRefs": [
    {
      "artifactId": "knowledge-index-manifest-team-1-generation-7",
      "contentDigest": "sha256"
    }
  ],
  "retrieverRef": {
    "implementationId": "knowledge-retriever/hybrid",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "fusionRef": {
    "implementationId": "knowledge-fusion/rrf",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "rerankerRef": null,
  "slices": [
    {
      "sourceSnapshotRef": {
        "artifactId": "knowledge-source-snapshot-123",
        "contentDigest": "sha256"
      },
      "sourceArtifactRef": {
        "artifactId": "repository-snapshot-123",
        "contentDigest": "sha256"
      },
      "locator": {
        "kind": "source-line-range",
        "path": "worker/agent/runtime.mjs",
        "startLine": 120,
        "endLine": 178,
        "symbol": "Runtime.execute"
      },
      "sliceDigest": "sha256",
      "channelRanks": {
        "exact": null,
        "sparse": 3,
        "dense": 1,
        "fused": 1,
        "reranked": null
      }
    }
  ],
  "packing": {
    "tokenizerRef": {
      "implementationId": "tokenizer/model-context",
      "version": "1",
      "implementationDigest": "sha256"
    },
    "sliceCount": 1,
    "sourceBytes": 2400,
    "contextTokens": 620,
    "truncated": false
  }
}
```

The outer RetrievalBundle ArtifactRef is its only formal identity. The Bundle
payload binds ordered slices, exact locators and digests, policy, index
manifests, retrieval/fusion/reranking implementations, and packing. Actor,
trusted time, provider outcome, latency, fencing epoch, and EvidenceRef remain
Evidence facts where copying them would duplicate authority or form a digest
cycle.

The runtime derives a stable invocation key from code-owned schema, exact
subject, Context Assembly invocation identity, call ordinal, request digest,
PolicyRef, and pinned manifests. Same key and facts replay the exact Bundle;
same key with different facts conflicts. A new invocation may produce a new
Bundle because ANN or provider observations may differ. Recovery reuses the
sealed Bundle and never reruns retrieval while claiming unchanged Context.

A citation is a Claim-to-SourceSliceRef link. A Checker can verify source and
snapshot existence, locator and digest, subject access, admitted Bundle or
separate authorized tool access, and structural freshness. It proves source
identity and access, not interpretation or conclusion.

### 47.6 Security, effects, freshness, and failure

Defense in depth requires exact principal, Team, Work, and retrieval subject;
hard security-realm separation; mandatory pre-filtering; post-candidate source
and slice revalidation; exact Artifact fetch; model-inaccessible credentials;
and zero-tolerance cross-tenant, cross-Team, cross-Work, and classification
leakage tests. Prompt-injection detection may annotate data but is not the
security boundary. Retrieved instructions never alter tool schemas or Gates.

Embeddings, sparse terms, query and ranking traces, generated summaries, index
payloads, and Bundles inherit source or query sensitivity. Evidence and
telemetry contain only bounded identities, digests, counts, and stable codes.
Raw protected source, query, vector, sparse term, Prompt, path prohibited by
policy, model response, or credential is excluded.

External embedding or reranking is a disclosure and metered invocation requiring
an allowlisted Adapter, exact destination, HandlingPolicy, budget, journal, and
Evidence. Permission to use one provider for model inference never implies
permission to use it for embedding or reranking. EffectPolicy classifies actual
disclosure, cost, retention, and provider semantics. When Package 3 applies, a routine Task-origin call inside a
pinned standing or bounded envelope materializes one concrete Operation and
`exact-policy` or `exact-derived` Approval per execution identity or bounded
batch without a Human round trip. Quota consumption is atomic. A new destination,
region, model, retention behavior, classification boundary, or high-cost envelope
requires new bounded or `exact-human` authority and follows the parent blocked
Result/new Task flow.

Operation origin remains closed. A Leader turn cannot acquire an implicit
system-origin Operation; it uses an allowed local or non-Operation Adapter or
delegates external preparation through a formal Task. Administrative index
construction that requires an Operation likewise uses a formal maintenance
Work/Task. Batch limits cannot hide broader disclosure or cost. Retry cannot
silently change provider, region, model, or retention terms; uncertain effect or
cost follows Journal reconciliation.

Freshness is structural before temporal. Repository knowledge must match the
exact Work or Task baseline. Changed source creates a new snapshot and slice
digest. Live source and security revocation are checked for old Bundles. Temporal
freshness applies only where policy declares real expiry and trusted clock health
is known.

Cross-Work promotion and index activation require their governing administrative
Evidence to be Anchored before use. Revocation or quarantine narrows use as soon
as its trusted durable append is visible and is synchronously checkpointed. It
linearizes with Context commit: revocation first denies Context; committed
Context first remains a historical fact but all later retrieval and Context use
are denied. Revocation never rewrites historical Bundles.

An active index may lag only within a bounded Policy window. A required newer
source causes exact-source fallback or retrieval unavailability, never stale
substitution. Source digest mismatch quarantines the generation and fails closed.
Required TaskRun retrieval failure seals a framework failed Result. Required
Leader retrieval failure aborts that exact turn. Optional failure continues only
with recorded omission under exact subject policy; forbidden retrieval is
denied.

### 47.7 Technology and evaluation boundary

The runtime exposes narrow Tiangong-owned ports:

```text
KnowledgeSourcePort
KnowledgeParserPort
KnowledgeIndexBuilder
KnowledgeIndexPort
EmbeddingAdapter
RerankerAdapter
RetrievalBundleSealer
ContextAssembler
```

A generic RAG library may be a non-authoritative helper but cannot own Policy,
source admission, TaskRun or Leader identity, Artifact sealing, Evidence,
Context authority, or recovery. Retrieval does not justify Kafka, a workflow
engine, graph database, new business Aggregate, or second truth store.

Technology promotion requires a versioned public or synthetic evaluation corpus
and machine-captured results; private source material is never committed as an
evaluation fixture. Deterministic checks cover canonical digests, parser
and locator reproducibility, malformed/archive/symlink/traversal rejection,
scope and classification denial, pre- and post-filter enforcement, stale-index
revocation, event-key replay, activation CAS, Bundle/context outbox recovery,
TaskRun and Leader fencing, secret exclusion, index loss/rebuild, and lexical
fallback.

Quality evaluation measures expected-slice recall, MRR or nDCG, exact identifier
and path retrieval, multilingual and paraphrase needs, citation validity and
support coverage, stale-source rejection, diversity, Context utilization,
latency, resources, provider calls, and cost. Dense or reranked retrieval is
promoted only when it materially beats the structural/lexical baseline enough to
justify added risk and operational surface. Security promotion requires zero
observed unauthorized scope/classification leakage in deterministic adversarial
cases and no authority expansion from retrieved instructions.

Sanitized OpenTelemetry may record source-capture duration and outcome, parser
and chunk counts, index generation and point count, per-channel retrieval
latency and candidate counts, Bundle slice and token counts, cache/rebuild/denial
codes, and provider outcome. It excludes raw source, query, vector, sparse term,
Prompt, Bundle payload, unrestricted path, model response, and credential.
Telemetry never authorizes retrieval or proves source truth.

## 48. Concern contracts

Concern is forward-looking advisory guidance derived from current facts. It does
not grant permission, block an action, decide Completion, or require acceptance.
Agent and Team Concerns use separate evaluators and input models but share a
small display envelope.

### 48.1 ConcernDefinition

```json
{
  "schema": "tiangong.concern-definition/v1",
  "concernId": "evidence-after-latest-write",
  "version": "1",
  "scope": "agent",
  "evaluatorRef": {
    "evaluatorId": "evidence-after-latest-write",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "guidanceRef": {
    "artifactId": "concern-guidance-evidence-freshness",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

### 48.2 ConcernView

ConcernView is a derived Projection rather than an immutable business record:

```json
{
  "definitionRef": {
    "concernId": "evidence-after-latest-write",
    "version": "1",
    "contentDigest": "sha256"
  },
  "scopeRef": {
    "taskId": "task-123",
    "contentDigest": "sha256"
  },
  "state": "drift",
  "severity": "warning",
  "subjectRefs": [],
  "factRefs": [],
  "guidance": "Verification evidence predates the latest materialized output.",
  "suggestedActions": ["rerun-relevant-verification"],
  "snapshotDigest": "sha256"
}
```

State is `active`, `drift`, or `resolved`; severity is `info` or `warning`.
There is no critical severity. Conditions that must block are Gate or Completion
rules. Suggested actions still pass through Agent or Leader judgment and Guards.

Agent Concern reads one Task, TaskRun, selected Skills, tool Evidence, Artifacts,
completion attempts, and budget. Team Concern reads Work, Tasks, Results,
Decisions, Findings, Operations, Approvals, budgets, tests, and environments.
Their evaluator logic is not forced into one generic schema.

TeamPolicy selects enabled definitions and bounded thresholds; it does not own
evaluator logic. Concern may inspect provisional active-tail Evidence but marks
its basis strength. `concern.presented` proves guidance was shown, not that the
guidance was correct. Repeated drift may justify a new Checker or Gate. Human
does not receive raw Concern by default; Leader converts relevant conditions
into inform, decide, or authorize interaction.

Concern excludes blocking or permission flags, direct Task/Decision/Approval or
Operation creation, generic model evaluator, mutable acknowledgement, workflow
transition, raw telemetry, metadata, and extensions.

## 49. Context assembly

Each model turn assembles exact references in authority order:

```text
Control Kernel and tool schemas
Agent Capability boundary
Agent responsibility instructions
Work and current Task contract when present
selected Skills
current ConcernViews
ordered RetrievalBundles
conversation and subject-local Claim prose
```

Lower layers cannot change higher-layer authority. Prompt marks Skill as method,
Concern as advice, and retrieved slices as delimited untrusted reference data.
Source text cannot inject a system, tool, Policy, Approval, or authorization
instruction. Required higher-authority content is never truncated to preserve
retrieved text. If the budget cannot hold required authority and minimum required
knowledge, assembly fails rather than silently dropping authority.

For a TaskRun, `agent.context.assembled` binds exact TaskRun and current fencing
epoch; Work and Task; AgentDefinition and responsibility; selected Skills;
Concern snapshot; ordered RetrievalBundles; resolved policies; system Prompt and
tool-schema digests; model, Runtime, tokenizer, and ContextAssembler
ImplementationRefs; protected conversation-summary ArtifactRef when present;
input budget, packing and truncation decisions; and final Context digest. It
contains references and digests, not full Prompt, query, source, or secret.

Leader is the unique Team member with coordination capability and relevant
coordination Skills and Team Concern view. It decides semantic next actions and
Human communication, but cannot bypass Gate, Completion, Approval, Catalog, or
Capability boundaries.

A Leader turn is assembled for exactly one Work and current fencing epoch. It
includes the exact Work head, ResolvedWorkPolicy, accepted Results, current
coordination Projection, Team Concern snapshot, exact Evidence frontier, Leader
and AgentDefinition, `leader-turn.started` EvidenceRef, runtime and model
identity, ordered Leader-subject RetrievalBundles, and only a policy-filtered
cross-Work resource or fairness Projection. It never receives another Work's
confidential content or a global mutable transcript. `leader.context.assembled`
records the same authority, packing, implementation, and final Context digests.
The epoch is validated live and recorded in Evidence; this creates no LeaderRun
or CoordinationTurn Aggregate. Model response remains a Claim.

Context packing is deterministic for exact inputs. Revocation and Context commit
linearize under section 47. Same exact Context Assembly invocation replays the
existing event and Bundle refs; conflicting inputs conflict. A restart loads the
exact Bundles and Context refs rather than retrieving latest content as an
equivalent substitute.

A rebuildable TeamWorkIndex may expose open and terminal WorkRefs, current heads,
waiting Leader attention, TaskRun counts, budgets, normalized resource claims,
executing or uncertain Operations, and policy-visible fairness inputs. It does
not own status, create a Portfolio aggregate, authorize coordination, act as a
knowledge-content bypass, or expose content beyond HandlingPolicy.

## 50. Package 4 commands and Guards

| Command | Deterministic Guard |
| --- | --- |
| `register_agent_definition` | Administrative/code-owned entry; valid responsibility, Capability, Skill and supply-chain refs; no hidden permission or private dependency. |
| `register_team_definition` | Valid Worker identities; unique members and Worker bindings; exactly one coordination-capable Leader; valid TeamPolicy; repeated AgentDefinition allowed only through different exact members and Workers. |
| `register_team_policy` | Valid Kernel; unique known slots including execution concurrency; strict module schemas; no Kernel weakening. |
| `register_team_scheduler_policy` | Administrative authority; exact stable team identity; strict limits and FairnessPolicy; allowlisted Capacity Adapters; no Work semantics. |
| `select_team_scheduler_policy` | Trusted Policy Registry authority; exact immutable policy for stable team identity; CAS current selection generation; record administrative Evidence. |
| `resolve_work_policy` | Materialize defaults; permit only bounded overrides; resolve every concurrency member against exact TeamDefinition; emit immutable resolved policy. |
| `capture_knowledge_source` | Authenticated source Adapter; exact scope and baseline; allowed kind, path, size, classification, handling, retention, and parser disposition. |
| `promote_knowledge_source` | Exact immutable source; administrative capability; exact KnowledgePromotionPolicy; required review Evidence; no prohibited model-only provenance or live revocation. |
| `revoke_knowledge_source` | Administrative authority; exact source snapshot; stable reason; durable administrative Evidence; immediately block live use. |
| `build_knowledge_index` | Exact admitted snapshots; allowlisted parsers, chunker, backend, encoders, and resource budget; no revoked source. |
| `activate_knowledge_index` | Valid manifest and point-set digest; exact realm and purpose; validation pass; current-generation CAS; Anchored administrative authority before cross-Work use. |
| `quarantine_knowledge_index` | Trusted integrity or security authority; exact generation and stable reason; fence current selection before further use. |
| `retire_knowledge_index` | Exact inactive generation; no prohibited pinned use; retention and recovery material preserved. |
| `create_task` | Extend Package 1: assignee belongs to exact Work Team; definition is not revoked; Task policy is a capability subset. |
| `retrieve_knowledge` | Exact TaskRun or current Work-scoped Leader turn and epoch; capability and exact Work policy; authorized source scopes; fresh pinned manifests; bounded query, processing destination, cost, and output. |
| `seal_retrieval_bundle` | Stable exact invocation; all admitted slices revalidated by source, locator, digest, classification, access, and revocation; strict ranking and packing facts. |
| `assemble_agent_context` | Exact TaskRun or current Leader-turn subject and epoch; only allowed Skills, Bundles, and Concern snapshot; current revocation; HandlingPolicy; authority-preserving deterministic packing. |
| `load_skill` | Skill in AgentDefinition allowlist, not revoked, capability compatible, and resources valid. |
| `evaluate_concerns` | Valid definition and implementation; matching scope; read-only facts; no side effect. |
| `update_team_roster` | Create new TeamDefinition; never mutate old; current Work adopts through revision. |
| `revoke_agent_or_skill` | Administrative authority and recorded revocation; prevent new use; safely terminate affected high-risk execution. |

## 51. Package 4 Evidence, recovery, and concurrency

Definition, Team, Policy, Skill, Concern, knowledge, retrieval, and Context facts
use exact digests rather than full sensitive instructions, source bytes, queries,
vectors, Prompts, or credentials. Skill-loaded does not prove method compliance;
`knowledge.retrieved` does not prove source truth or model use;
`agent.context.assembled` does not prove that a model followed or understood its
Context; Concern-presented does not prove drift.

Administrative knowledge ledgers are namespace-scoped members of section 18's
administrative-ledger family. They reuse its envelope, genesis, anchoring,
retention, Recorder, and fail-closed rules. Required event meanings include:

| Event type | Minimum bounded facts |
| --- | --- |
| `knowledge-source.captured` | exact snapshot, scope, classification, capture implementation, policy and payload digests |
| `knowledge-source.promoted` | snapshot, promotion policy, review/authority EvidenceRefs, target visibility scope |
| `knowledge-source.revoked` | exact snapshot, authority, stable reason, replacement when present |
| `knowledge-index.built` | exact manifest, source snapshots, builder, backend generation, point count and point-set digest |
| `knowledge-index.activated` | realm, purpose, prior and selected generation, CAS generation, authority and validation EvidenceRefs |
| `knowledge-index.quarantined` | exact generation, stable integrity/security reason, current-selection fencing result |
| `knowledge-index.retired` | exact generation, replacement or stable reason, retention disposition |
| `knowledge.retrieval-requested` | exact TaskRun or Leader subject, current epoch, request digest, policy, bounded purpose and limits |
| `knowledge.retrieval-denied` | request EvidenceRef, stable policy or availability reason, no raw query |
| `knowledge.retrieved` | request, Bundle, pinned manifests, exact implementations, source-scope summary and current epoch |
| `agent.context.assembled` | exact TaskRun Context references and digests from section 49 |
| `leader.context.assembled` | exact Work-scoped Leader Context references and digests from section 49 |

Source Capture Recorder owns capture; Knowledge Policy/Registry Recorder owns
promotion and revocation; Index Builder Recorder owns build; Index Manager
Recorder owns activation, quarantine, and retirement; Retrieval Recorder owns
request, denial, and retrieval; Agent Runtime Context Recorder owns Context
events. Adapters, models, physical indexes, Skills, Agents, and raw tool-loop
messages cannot emit these authoritative events.

Catalog and knowledge Policy records are immutable, content addressed, reviewed,
public-dependency safe, and revocable by new administrative facts. A new version
does not revoke an old version. Security or source revocation blocks new
dispatch, Skill load, retrieval, Context commit, tool use, or Operation as
applicable without rewriting historical facts.

Recovery validates Catalog and revocation state, TeamDefinition and unique
Leader, Work team binding, Task assignee AgentDefinition, TaskRun or Leader-turn
subject and current epoch, exact source snapshots and slices, active or
historically pinned KnowledgeIndexManifest, RetrievalBundle, selected Skills,
Context Event, and protected payload availability. ConcernViews are recomputed.
Runtime never guesses loaded Skill or knowledge from transcript and never
substitutes a latest source, policy, manifest, model, or Bundle for an exact
binding.

Retrieval request, Bundle publication, and Evidence use a durable outbox. A
durable event with uncertain Bundle publication completes the exact publication;
a durable Bundle without Context event resumes or aborts that exact assembly.
An identical invocation replays the existing Bundle. Missing required recovery
material fails the TaskRun or aborts the Leader turn. Qdrant or another index
cache may be rebuilt from exact sources and manifests; digest mismatch
quarantines the generation. Concurrent readers pin one generation while build,
activation CAS, retirement, and revocation proceed independently.

One TaskRun's query, token budget, cancellation, Bundle, and Context cannot be
charged to or reused by another Run. One Leader turn's query, budget, Bundle,
and Context cannot be reused by another Work or epoch. Stale owners cannot seal
a Bundle or append retrieval/Context Evidence. Shared index, provider, CPU,
memory, storage, and cost capacity comes from trusted Capacity Adapters. Index
builds use bounded quotas or separate resource pools and cannot starve current
authorized retrieval. Agent-authored urgency has no indexing or retrieval
priority authority. Known required retrieval unavailability may delay an
undispatched Task but creates no TaskRun or blocked Result; capacity loss after
dispatch follows exact required, optional, or forbidden semantics.

Catalog updates and active index mappings use CAS. Work keeps exact Team and
ResolvedWorkPolicy digests. Concurrent identical Skill loads and retrieval
invocations replay. Concern evaluators remain pure and repeatable. Revocation is
linearized against dispatch, retrieval, Context, and tool invocation.

TeamSchedulerPolicy records are immutable, while the administrative current
mapping for a stable team identity is CAS-controlled and Evidence-backed. A
scheduler recovers that exact policy, fresh Capacity Adapter Evidence, slot and
lease generations, and Work-local reservations before dispatching. Unknown,
expired, conflicting, or unauthorized capacity facts narrow capacity to
unavailable; they never widen it. A Work's old concurrency policy remains its
ceiling even when the live Team policy changes.

## 52. Package 4 truth table

| Scenario | Decision |
| --- | --- |
| Team has one Leader and arbitrary approved professionals | allow |
| Team has no Leader or multiple Leaders | deny |
| Define a new security, data, or testing Agent | allow through approved AgentDefinition |
| Core requires the original five role names | reject target design |
| One Worker is bound to two members in one Team | deny |
| Different exact Workers bind the same AgentDefinition | allow horizontal replicas |
| Scheduler silently creates or substitutes a Worker | deny |
| Work adopts a new roster without revision | deny |
| Work revision explicitly adopts new TeamDefinition | allow |
| Task assignee is absent from exact Work Team | deny |
| Task assignee definition is security-revoked | deny dispatch |
| Every capability layer allows an action | eligible for tool Gate |
| Skill claims a tool not present in Agent capability | deny |
| Task asks for more permission than Agent has | deny |
| Task narrows Agent capability | allow |
| Standing deploy authorization exists but Agent lacks deploy capability | deny |
| Responsibility prose says deployment is necessary | no authorization effect |
| Load an approved compatible Skill | allow |
| Leader loads a coordination Skill | allow; all coordination still guarded |
| Skill attempts role or permission switching | deny/no effect |
| Skill script invokes a tool | apply full Capability, Task, Gate, and Evidence controls |
| Runtime installs an unreviewed Skill | deny |
| Required machine behavior must be enforced | implement Checker or Gate, not Skill-name check |
| RetrievalBundle has exact source, slice, manifest, implementation, policy, subject, and packing digests | eligible for context injection as untrusted data |
| Retrieval result lacks source provenance | deny formal Bundle |
| Retrieved content contains instruction injection | treat as untrusted data with no authority effect |
| Retrieved policy document conflicts with current PolicyRef | current machine Policy wins; source remains data |
| Agent lacks source classification access | deny retrieval |
| Model summary of RAG content | Claim or Artifact, not Evidence or reusable knowledge |
| Accepted Result is proposed for future retrieval | require separate KnowledgePromotionPolicy Guard |
| Source correction occurs | create new source Artifact and snapshot; never mutate old |
| Revocation wins before Context commit | deny Context use |
| Context commit wins before revocation | preserve historical assembly; deny later retrieval and Context use |
| Physical index point lacks a valid source Artifact or slice digest | deny and quarantine generation |
| Identical retrieval invocation replays | return exact existing Bundle |
| New ANN invocation returns another order | seal a new Bundle; do not claim equivalence |
| Required TaskRun retrieval is unavailable | seal framework failed Result; do not invent source |
| Required Leader retrieval is unavailable | abort exact turn with Evidence; do not invent source |
| Optional retrieval is unavailable | continue only with recorded omission under exact subject policy |
| Retrieval is forbidden for exact subject | deny command and Context inclusion |
| Current fenced Leader retrieves for exact Work | allow within Capability and Work policy; create no LeaderRun |
| Leader retrieval lacks current turn Evidence or epoch | deny |
| External embedding destination is not allowed for classification | deny egress |
| Dense/reranked retrieval adds quality but leaks scope | reject implementation promotion |
| Vector database is treated as source truth | reject implementation |
| Agent Concern reads Task facts | allow |
| Team Concern reads Work projection | allow |
| One generic evaluator is forced across both scopes | reject design |
| Concern recommends rerunning tests | advice only |
| Concern says block while Gate allows | Concern has no blocking authority |
| Concern condition disappears | resolve or remove Projection |
| Concern repeatedly identifies a must-block risk | promote invariant to Checker or Gate |
| TeamPolicy selects known strict modules | allow |
| TeamPolicy embeds workflow DSL or Prompt | deny |
| Work override remains within allowed range | resolve immutable ResolvedWorkPolicy |
| `memberLimits` references duplicate or non-Team member | deny resolution and fail closed |
| One Work policy claims a Team-global slot count | ignore as global authority; use live Team SchedulerPolicy |
| Team capacity falls below Work ceiling | live capacity narrows execution |
| Model claims more capacity or urgency | no scheduling authority |
| Work override weakens Kernel | deny |
| TeamPolicy updates | do not retroactively change Work |
| Restart restores exact context digests | allow |
| Restart guesses Skill or RAG from transcript | deny |

## 53. Package 5: quality and environment

Package 5 makes a test claim meaningful by binding exact tests, subjects,
configuration, data, environment state, and machine execution facts.

```text
SystemMap -> ImpactAssessment -> TestPlan -> TestRun(s)
          -> QualityAssessment -> Completion or Promotion Gate
```

Except for authoritative EnvironmentDefinition and versioned QualityPolicy,
Package 5 has eight core strict Artifact schemas: SystemMap, ImpactAssessment,
TestDefinition, TestSet, TestPlan, EnvironmentSnapshot, TestRun, and
QualityAssessment. Optional Human-facing TestReport is an ordinary typed
Artifact. This reuses Artifact identity, provenance, handling, and retention
instead of creating parallel stores.

## 54. EnvironmentDefinition contract

EnvironmentDefinition is immutable environment identity and control policy, not
current runtime state.

```json
{
  "schema": "tiangong.environment-definition/v1",
  "environmentId": "pre-production",
  "environmentClass": "pre-production",
  "adapterRef": {
    "adapterId": "kubernetes-environment-adapter",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "environmentPolicyRef": {
    "policyId": "environment-policy/pre-production",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins environment-definition semantics. |
| `environmentId` | Supplies stable environment identity. |
| `environmentClass` | Selects code-owned risk and validation semantics. |
| `adapterRef` | Pins the trusted environment observer and controller. |
| `environmentPolicyRef` | Pins access, configuration, data, network, test, cleanup, and lifecycle rules. |
| `contentDigest` | Lets Operation, TestPlan, and Snapshot bind the exact definition. |

Base classes are `isolated-runner`, `preview`, `integration`, `pre-production`,
`production-canary`, and `production`. Class is a risk classification, not a
mandatory promotion sequence. Teams may define multiple or omit classes;
QualityPolicy and EffectPolicy decide which are required.

EnvironmentDefinition excludes endpoint, credentials, current Artifact,
configuration, data, status, health, actor, time, workflow stage, role names,
metadata, and extensions.

## 55. EnvironmentSnapshot Artifact

A named Environment may change. TestRun therefore binds point-in-time start and
end EnvironmentSnapshot Artifacts rather than an environment ID alone.

```json
{
  "schema": "tiangong.environment-snapshot/v1",
  "environmentRef": {
    "environmentId": "pre-production",
    "contentDigest": "sha256"
  },
  "generation": "environment-generation-42",
  "stateManifestRef": {
    "artifactId": "environment-state-manifest-42",
    "contentDigest": "sha256"
  }
}
```

StateManifest uses a class-specific strict schema and binds deployed subject
Artifacts, configuration, dependencies, Runner or container image, container
configuration, network policy, data boundary, fixtures, environment policy,
resource ownership, lease or generation, observed health, and relevant
Operation receipts.

Snapshot is emitted only by a trusted Environment Adapter with
`environment.snapshot.captured` provenance. It contains no credential or
endpoint. Environment change creates another Snapshot. Tests capture both start
and end; unauthorized generation or critical-state drift makes the run
indeterminate. StateManifest has a strict observation outcome of `observed`,
`absent`, or `unavailable`. Ephemeral destruction uses a machine-proved absent
end Snapshot. If post-run observation cannot complete, an unavailable end
Snapshot binds the failed observation Evidence without inventing state, and the
TestRun is indeterminate. An unavailable start Snapshot never permits execution.

## 56. TestRun Artifact

A TestRun is a terminal machine execution Artifact, not Assessor prose or an
exit code.

```json
{
  "schema": "tiangong.test-run/v1",
  "taskRef": {
    "taskId": "task-test-17",
    "contentDigest": "sha256"
  },
  "testPlanRef": {
    "artifactId": "test-plan-17",
    "contentDigest": "sha256"
  },
  "testDefinitionRefs": [
    {
      "artifactId": "test-order-cancel-api",
      "contentDigest": "sha256"
    }
  ],
  "executionBinding": {
    "subjectArtifactRefs": [
      {
        "artifactId": "orders-service-image",
        "contentDigest": "sha256"
      }
    ],
    "environmentStartRef": {
      "artifactId": "environment-snapshot-start",
      "contentDigest": "sha256"
    },
    "environmentEndRef": {
      "artifactId": "environment-snapshot-end",
      "contentDigest": "sha256"
    },
    "configurationRefs": [
      {
        "artifactId": "orders-config",
        "contentDigest": "sha256"
      }
    ],
    "dataBoundaryRef": {
      "artifactId": "test-data-boundary-17",
      "contentDigest": "sha256"
    }
  },
  "outcome": "passed",
  "caseResultsRef": {
    "artifactId": "test-case-results-17",
    "contentDigest": "sha256"
  }
}
```

The Artifact provenance binds durable test start, Runner identity and image,
execution plan, exact test definitions, subject, configuration, data and
environment, case results, cleanup, end Snapshot, and aggregate outcome.

Outcome is `passed`, `failed`, or `indeterminate`. Passed requires all mandatory
cases and oracles, stable authorized environment state, successful cleanup, and
verifiable Evidence. Assertion or cleanup failure is failed. Runner interruption,
harness failure, unverifiable environment, unauthorized drift, incomplete case
results, or uncertain cleanup is indeterminate. Only passed satisfies a quality
obligation.

TestRun excludes actor and time, mutable status, prose report, raw logs, a lone
exit code, TestSet duplication, bare environment ID, latest-version references,
retry count, percentage pass, metadata, and extensions. Every retry is a new
TestRun Artifact and never overwrites prior failure.

## 57. Test data boundary

Each TestRun binds a TestDataBoundary Artifact, including when it explicitly
uses no persistent data. It defines source and snapshot, synthetic, masked, or
production-derived status, classification, allowed access and writes, unique
test identity, owned resources, cleanup policy, expected terminal state, and
forbidden data.

Production-sensitive data is denied by default. Tests clean only resources they
own. Cleanup failure keeps the run red.

## 58. TestDefinition and TestSet Artifacts

TestDefinition binds stable identity and version, system level, quality
dimensions, exact covered subjects, executable and oracle Artifacts,
environment and data requirements, and side-effect policy.

Levels are `static`, `unit`, `component`, `contract`, `integration`, `scenario`,
and `post-deploy`. Quality dimensions such as functional, security, performance,
compatibility, data migration, resilience, observability, and accessibility are
orthogonal to level. Regression is a selection purpose, not a level.

Test implementation or oracle change creates a new definition. Definition does
not grant permission or determine Core membership.

TestSet is an immutable exact collection:

```json
{
  "schema": "tiangong.test-set/v1",
  "testSetId": "orders-core-tests",
  "version": "3",
  "memberRefs": [],
  "governancePolicyRef": {
    "policyId": "test-set-governance/core",
    "version": "1",
    "contentDigest": "sha256"
  }
}
```

QualityPolicy identifies curated Core TestSets. Adding coverage normally needs
quality acceptance. Removal, disablement, skip, weaker oracle, or weaker
environment requires independent assessment and, for high risk, Human decide.
Historical sets remain immutable.

Regression selection is dynamic:

```text
Core TestSets
+ directly affected subject tests
+ transitive impact-path tests
+ current Finding reproduction tests
+ relevant historical-risk tests
+ QualityPolicy requirements
+ conservative expansion for unknown boundaries
```

## 59. QualityPolicy contract

```json
{
  "schema": "tiangong.quality-policy/v1",
  "policyId": "quality-policy/standard-delivery",
  "version": "1",
  "coreTestSetRefs": [],
  "ruleBindings": [
    {
      "slot": "test-selection",
      "policyRef": {
        "policyId": "test-selection/impact-based",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "environment-matrix",
      "policyRef": {
        "policyId": "environment-matrix/standard",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "independence",
      "policyRef": {
        "policyId": "test-independence/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "contentDigest": "sha256"
}
```

QualityPolicy controls Core sets, impact and selection requirements, levels and
dimensions, environment matrix, independent execution, freshness, flaky and
rerun handling, cleanup, accepted-gap authority, and promotion requirements. It
uses strict code-owned rule slots and does not prescribe a Team workflow.

## 60. SystemMap Artifact

SystemMap is an evidence-backed, explicitly incomplete understanding of exact
source snapshots. A SubjectRef has stable system and subject identity plus a
version-specific subject digest.

SystemMap payload binds system definition, source snapshots, extractor set,
subject and relation shards, and known gaps. Shards prevent a monolithic graph
record. Base subjects include repository, module, service, API, event, schema,
data store, deployment unit, business journey, external dependency, test, and
environment.

Relationships bind exact source and target Subjects, relation type, basis kind,
basis refs, and confidence only for inference. Extracted relations come from
trusted import, route, OpenAPI, schema, migration, build, deployment, and test
analysis and carry machine Evidence. Inferred relations come from documents,
history, AI analysis, or expert claims and carry source Artifacts and explicit
high, medium, or low confidence. Confidence is not proof.

Map input change creates a new Artifact. Deterministic and inferred edges remain
distinct. Known gaps cannot be erased to imply completeness. Graph index is a
rebuildable projection.

## 61. ImpactAssessment Artifact

ImpactAssessment consumes current Work, SystemMap, input Artifacts, optional
Finding references, and an exact ImpactPolicy. Finding references use the exact
Result digest plus JSON Pointer defined by Package 1; they never invent an
independent Finding ID. The Assessment records deterministic seed Subjects,
affected Subjects, relation paths, environment impacts, candidate tests, and
explicit unknowns.

The process freezes source Artifacts and Map, extracts deterministic differences,
propagates through code-owned relation rules, adds source-backed semantic
candidates through AI/RAG, preserves dynamic and unknown boundaries, maps
existing tests, derives environment impact, and receives independent quality
review.

Requirements, code changes, and Findings use the same mechanism; there is no Bug
taxonomy. Direct, propagated, and inferred impact remain distinct. Every
propagation has a path or basis. Unknown is never represented as no impact. Input,
Map, policy, or Work-scope change makes the Assessment unsuitable for the new
version. Assessment recommends tests but cannot prove plan sufficiency.

## 62. TestPlan Artifact

TestPlan binds current Work, subject Artifacts, SystemMap, accepted
ImpactAssessment, QualityPolicy, explicit obligations, selected exact tests and
environments, basis refs, and coverage gaps.

Each obligation names affected Subjects, required levels and quality dimensions,
TestDefinitions, EnvironmentDefinitions, and selection basis. Core TestSets are
mandatory. Every direct impact and high-risk transitive impact has coverage or an
explicit gap. High-risk gaps require policy-authorized Human decide. Plan is a
professional Claim and becomes eligible only through an accepted Task Result.

Any subject Artifact, ImpactAssessment, Map, TestDefinition, Core TestSet,
QualityPolicy, or environment-requirement change makes the Plan stale. TestPlan
expresses obligations and does not orchestrate Agent activity.

## 63. QualityAssessment Artifact

QualityAssessment deterministically aggregates one accepted TestPlan, exact
QualityPolicy and subject Artifacts, TestRun refs, per-obligation results,
Evidence frontier, and verdict `satisfied`, `unsatisfied`, or `indeterminate`.

Every mandatory obligation requires a fresh passed TestRun with matching
subject, test, configuration, data, and environment bindings. The deterministic
evaluator discovers all relevant TestRuns for the Plan and subject bindings up
to its Evidence frontier; listed refs cannot hide an eligible failed or
indeterminate Run. A later pass is a new Run and does not erase an earlier
failure; rerun and flaky policies decide how both facts are treated. The
`quality.assessed` provenance binds the evaluator implementation digest. Coverage gaps follow explicit policy and Human decisions.

QualityAssessment proves execution of an accepted Plan, not that the Plan is
semantically omniscient. Promotion Gate consumes only a fresh satisfied
Assessment. TestReport is a separate Human explanation and never substitutes
for it.

## 64. Quality and environment execution

```text
accepted TestPlan
-> resolve exact TestDefinitions
-> allocate or select Environment
-> acquire lease or generation guard when policy requires it
-> capture start EnvironmentSnapshot under that guard
-> verify subject, configuration, and data binding
-> durable test-run.started Evidence
-> execute exact test assets
-> capture case results
-> clean owned resources
-> capture end EnvironmentSnapshot
-> verify authorized state transition and no drift
-> aggregate outcome
-> seal TestRun Artifact and recording Evidence
```

External resource allocation, data mutation, and cleanup are Operations with
exact Approval where their effect boundary requires it. A run never broadens
cleanup from user-controlled input.

The preferred multi-environment rule is build once and promote the same immutable
Artifact. Environment-specific rebuild creates a different Artifact and requires
independent proof. Unit success in isolated Runner does not prove integration,
pre-production, canary, or production behavior; each QualityPolicy obligation
binds the environment in which it is meaningful.

## 65. Package 5 commands and Guards

| Command | Deterministic Guard |
| --- | --- |
| `register_environment_definition` | Administrative authority; valid Adapter and Policy; legal class; no endpoint or secret. |
| `capture_environment_snapshot` | Trusted Adapter; exact Definition; matching StateManifest and Evidence; no hidden credential. |
| `record_system_map` | Exact source snapshots and ExtractorSet; extracted and inferred relations separated; known gaps preserved. |
| `record_impact_assessment` | Current Work and exact Artifact, Map, and Policy refs; every impact has path or basis; unknown explicit. |
| `record_test_definition` | Valid executable, oracle, environment, data, side-effect, and Subject refs; no permission claim. |
| `record_test_set` | Valid unique members and governance; Core weakening has required independent and Human decision. |
| `record_test_plan` | Current exact subjects; accepted Impact; QualityPolicy and environment provenance from ResolvedWorkPolicy; mandatory Core obligations; explicit gaps. |
| `execute_test_run` | Accepted Plan; exact TestDefinitions; reserve unique TestRun Artifact identity and attempt key; authorized environment, data and configuration; trusted Runner and lease. |
| `record_test_run` | Valid start and end Snapshots, case results, cleanup, Evidence, and consistent aggregate outcome. |
| `assess_quality` | Accepted Plan; fresh exact Runs; deterministic per-obligation result; no selective hiding of failure. |
| `promote_artifact` | Package 3 Operation requiring the exact Artifact and fresh satisfied QualityAssessment. |

## 66. Package 5 Evidence, freshness, recovery, and concurrency

Required events include SystemMap extraction and enrichment, impact assessment,
TestDefinition, TestSet and TestPlan recording, environment snapshot and lease,
test start, per-case completion, cleanup start and terminal outcome, test
completion and recording, and quality assessment. Evidence binds Runner image,
policy, execution plan, fixtures, subject, configuration, data, environment,
case and cleanup facts. Raw logs are Artifacts; prose report is not execution
Evidence.

Freshness is exact and relational:

- Map binds source snapshots and extractors;
- Impact binds Map, inputs, policy, Finding, and Work scope;
- Plan binds subjects, Impact, Map, tests, Core sets, QualityPolicy, and
  environment requirements;
- Run binds Plan, tests, subjects, start/end environment state, configuration,
  data, and Runner policy;
- QualityAssessment binds Plan, Runs, policy, Evidence frontier, and subjects.

Any relevant digest or explicit temporal requirement change requires a new
Assessment, Plan, or Run; no mutable stale field is written.

Maps, tests, sets, plans, runs, and assessments are immutable. Catalog-head and
Core-set updates use CAS. Environment execution uses generation or lease and
marks unauthorized concurrent drift indeterminate. Before start, runtime
reserves a unique TestRun Artifact ID and attempt key bound to Task, Plan,
definitions, and execution binding. Replay of that same reserved key returns its
saved outcome; a retry reserves a new Artifact ID and key, preserving the prior
Run. Runner loss after start seals an indeterminate TestRun and performs owned
cleanup or reconciliation.

QualityAssessment uses a fixed frontier. Concurrent Runs do not enter an
existing Assessment. Recovery validates exact Artifacts, Evidence, Runner,
Snapshots, resources, and cleanup; it never guesses a pass from transcript or
partial output.

## 67. Package 5 truth table

| Scenario | Decision |
| --- | --- |
| TestRun records only environment ID | deny |
| TestRun binds exact start/end Snapshots, subject, config, and data | eligible for validation |
| Same EnvironmentDefinition runs another Artifact or configuration | old Run does not apply |
| Environment generation changes during test without authorization | indeterminate |
| Assertions pass but cleanup fails | failed |
| Runner or environment outcome is unknowable | indeterminate |
| Report says pass without TestRun Artifact and Evidence | does not prove pass |
| Extracted relation has machine Evidence | record as extracted |
| AI relation has source and confidence | record as inferred claim |
| AI relation has no basis | deny formal relation |
| Map has known gaps | valid but not complete |
| Input or Map changes | old Impact and dependent Plan stale |
| Unknown impact is represented as no impact | deny |
| Core tests are all included | satisfy Core minimum |
| AI removes mandatory Core test to reduce cost | deny |
| Direct impact has test or explicit gap | eligible for Plan review |
| High-risk unknown has neither test nor gap | deny |
| Test or oracle is weakened in Core | require governed new version and decision |
| All cases, oracles, cleanup, and environment checks pass | Run passed |
| One oracle fails | Run failed |
| Only aggregate exit code exists | insufficient TestRun |
| Retry follows failure | new Run; preserve both facts |
| QualityAssessment hides an earlier failure | deny |
| All mandatory obligations have fresh matching passed Runs | satisfied |
| Mandatory obligation failed | unsatisfied |
| Mandatory obligation is unverifiable | indeterminate |
| Promotion binds fresh satisfied Assessment and exact Artifact | eligible for Package 3 Gate |
| Same Artifact digest is promoted through multiple environments | traceable evidence chain |
| Environment rebuild creates another Artifact | require new verification |
| Unit success is presented as pre-production scenario proof | deny |
| Environment class is used as a fixed workflow stage | reject design |

## 68. Runtime closure

Runtime closure defines the four records already required by Packages 1–5:
TaskRun, HumanInteraction, ResolvedWorkPolicy, and Operation Journal. It adds no
business workflow layer.

```text
ResolvedWorkPolicy
        |
Work -> Task -> TaskRun -> context, tools, completion -> Result
        |
Leader -> HumanInteraction -> HumanResponse -> Decision or Approval
        |
Operation -> Operation Journal -> idempotent effect and recovery
```

## 69. TaskRun contract

TaskRun is the immutable runtime binding for one dispatched Task. A dispatched
Task has exactly one TaskRun. Dispatch reservation, `task.dispatched`, and
TaskRun opening are one atomic or recovery-equivalent boundary; a Task waiting
for capacity has no TaskRun. Process restart may resume that same Run only when
its exact Task, Runtime, Workspace, and Context references can be reconstructed.
Otherwise the framework seals a failed Result and the Leader may create a
replacement Task.

```json
{
  "schema": "tiangong.task-run/v1",
  "runId": "run-123",
  "taskRef": {
    "taskId": "task-123",
    "contentDigest": "sha256"
  },
  "runtimeRef": {
    "runtimeId": "tiangong-agent-runtime",
    "version": "1",
    "implementationDigest": "sha256",
    "runtimePolicyRef": {
      "policyId": "agent-runtime/default",
      "version": "1",
      "contentDigest": "sha256"
    }
  },
  "workspaceBindingRef": {
    "artifactId": "workspace-binding-123",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins runtime-binding semantics. |
| `runId` | Binds Evidence, Context, tools, and budget events. |
| `taskRef` | Pins the exact immutable delegation. |
| `runtimeRef` | Pins the trusted runtime implementation and policy. |
| `workspaceBindingRef` | Pins baseline, mounts, isolation, cwd, and Runner environment. |
| `contentDigest` | Prevents silent binding changes. |

WorkspaceBinding is a strict Artifact that binds source baseline, ownership,
allowed and denied mounts, cwd, EnvironmentDefinition, isolation, network,
fixtures, scratch and output locations, and cleanup policy. It contains no
credential.

Task remains the single source for Work, assignee, ExecutionPolicy, and
CompletionPolicy. Actual model identity, Skills, RetrievalBundles, Concerns,
Prompt digest, tool calls, budget consumption, Operations, and completion
attempts are dynamic Evidence or Artifact facts bound to TaskRun. They are not
mutable TaskRun fields.

TaskRun excludes status, phase, assignee copy, Work copy, Skill and retrieval
state, Concern state, current model, budget counters, ResultRef, current tool,
transcript, chain of thought, actor, time, metadata, and extensions.

## 70. TaskRun invariants and context

- an undispatched Task has no TaskRun;
- a dispatched Task has at most one and, once execution starts, exactly one;
- authenticated Worker and platform generation must match the exact MemberRef,
  workerRef, and AgentDefinitionRef resolved through Task WorkRef;
- Runtime and Workspace must satisfy Task ExecutionPolicy;
- TaskRun never waits for Human input;
- TaskRun has no business phase;
- each Context Assembly records exact digests;
- Skill, RAG, Concern, or model changes do not mutate TaskRun;
- Task ExecutionPolicy narrows retrieval to `required`, `optional`, or
  `forbidden`; required retrieval failure seals a framework failed Result;
- RetrievalBundle subject must equal the TaskRun and every retrieval and Context
  append must validate the current fencing epoch;
- execution budget is resolved from Task policy;
- budget exhaustion seals a framework failed Result;
- terminal authority comes from Result and Evidence, not a Run status;
- recovery uses Task, Artifact, Evidence, Journal, and exact Context refs;
- missing or revoked required material fails rather than silently changing the
  execution identity;
- external-effect uncertainty is reconciled before Task terminal handling;
- replacement creates a new Task, not another Run for the old Task;
- each live TaskRun has a separate model Session, Context state, Workspace and
  cwd, mount namespace, tool invocation and local journal state, Operation
  ownership and Journal attempt references, Evidence subjects, Artifact output
  namespace, token and cost budget, cancellation scope, Completion state, and
  RecoveryContext;
- cancelling, exhausting, fencing, or recovering one Run cannot terminate,
  charge, resume, or complete another Run;
- a Work Ledger may be shared, but every append binds exact TaskRun and current
  fencing epoch;
- one Worker may own several live Runs only when exact Work, Team, and
  RuntimePolicy limits, Worker capacity, and the runtime implementation all
  permit the count;
- otherwise concurrency above one per Worker fails closed.

Each model turn has a logical Context Snapshot binding TaskRun,
AgentDefinition, Responsibility, selected Skills, Work and Task, ordered
RetrievalBundles, Concern snapshot, resolved policy digests, actual model/runtime,
system Prompt digest, deterministic packing facts, and optional protected
conversation-summary Artifact. The `agent.context.assembled` Evidence event
records these references and digests. A conversation summary is a Claim Artifact
under HandlingPolicy; hidden model reasoning is neither required nor stored.

Retrieval invocation identity binds TaskRun, Context invocation, call ordinal,
request digest, PolicyRef, and pinned manifests. Same invocation replays its exact
Bundle; another invocation may produce another Bundle. One Run cannot reuse or
be charged for another Run's query, Bundle, Context, budget, cancellation, or
provider call.

On restart the runtime reads Task and TaskRun, resolves exact AgentDefinition,
Skills, source and policy revocation, RetrievalBundles, and Context Events,
recomputes current Concern, and builds a machine-fact RecoveryContext from
Artifact and Evidence. It continues the same Run only when all required bindings
verify and no tool, retrieval, or Operation uncertainty is unresolved. It never
reruns retrieval or selects latest content while claiming the same Context. A
new execution owner receives a higher lease epoch for the same runId only after
the previous owner is fenced.

Multiple exact Workers bound to one AgentDefinition provide the preferred first
horizontal scaling mode, with one active TaskRun per Worker. Same-Worker
multi-Run remains disabled until deterministic tests prove every mutable axis
above is run-scoped across execution, cancellation, crash, and recovery.

## 71. HumanInteraction contract

HumanInteraction is the Leader's immutable formal interaction contract with a
Human. It never contains a later response or mutable waiting state.

```json
{
  "schema": "tiangong.human-interaction/v1",
  "interactionId": "interaction-123",
  "workRef": {
    "workId": "work-123",
    "revision": 2,
    "contentDigest": "sha256"
  },
  "semantics": "decide",
  "purpose": "test-plan-review",
  "audienceRef": {
    "audienceKind": "policy-role",
    "audienceId": "work-requester",
    "authorityPolicyRef": {
      "policyId": "human-audience/work-requester",
      "version": "1",
      "contentDigest": "sha256"
    }
  },
  "presentationRef": {
    "artifactId": "human-presentation-123",
    "contentDigest": "sha256"
  },
  "basisRefs": [],
  "responseContract": {
    "schema": "tiangong.human-response-contract/decision/v1",
    "optionIds": ["accept", "request-revision", "cancel"],
    "responseSchemaRef": null,
    "validUntil": "2026-08-06T10:00:00.000Z",
    "cardinality": "one"
  },
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `schema` | Pins the interaction envelope. |
| `interactionId` | Correlates delivery, response, and deduplication. |
| `workRef` | Pins the scope revision under discussion. |
| `semantics` | Authoritatively distinguishes inform, decide, and authorize. |
| `purpose` | Supplies a non-authoritative display and routing label. |
| `audienceRef` | Pins the principal or policy role eligible to receive and answer. |
| `presentationRef` | Pins exactly what the Human saw, including attachment manifest. |
| `basisRefs` | Pins relevant Results, Artifacts, Findings, Decisions, or Operations. |
| `responseContract` | Defines whether and how a response may be accepted. |
| `contentDigest` | Prevents replacement of the question, options, or presentation. |

`inform` needs no response and covers progress, risk, quality, file delivery,
recovery, and final reports. `decide` asks for semantic judgment such as scope,
design, test-plan, known-gap, or final acceptance. `authorize` asks for machine
permission and binds an exact Operation or bounded-grant proposal. Decide never
substitutes for authorize.

HumanInteraction excludes mutable state, response, sender, time, raw mutable
message, mutable attachment, Task ownership, Approval, CoordinationDecision,
free-form semantics, purpose-based authority, and extension fields. The
Presentation Artifact is sealed before the Interaction and must not reference
that Interaction digest, avoiding a digest cycle. Delivery is an Operation; the
Interaction itself does not claim successful delivery.

## 72. HumanResponse Artifact and interaction invariants

An authenticated Human response is a strict HumanResponse Artifact with
`human-response.captured` provenance. Decision payload is:

```json
{
  "schema": "tiangong.human-response/decision/v1",
  "interactionRef": {
    "interactionId": "interaction-123",
    "contentDigest": "sha256"
  },
  "selectedOptionId": "accept",
  "responseContentRef": null
}
```

Authorization payload is:

```json
{
  "schema": "tiangong.human-response/authorization/v1",
  "interactionRef": {
    "interactionId": "interaction-456",
    "contentDigest": "sha256"
  },
  "decision": "approve",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "presentationDigest": "sha256"
}
```

Schema-valid free-form response content is a separate exact ArtifactRef rather
than inline unbounded text. Authorization may bind a strict bounded-grant
proposal instead of Operation only when the response contract explicitly
allows it.

The Response is basis for, but not itself, a CoordinationDecision or Approval.
Consumption atomically records `human-response.consumed` with the created
Decision, Work revision, or Approval. Inform responses are ordinary new Human
input rather than mutation of the original Interaction.

- only the Leader or trusted system boundary creates formal interactions;
- professional members do not interact formally with Human directly;
- no Task waits for a response;
- Interaction, Presentation, and Response are immutable;
- actual respondent must satisfy AudiencePolicy;
- a valid response requires trusted delivery or presentation Evidence for the
  exact Interaction, Presentation, audience, and channel;
- response binds exact Interaction digest and must satisfy type, cardinality,
  and validity window;
- decide and authorize are not interchangeable;
- authorization binds exact effect intent and viewed presentation;
- free-form assent outside a valid authorize interaction is not Approval;
- same response replay is idempotent;
- a different response cannot overwrite a consumed single response;
- changed Human intent creates a new Interaction, Response, and Decision;
- an expired or old-Work response cannot directly produce current authority;
- after Work termination, only policy-authorized terminal or recovery `inform`
  delivery is allowed; decide or authorize starts from a new Work;
- original Human content is a Claim Artifact, while authentication and receipt
  are Evidence;
- delivery is an Interaction-origin Operation using exact standing or bounded
  communication authority and cannot depend on authorization requested by the
  same undelivered Interaction;
- quiet reporting preference never suppresses decide, authorize, or recovery
  exception interactions.

## 73. Human reporting policy

ProgressReport is an `inform` HumanInteraction. Final and recovery reports may
be delivered after Work termination under the narrow terminal-inform exception;
they append Evidence and never reopen or revise the Work. Required triggers are
initial understanding when policy requires it, decide or authorize requests, material
scope or plan change, high-risk Finding, blocked or recovery-required state,
material quality conclusion, and final completion. Milestone reports may follow
accepted key Results, important Artifacts, major branch completion, material
risk or budget change, and QualityAssessment.

A heartbeat is eligible only when Work remains active, policy interval elapsed,
new facts exist, Human is not in quiet mode, and no higher-priority Interaction
supersedes it. A digest of the reported projection suppresses duplicate reports.
Reports state changed facts, confirmed completion, current focus, next step,
risk and uncertainty, required Human action, and exact Result, Artifact, and
Quality refs. They expose neither chain of thought nor raw logs.

## 74. ResolvedWorkPolicy contract

ResolvedWorkPolicy is the complete immutable expansion of TeamPolicy defaults
and legal Work overrides. Runtime never consults a mutable current default after
Work creation.

```json
{
  "schema": "tiangong.resolved-work-policy/v1",
  "policyId": "resolved-work-policy/work-123-r2",
  "version": "1",
  "sourceTeamPolicyRef": {
    "policyId": "team-policy/default-delivery",
    "version": "3",
    "contentDigest": "sha256"
  },
  "controlKernelRef": {
    "kernelId": "tiangong-control-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "moduleBindings": [
    {
      "slot": "task-control",
      "policyRef": {
        "policyId": "task-control/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "execution-concurrency",
      "policyRef": {
        "policyId": "execution-concurrency/work-123-r2",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "quality-baseline",
      "policyRef": {
        "policyId": "quality-policy/standard-delivery",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "overrideBasisRefs": [],
  "contentDigest": "sha256"
}
```

All mandatory slots are materialized with no runtime inheritance or implicit
default. Slots include task control, execution concurrency, execution budget,
completion, work closure, capability, quality, effect, environment, knowledge, Concern, Human
interaction, reporting, retention, and any other Kernel-mandated policy. Slot
names and resolution rules are code-owned.

Resolution is a deterministic pure function over exact Kernel, TeamPolicy,
module, and override inputs. It completes before the Work revision that adopts
it; override basis cannot depend on that target Work digest, avoiding a digest
cycle. Overrides remain within TeamPolicy ranges and cannot weaken Kernel. Any
material change creates a new ResolvedWorkPolicy. A Work adopting it creates a
new Work revision; existing Work, Task, Result, and Operation facts retain old
policy semantics. Policy contains no workflow, Prompt, arbitrary code, or
extension bag. `work-policy.resolved` Evidence binds inputs and output digest.

Cross-package policy provenance is mandatory:

- Work.teamRef resolves a TeamDefinition whose teamPolicyRef exactly equals the
  ResolvedWorkPolicy sourceTeamPolicyRef;
- TeamPolicy and ResolvedWorkPolicy bind the same Control Kernel;
- Task ExecutionPolicy and CompletionPolicy are selected from or validly narrow
  the resolved Task and completion modules;
- ExecutionConcurrencyPolicy contains only immutable Work and member ceilings,
  and every member limit resolves against the exact Work TeamDefinition;
- Operation EffectPolicy is selected from the resolved effect module;
- TestPlan QualityPolicy and allowed environments are selected from the
  resolved quality and environment modules;
- Human audience, interaction, reporting, and authorization policy come from
  the resolved Human and effect modules;
- Handling, KnowledgeAccessPolicy, retention, and Concern policy use the
  corresponding resolved slots; KnowledgePromotionPolicy and KnowledgeRealmPolicy
  remain administrative and are never resolved as Work slots.

Live TeamSchedulerPolicy, Worker availability, and Capacity Adapter facts are
revalidated at dispatch and may only narrow the resolved Work ceilings. They are
not copied into ResolvedWorkPolicy and cannot retroactively widen it.

A downstream record cannot select an unrelated or weaker policy merely because
that policy is valid in the Catalog. Work creation and revision atomically
recheck this full provenance chain.

## 75. Operation Journal binding

Operation Journal is machine coordination state for idempotency, replay, and
recovery. Evidence is the auditable observation chain. Journal and Evidence are
separate but linked through a durable outbox.

Each Operation has at most one immutable Journal Binding:

```json
{
  "schema": "tiangong.operation-journal-binding/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "idempotencyKey": "sha256",
  "requestDigest": "sha256",
  "protectedPayloadDigest": null,
  "contentDigest": "sha256"
}
```

| Field | Contract reason |
| --- | --- |
| `operationRef` | Pins exact effect intent. |
| `idempotencyKey` | Gives execution, replay, and recovery one stable identity. |
| `requestDigest` | Prevents request substitution. |
| `protectedPayloadDigest` | Lets recovery validate inaccessible sensitive material. |
| `contentDigest` | Prevents binding mutation. |

Approval is bound on each attempt rather than copied into Journal Binding. A
reconciled retry may reuse an exact Approval only when its grant and current
policy still allow the same Operation attempt, or may require a new exact
Approval. Operation and idempotency key remain unchanged.

## 76. Operation Journal event

```json
{
  "schema": "tiangong.operation-journal-event/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "sequence": 1,
  "eventKey": "sha256",
  "eventType": "execution-started",
  "attemptRef": {
    "attemptId": "attempt-1",
    "executorRef": {
      "kind": "task-run",
      "ref": {
        "runId": "run-123",
        "contentDigest": "sha256"
      }
    },
    "approvalRef": {
      "approvalId": "approval-123",
      "contentDigest": "sha256"
    },
    "invocationDigest": "sha256"
  },
  "facts": {
    "executionPlanDigest": "sha256"
  },
  "previousHash": "sha256",
  "hash": "sha256"
}
```

`eventKey` is deterministically derived from Operation, event type, attempt or
reconciliation identity, and logical phase. Identical key and content replay;
identical key with different content conflicts. The first event uses
`digest("sha256", jcs("tiangong-jcs/v1", JournalBinding))` as its genesis
previous hash, and every event hash uses the same digest contract over the event
without `hash`.

Event types are `prepared`, `execution-started`, `execution-succeeded`,
`execution-failed-no-effect`, `execution-partial`, `execution-uncertain`,
`reconciliation-started`, `reconciliation-applied`,
`reconciliation-not-applied`, `reconciliation-partial`,
`reconciliation-uncertain`, `receipt-recorded`, `replay-served`,
`protected-payload-released`, and `compacted`. Each has a strict code-owned
facts schema.

Operation projection is derived from this append-only per-Operation hash chain.
Journal actor and trusted time are Evidence, receipts are Artifacts, and secrets
or raw backend response never enter Journal facts.

## 77. Operation Journal invariants

- one Operation has at most one Binding;
- Binding is immutable and event sequence is contiguous and hash-chained;
- same eventKey and content replay idempotently; same key with differing content conflicts;
- Approval validation, first-use allocation or same-Operation retry validation,
  and `execution-started` are one linearized transaction or
  recovery-equivalent protocol;
- each backend attempt binds exact Approval and invocation plus either the
  authorized TaskRun executor or the trusted system-runtime executor allowed for
  an Interaction-origin delivery;
- all attempts preserve Operation idempotency key;
- started without terminal projects uncertain;
- uncertain blocks another attempt until reconciliation;
- only reconciliation-not-applied can make retry eligible;
- retry has a new attempt identity, a current-Work Operation, and an exact
  Approval valid for that attempt;
- succeeded replay returns saved Receipt without backend execution;
- terminal Receipt is an Artifact, not raw Journal payload;
- Journal-to-Evidence publication uses a durable outbox;
- corruption fails closed;
- protected payload remains while outcome is uncertain;
- payload release is Journal and Evidence fact;
- explicit compaction is allowed only after terminal summary, Anchor, retention,
  and absence of recovery dependency, and must preserve continuity and replay
  proof;
- models cannot read or modify Journal.

## 78. Runtime composition

Ingress composition is:

```text
receive authenticated channel identity and bounded content digest
-> evaluate exact platform or tenant IngressPolicy
-> replay prior admission, deny with durable administrative Evidence,
   or reserve Work ledger and atomically record a new Work
```

Agent runtime composition is:

```text
eligible undispatched Task
-> scheduler applies fairness, Work ceilings, live capacity, and resource Guards
-> reserve exact slots and Workspace; atomically dispatch and open TaskRun
-> perform required/optional/forbidden retrieval under exact subject and policy
-> seal or replay exact RetrievalBundles
-> assemble exact run-scoped context
-> autonomous model turn
-> tool Guard, Evidence, and Artifact capture
-> recompute Agent Concern
-> Result candidate
-> deterministic Completion Check
   -> continue within Task, or seal completed/blocked/failed Result
-> terminate TaskRun, fence execution, and release leases
```

Leader composition is:

```text
acquire one Work-scoped turn lease and fencing epoch
-> perform authorized Leader-subject retrieval when required or useful
-> assemble exact Work context, Evidence frontier, Bundles, and policy-filtered Team view
-> choose semantic coordination action
-> commit through epoch validation and Work-head CAS
-> create or supersede Tasks, accept or reject Results
-> create HumanInteraction when needed
-> create Work revision for scope change
-> terminate Work when the objective is resolved
-> complete or abort turn Evidence and release lease
```

Scheduler composition is:

```text
project eligible immutable Tasks across Works
-> order with code-owned FairnessPolicy
-> intersect Work ceilings with live Team, Worker, provider, Runner, budget,
   Workspace, and resource capacity
-> atomically reserve, dispatch, and open one TaskRun
-> on unavailable capacity leave Task undispatched and retry deterministically
```

Human composition is:

```text
seal HumanInteraction
-> delivery Operation
-> Human views exact Presentation
-> authenticated HumanResponse Artifact and Evidence
-> consume once as CoordinationDecision, Work revision, or Approval
```

These compositions explain trust boundaries. They are not workflow graphs and
do not prescribe the Leader's professional strategy. Scheduler retry is machine
coordination and never requires a durable DispatchIntent or Leader polling.

## 79. Runtime closure commands and Guards

| Command | Deterministic Guard |
| --- | --- |
| `admit_human_request` | Trusted Ingress Recorder; exact IngressPolicy and channel identity; deterministic correlation and replay; bounded Claim Artifact; execution saturation is not admission denial. |
| `begin_leader_turn` | Exact Team Leader and Work head; no current Work turn lease; any prior owner fenced; Team Leader slot available; issue next monotonic epoch and fixed Evidence frontier. |
| `complete_leader_turn` | Current lease owner and epoch; bind committed record EvidenceRefs or explicit no-command completion; release only after owner fencing. |
| `record_capacity_observation` | Exact allowlisted Capacity Adapter and metric; strict scope, unit, values, generation, validity, and administrative ledger. |
| `reserve_dispatch_capacity` | Eligible Task; exact current Work policy and live SchedulerPolicy; fresh capacity Evidence; fairness eligibility; compatible resource claims; atomically reserve all slots. |
| `open_task_run` | Same atomic dispatch transaction; no Run or Result; current slot and execution epoch; exact Runtime and Workspace; Worker matches assignee. |
| `assemble_context` | Exact TaskRun or current Leader-turn subject and epoch; valid AgentDefinition, Skills, Bundles, Concern, and Policy refs; live source and security revocation; HandlingPolicy; deterministic authority-preserving packing; no mutable state from another Work, Run, or turn. |
| `resume_task_run` | Exact Run; prior owner fenced; current higher epoch; no terminal Result; Context reconstructible; no unresolved effect uncertainty; budget permits. |
| `terminate_task_run` | Result sealed or framework failed Result sealed; no hidden active execution; fence owner before slot and lease release. |
| `acquire_resource_lease` | Normalized internal resource identity; compatible current ownership; exact policy, TaskRun, generation, epoch, and expiry. |
| `release_resource_lease` | Exact current owner or trusted recovery manager; old owner fenced; release Evidence durable. |
| `record_human_interaction` | Leader or trusted boundary; current Work; Human, audience, reporting, and effect policy provenance valid; matching semantics and contract; valid Presentation and basis. |
| `deliver_human_interaction` | Package 3 Operation; exact Interaction; deduplicated; channel and audience authorized. |
| `capture_human_response` | Authenticated Human; exact Interaction and trusted presentation/delivery Evidence; valid audience, channel, contract, and time; seal Response Artifact and Evidence. |
| `consume_human_response` | Valid unconsumed response; semantics match; atomically create Decision, Work revision, or Approval. |
| `resolve_work_policy` | Exact TeamPolicy and Kernel; all defaults materialized; overrides authorized and in range. |
| `open_operation_journal` | Valid Operation, request, and payload digests; absent or identical replay. |
| `begin_operation_attempt` | Origin and exact TaskRun or trusted system executor match; exact valid Approval; no active or uncertain attempt; preconditions pass; atomically allocate first use or validate same-Operation retry and start. |
| `append_operation_terminal` | Trusted Adapter; matching attempt; consistent Receipt and facts; durable Evidence outbox. |
| `reconcile_operation_journal` | Privileged Reconciler; uncertain or partial Operation; strict result schema. |
| `compact_operation_journal` | Terminal, retained and Anchored; no recovery dependency; continuity proof retained. |

## 80. Runtime closure Evidence

Required events include `human-request.received`, `human-request.admitted`,
`human-request.replayed`, `human-request.admission-denied`,
`leader-turn.started`, `leader.context.assembled`, `leader-turn.completed`,
`leader-turn.aborted`, `capacity.observed`,
`team-scheduler-policy.selected`, `scheduler.slot-reserved`,
`scheduler.capacity-unavailable`, `scheduler.slot-released`,
`scheduler.lease-suspect`, `scheduler.lease-reconciled`,
`workspace.binding-prepared`, `workspace.resource-lease-acquired`,
`workspace.resource-lease-released`, `task-run.opened`, `task-run.resumed`,
`task-run.budget-exhausted`, `task-run.terminated`,
`knowledge.retrieval-requested`, `knowledge.retrieval-denied`,
`knowledge.retrieved`, `agent.context.assembled`, `human-interaction.recorded`,
`human-interaction.delivered`, `human-response.captured`,
`human-response.consumed`, `human-response.rejected`,
`work-policy.resolved`, `operation-journal.opened`,
`operation-payload.released`, and `operation-journal.compacted`. Package 3
`operation.execution.*`, `operation.reconciliation.*`, and
`operation.receipt.recorded` Evidence additionally binds Journal sequence and
attempt identity; Runtime Closure does not create duplicate execution event
meanings.

Recorder allowlists are disjoint by event meaning: Ingress Recorder owns
`human-request.*`; Leader Runtime Recorder owns Leader-turn and Leader-context
events; exact Capacity Adapters own `capacity.observed`; the administrative
Policy Registry Recorder owns `team-scheduler-policy.selected`; Knowledge Source,
Policy, Index Builder, Index Manager, and Retrieval Recorders own only their
section 51 event families; Team Scheduler Recorder owns `scheduler.*`; Workspace
or Runner Manager Recorder owns `workspace.*`; and Agent Runtime Recorder owns
TaskRun and Agent-context events. A Recorder may not impersonate another
boundary. Every scheduling and Workspace event binds the
current fencing epoch. Event schemas contain bounded references, digests,
generations, units, values, and stable reason codes, never queue dumps, Prompts,
transcripts, credentials, or private cross-Work content.

TaskRun events bind exact Task. Context events contain references and digests,
not copied secrets. Human delivery binds exact Presentation; response Evidence
binds authenticated Human; consumption binds the resulting Decision, Work
revision, or Approval. Journal and Evidence outbox recover without exposing
protected payload, credential, hidden reasoning, or raw sensitive Prompt.

## 81. Runtime closure recovery and concurrency

TaskRun opening uses Task and Work-head CAS plus current scheduler and execution
fencing epochs. Slot reservation, dispatch Evidence, and TaskRun opening are one
transaction or write-ahead protocol with a durable Evidence outbox. Recovery
must either complete that exact dispatch or prove it invisible and release the
fenced reservation; it never creates another dispatch authority. Same binding
replays and another TaskRun binding conflicts.

Result sealing and Run termination are coordinated. Exact recoverable Run uses
the same runId under a current epoch only after the old owner is fenced. Missing
context, revoked authority, unreconciled tool outcome, exhausted budget, or
unfenceable prior execution seals a failed Result rather than creating another
Run. Scheduler slots, Workspace, resource leases, tool state, budget,
cancellation, Artifact sealing, Completion, and RecoveryContext remain isolated
by runId and epoch.

Leader-turn recovery fences or transfers the Work-scoped lease, increments its
epoch, reads current immutable facts, and replans. It never restores authority
from hidden model state. A coordination command still performs Work-head CAS
even when the lease is healthy. Stale Leader and TaskRun epochs cannot append
trusted Evidence, seal Artifacts or Results, begin TaskRun-owned Operations, or
release current leases.

Team scheduler recovery reconstructs its exact current SchedulerPolicy,
FairnessPolicy, fresh Capacity Adapter observations, reservations, TaskRuns, and
lease generations. Unknown or expired capacity narrows dispatch eligibility.
One Work cannot supply a Team-global limit. A lower live limit blocks new
dispatch immediately without implying cancellation of running TaskRuns; a higher
limit cannot exceed each Work's immutable ceiling.
Scheduler queue recovery derives eligible Tasks from records and never replays a
separate DispatchIntent.

Workspace recovery proves the old process or container fenced before reuse.
Parallel WorkspaceBindings may share one immutable baseline but not a mutable
cwd or mount. Internal resource leases reconcile owner generation and epoch;
external shared effects continue to use Operation Journal reconciliation.

Ingress recovery validates the administrative Ledger, exact IngressPolicy,
channel-message identity, payload digest, and original admission result. Exact
replay returns the prior WorkRef; saturation never causes a second Work or loss
of accepted input.

Outstanding Human interactions are projected from delivery and response
Evidence. Captured unconsumed responses are deterministically consumed. Same
response replays; conflicting or expired response cannot overwrite authority.
A Work revision revalidates outstanding interaction applicability.

ResolvedWorkPolicy resolution is deterministic and content-addressed. Concurrent
identical resolution deduplicates. TeamPolicy update does not affect resolved
Work. Work revision CAS determines adoption. TeamSchedulerPolicy selection and
capacity are live administrative constraints and remain outside resolved Work
authority.

Knowledge recovery reconstructs exact source snapshots, live revocations,
manifest generations, Bundle invocation keys, durable outboxes, and Context
Events. Readers remain pinned to one activated generation; rebuild and activation
CAS cannot mutate their Bundle. Source digest mismatch quarantines the generation.
Missing required source or protected query material fails exact recovery; index
cache loss rebuilds from manifests and sources or remains unavailable. A stale
TaskRun or Leader epoch cannot publish a Bundle or Context fact. Revocation and
Context commit share the section 47 linearization rule.

Operation Journal uses per-Operation CAS or serialization. Approval revocation
and attempt start share a linearization boundary. Only one attempt is active;
replay never invokes backend. Journal compaction serializes with read and
reconciliation. Restore from backup respects terminal tombstones and never
resurrects protected payload or completed effects.

## 82. Runtime closure truth table

| Scenario | Decision |
| --- | --- |
| Authenticated admissible request arrives with no execution slot | record Work and defer execution |
| Exact ingress message replays | return original admission and WorkRef |
| Ingress denial lacks exact Policy or trusted Evidence | fail closed |
| Same Leader opens isolated turns for different Works | allow within Team limit |
| Second Leader turn targets one Work | deny while current lease exists |
| Stale Leader epoch attempts a command | deny even if model output is otherwise valid |
| Undispatched Task opens Run | deny |
| Dispatched Task opens first exact Run | allow |
| Same Task and Run binding replay | idempotent |
| Same Task opens a different Run | conflict |
| Eligible Task lacks capacity | no Run; remain undispatched |
| Slot reservation exists without visible dispatch after crash | recover exact transaction or fence and release; never invent Run |
| Worker differs from assignee | deny |
| Workspace baseline differs from Task input | deny |
| Two Runs share mutable Session, Workspace, tool state, budget, or cancellation | deny runtime implementation |
| Different exact Workers use the same AgentDefinition | allow within Team and Work limits |
| One Worker has limit one and a live Run | leave another eligible Task undispatched |
| Same Worker has multiple Runs with fully verified isolation and policy allowance | allow |
| TaskRun waits for Human | deny; seal blocked Result |
| Exact Context is reconstructible and old epoch fenced | resume same Run under current epoch |
| Old execution may still seal trusted output | do not release capacity or resume replacement owner |
| Recovery needs transcript guess | deny recovery |
| Required Skill, Artifact, or authority is revoked | fail Run and Task |
| Required TaskRun retrieval is unavailable | framework failed Result; never invent knowledge |
| Required Leader retrieval is unavailable | abort exact Leader turn with Evidence |
| Optional retrieval is unavailable | continue only when exact policy permits and omission is recorded |
| Retrieval subject or epoch differs from current execution | deny |
| Exact retrieval invocation replays after crash | return existing Bundle and recover its outbox |
| Physical index cache is lost | rebuild from exact manifest/source or remain unavailable |
| Source revocation wins before Context commit | deny Context use |
| Context commit wins before revocation | preserve history; deny later use |
| Budget exhausted | framework failed Result |
| Tool call follows terminal Result | deny |
| Leader sends progress or file delivery | inform |
| Human reviews scope, design, tests, or acceptance | decide |
| Human grants external effect permission | authorize |
| Decide response is used as Operation authorization | deny |
| Presentation and proposed Operation differ | deny Approval |
| No authorized delivery Recorder and receipt Evidence record the exact Presentation delivery | deny response authority |
| Respondent fails AudiencePolicy | deny |
| Same HumanResponse replays | idempotent |
| Consumed single response receives a conflict | do not overwrite; create new interaction |
| Quiet mode faces authorize or recovery exception | still notify |
| Same progress projection repeats | suppress |
| Resolved policy fully materializes legal inputs | allow |
| Runtime reads mutable current defaults | deny |
| Override weakens Kernel | deny |
| TeamPolicy updates | old Work unchanged |
| Team live capacity decreases | narrow new dispatch immediately; do not infer cancellation |
| Team live capacity increases | allow only up to each immutable Work ceiling |
| Capacity observation is expired, unknown, or emitted by wrong Recorder | affected capacity unavailable; fail closed |
| Scheduler changes assignee or Task content | deny |
| Work adopts another policy | new Work revision |
| Same Operation and Binding replay | idempotent |
| Same Operation has different request digest | conflict |
| Valid Approval and no active attempt | begin |
| Started has no terminal event | uncertain |
| Uncertain attempt retries directly | deny |
| Reconciliation proves not applied | retry may become eligible |
| Retry has a new valid exact Approval | allow |
| Succeeded Operation is invoked again | replay Receipt |
| Terminal Journal lacks published Evidence | deliver outbox deterministically |
| Journal, Evidence, and backend conflict | reconcile |
| Protected payload is deleted while uncertain | deny |
| Corrupt Journal is automatically truncated | deny and fail closed |

## 83. Reference closure and supporting registries

No reference in this architecture implicitly creates another business aggregate.
Every exact content reference belongs to one of five closed families:

- a domain RecordRef containing its stable identity fields and content digest,
  including AnchorRef;
- an ArtifactRef containing artifact ID and Manifest digest;
- a PolicyRef containing policy ID, version, and content digest;
- an ImplementationRef containing implementation identity, version where
  applicable, and implementation digest;
- a SchemaRef containing schema ID, version, and content digest.

EvidenceRef is the defined ledger, sequence, and hash tuple. MemberRef is a
bounded composite resolved only through the exact Work TeamDefinition and binds
member ID plus member-entry digest; it is not a new content-reference family.
Authenticated principal references and platform Team/Worker bindings are
resolved by authenticated platform boundaries and are not model-authored content
references. CommandDefinitionRef, EventDefinitionRef, CheckerRef, AdapterRef,
and RecorderRef are specialized ImplementationRefs. EventDefinition binds the
exact Event facts SchemaRef and authority rules.

Policy packages include platform- or tenant-administrative IngressPolicy;
administrative TeamSchedulerPolicy, FairnessPolicy, KnowledgePromotionPolicy,
and KnowledgeRealmPolicy; ResourceLeasePolicy; TaskExecutionPolicy; execution
concurrency, closure, effect, environment, quality, handling,
KnowledgeAccessPolicy, Human-interaction, reporting, retention, and the other
finite TeamPolicy slots. KnowledgeAccessPolicy is the `knowledge-access`
TeamPolicy slot and is materialized into ResolvedWorkPolicy. IngressPolicy,
TeamSchedulerPolicy, KnowledgePromotionPolicy, and KnowledgeRealmPolicy are not
ResolvedWorkPolicy slots; admission, dispatch, source promotion, index selection,
retrieval, and Context Evidence bind their exact live administrative facts where
applicable.

Administrative Policies form one governed family even though their operational
scopes differ. IngressPolicy is scoped to an exact platform or tenant ingress
boundary, and every admission decision records the exact PolicyRef in that
scope's ingress ledger. TeamSchedulerPolicy is scoped to a stable team identity,
and its current selection is CAS-controlled and recorded in the corresponding
administrative policy ledger. KnowledgePromotionPolicy is scoped to exact source
and target visibility classes. KnowledgeRealmPolicy is scoped to a hard platform,
tenant, Team, Work, or public-supply-chain realm and controls CAS-selected index
purposes without becoming content authority. Registration, review, versioning,
scope binding, selection where applicable, and revocation require authenticated administrative
authority, immutable catalog entries, strict schemas, and authorized Recorder
Evidence. A new version or selection never rewrites earlier decisions;
revocation is checked live at each relevant admission, dispatch, context, tool,
Gate, and recovery boundary. Administrative Policies cannot grant Work
semantics, Agent capability, Approval, or Completion authority.

Implementation packages include Kernel, Checker, Capacity and effect Adapters,
Team Scheduler, Workspace or Runner Manager, Ingress and other Recorders,
Knowledge Source/Parser/Index/Retrieval/Embedding/Reranking/Context Adapters and
services, Concern evaluator, SystemMap extractor, Runtime, and schema validators.
Each package has an immutable reviewed catalog entry, a strict code-owned schema,
public supply-chain provenance, and revocation facts. It cannot contain a
Prompt-controlled permission expression or generic rule bag.

ArtifactSchema, event facts schema, Operation spec schema, response contract,
environment state schema, and knowledge source locator/metadata schemas use
SchemaRef and reviewed validator implementations; schema identity and executable
validator identity are not interchangeable. SourceSliceRef remains a strict
composite of ArtifactRefs, locator, and digest rather than a new reference
family. Human audience and approval-role definitions are authority-policy
packages. Credential, signing-key, and protected-payload records remain inside
model-inaccessible security stores and are referenced only by safe identity or
digest where a contract requires it.

A consuming command is disabled until every referenced registry kind, strict
schema, validator, authority rule, and revocation check exists. Unknown,
missing, conflicting, or revoked reference resolution fails closed. Concrete
catalog contents are implementation deliverables, but they cannot introduce new
coordination actions, expand permissions, alter digest semantics, or weaken any
Package 1–5 or Runtime Closure invariant.

## 84. Deferred implementation contracts

Implementation planning covers AgentTeams adapters, storage topology, Matrix,
Runner and environment backends, test frameworks, SystemMap extractors, CI,
smoke scenarios, model-provider failover, session backend, physical transaction
strategy, user interface, concrete catalog contents, and repository migration.

The concurrency implementation additionally requires generic eligible-Task
scheduling across Works, Work-head and dispatch CAS, TeamSchedulerPolicy and
Capacity Adapters, FairnessPolicy, monotonic fencing, run-scoped Session and
Context, isolated WorkspaceBindings, ResourceLeasePolicy, exact Worker replica
binding, concurrent Evidence append, capacity and lease recovery, and
vertical smoke scenarios. The fixed `design`, `implement`, `assess`, and
`release` Task-kind transition path is an implementation baseline, not target
authority, and must be removed rather than wrapped in a generic workflow layer.

The first-party `software-change-delivery` profile preserves current product
value as configuration rather than Kernel law. Its TeamDefinition may bind
Leader, Designer, Implementor, Assessor, and Operator AgentDefinitions, while
Policy and deterministic Checkers enforce that an Artifact producer cannot
satisfy its own independent-assessment requirement, assessment and promotion
bind the same immutable Artifact, promotion requires a fresh satisfied
QualityAssessment, high-risk authority cannot self-approve, and rollback verifies
both the exact previous state and restored postcondition. Its vertical smoke
proves these constraints without requiring one fixed Task order.

Knowledge implementation proceeds vertically:

1. **Contract baseline** — strict schemas, in-memory KnowledgeIndexPort,
   deterministic source slicing, Bundle sealing, Context and Evidence, public or
   synthetic leakage fixtures, and no vector dependency.
2. **Structural and lexical retrieval** — pinned public Qdrant client,
   self-hosted hard-realm backend, exact identifiers/paths/symbols, sparse terms,
   activation CAS, rebuild, revocation, recovery, and capacity control.
3. **Dense retrieval and reranking** — local or explicitly approved Adapters are
   added only when evaluation proves material gain over phase 2 and exact model,
   serving, resource, security, and egress contracts are pinned.
4. **Governed organization knowledge** — approved document, incident, runbook,
   and Policy Adapters plus promotion, revocation, temporal freshness, retention,
   and feedback-poisoning controls.

Tree-sitter is the initial structure-aware code parser and self-hosted Qdrant is
the initial replaceable hybrid-index backend. `BAAI/bge-m3` and
`BAAI/bge-reranker-v2-m3` are evaluation candidates, not accepted dependencies
until exact revisions pass quality, resource, supply-chain, license, and security
Gates. Software and runtime dependencies require OSI-approved commercially
compatible licenses; the initial model and tokenizer artifacts require MIT,
Apache-2.0, or another explicitly approved OSI license permitting public
redistribution, modification, and commercial use without field-of-use
restrictions. Non-commercial, research-only, evaluation-only,
source-unavailable, or custom acceptable-use terms are denied. License identity
and text are verified for the exact pinned revision; a model-card label or an
earlier release's license is insufficient.

A knowledge vertical smoke must prove source capture, exact slice and Bundle,
retrieval and Context Evidence, classification denial, prompt-injection
non-authority, Bundle replay, crash/outbox recovery, source revocation,
index-loss rebuild, fencing, and cleanup. This target is not described as
implemented until those contracts and checks exist.

A conservative initial deployment uses one live Leader-turn slot per Team, four
to eight TaskRun slots per Team, two to four TaskRuns per Work, and one live
TaskRun per Worker. Several pre-bound exact Workers may share one
AgentDefinition. Same-Worker multi-Run stays disabled until deterministic tests
prove Session, Workspace, tools, Evidence, Artifact, budget, cancellation,
Completion, fencing, crash recovery, and Operation isolation by TaskRun. These
values are safe starting points, not architectural constants, and are tuned only
from trusted provider, Runner, memory, storage, cost, conflict, and recovery
measurements.

Before a deferred technology becomes a dependency, an ADR pins its exact public
implementation, version or revision, digest, license evidence, deployment
profile, replaceable Port, capacity limits, threat assumptions, rollback, and
validation results. Names in this section are target defaults or evaluation
candidates, not permission to bypass that ADR and dependency review.

After contract closure stabilizes, executable JSON Schemas, EventDefinitions,
and canonicalization fixtures move to a machine-validated `schemas/` catalog,
while technology choices move to `adrs/`. The root architecture remains the sole
normative manifest and pins every normative module digest. Physical document
splitting occurs only with link, reference-closure, duplicate-authority, and
cross-module invariant checks; copying the same normative contract into several
files is forbidden.
