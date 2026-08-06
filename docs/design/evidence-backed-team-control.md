# Evidence-backed team control architecture

> Status: draft. This document records agreed target contracts. It does not
> describe the current implementation and does not authorize a delivery claim.
>
> Scope: the complete target control contracts for coordination, trust and
> completion, external effects and authorization, organization and behavior
> shaping, quality and environment, and runtime closure. Platform-specific
> adapters and physical implementation topology remain implementation work.

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

### 2.5 Claim is not Evidence

The following are separate facts:

- model or Human claims;
- Artifact payloads;
- machine state;
- machine-captured Evidence;
- semantic acceptance;
- authorization.

A Result is a claim and a handoff. Evidence can prove actions and observations,
but it does not make the Result semantically correct. Completion Check is a
necessary condition; Leader or Human acceptance is the sufficient semantic
condition.

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
proves observations and execution. Operation is reserved for external side
effects and does not represent every read, write, or test tool call.

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

An Evidence event proves who recorded the Decision and when; it does not replace
the Decision's semantics.

## 4. Common record discipline

All coordination records:

- use canonical JSON;
- have a versioned `schema`;
- are immutable after sealing;
- compute `contentDigest` over every field except `contentDigest` itself;
- reject unknown fields;
- contain no generic metadata or extension bag;
- omit self-reported actor and time;
- use exact references containing identity and content digest;
- reject bare IDs and dangling references.

Record authenticity and trusted time come from the Evidence ledger.

## 5. Work contract

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
| `teamRef` | Pins the accountable Team and roster authority. |
| `specRef` | Pins the objective, scope, acceptance criteria, and Human constraints. |
| `policyRef` | Pins resolved budget, quality, reporting, and approval policy. |
| `contentDigest` | Lets Tasks and Decisions bind an exact Work revision. |

Work excludes mutable status, current flags, inline scope copies, requester,
timestamps, role bindings, progress, arbitrary metadata, and a direct
supersession field. Revision relationships are CoordinationDecisions.

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
    "workerId": "worker-7",
    "agentDefinitionDigest": "sha256"
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
| `assigneeRef` | Establishes one accountable Worker and Agent definition. |
| `specRef` | Pins the Task objective, expected outcomes, and semantic constraints. |
| `inputRefs` | Pins the immutable baseline and dependency set. |
| `executionPolicyRef` | Pins tool, environment, budget, and effect constraints. |
| `completionPolicyRef` | Pins the minimum machine-provable completion contract. |
| `contentDigest` | Lets Result bind the exact delegation. |

Task excludes TaskKind, mutable status or phase, Task revision, supersession,
duplicate dependency fields, inline semantic specification, Skill selection,
environment and budget copies, Result references, Operation and Approval
references, actor and time, parent Task, and attempt count.

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
copies, Skill references, acceptance policy, Checkpoint result, acceptance
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
5. Inputs must be committed before Task creation.
6. New Task dependencies point only to earlier immutable records.
7. New Tasks bind the current Work revision.
8. An undispatched old-revision Task cannot be dispatched.
9. A running old-revision Task may finish, but its Result is not automatically
   eligible under the new Work revision.
10. Task supersession targets only the current supersession leaf and cannot
    fork or cycle.

### 9.4 Result and acceptance

1. Every outcome passes its applicable CompletionPolicy before sealing.
2. A failed Completion candidate is not a Result.
3. `blocked` and `failed` cannot be accepted as completion.
4. Checkpoint pass is necessary; Leader or Human semantic acceptance is
   sufficient.
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

## 11. Coordination commands and Guards

| Command | Deterministic Guard | Atomic output |
| --- | --- | --- |
| `create_work` | Authenticated authority; new workId; revision 1; valid Team and Spec; ResolvedWorkPolicy source matches TeamPolicy and Kernel | Work + recording Evidence |
| `revise_work` | Source is current head; target is same workId and revision +1; no fork; no executing or uncertain Operation; Team and ResolvedWorkPolicy provenance coherent; changes authorized | target Work + revise Decision + Evidence |
| `create_task` | Current open Work; valid Team member and Agent definition; valid inputs; Task policies derive from ResolvedWorkPolicy and do not expand permission | Task + Evidence |
| `dispatch_task` | Not dispatched, cancelled, superseded, or completed; current Work revision; dependencies accepted; budget available | dispatch Evidence + TaskRun start |
| `submit_result` | Authenticated assignee or trusted framework; exact TaskRef; no prior Result; valid refs; applicable CompletionPolicy passes | Result + Completion/recording Evidence |
| `accept_result` | Completed Result; Checkpoint valid; no conflicting disposition; current scope or valid carry-forward | accept Decision + Evidence |
| `reject_result` | Existing Result; no conflicting disposition; bounded rationale and basis | reject Decision + Evidence |
| `supersede_task` | Source is an unsuperseded non-running leaf with no effective acceptance; replacement is a new valid current-revision Task; no cycle or branch | replacement Task + supersede Decision + Evidence |
| `carry_forward_result` | Source Result accepted in source Work; source is ancestor of current target; Evidence remains fresh | carry-forward Decision + Evidence |
| `cancel_task` | Task is undispatched and has no Result or prior cancellation/supersession | cancel Decision + Evidence |
| `complete_work` | Current head; closure policy passes; required Results accepted; required QualityAssessment is fresh and satisfied; no required Human response, running Task, pending effect, or unresolved uncertainty | complete Decision + Evidence |
| `fail_work` | Current head; safe continuation exhausted; effects resolved or explicitly uncertain; failure Evidence complete | fail Decision + Evidence |
| `cancel_work` | Authorized cancellation; Tasks and effects safely terminated; Human decision when required | cancel Decision + Evidence |
| `revoke_decision` | Target Decision effective and revocable; authorized actor; no unhandled irreversible dependency | revoke Decision + Evidence |

A dispatched Task is not cancelled by a coordination flag. If execution must be
stopped, the runtime terminates the TaskRun, preserves Evidence, resolves or
marks external effects uncertain, and seals a failed Result.

## 12. Completion exit

```text
completed candidate
  -> Checkpoint pass -> sealed Result
  -> Checkpoint fail
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

## 13. Required Evidence semantics

Package 1 requires these event meanings. Package 2 supplies the common Evidence
envelope, and each owning package supplies the strict event-specific facts
schema and Recorder authority:

| Event | Required binding |
| --- | --- |
| `work.recorded` | Work digest, authenticated actor, command identity |
| `task.recorded` | Task digest, WorkRef, Leader actor |
| `task.dispatched` | TaskRef, assignee, TaskRunRef |
| `completion.checked` | TaskRef, candidate digest, policy digest, checker outcomes |
| `result.recorded` | Result digest, TaskRef, authenticated submitter |
| `decision.recorded` | Decision digest, action, authenticated actor |
| `coordination.command.denied` | command identity, subject digests, stable reason code |
| `task-run.budget-exhausted` | TaskRef, TaskRunRef, execution policy |
| `task-run.terminated` | TaskRef, TaskRunRef, known failure or uncertain effect outcome |

Recording Evidence is not included in the recorded object's own references;
that would form a digest cycle. Trust is verified through the Evidence ledger's
reverse binding to the object digest.

## 14. Recovery and concurrency

Recovery validates schemas, object digests, exact references, and Evidence
before projecting state. It reconstructs Work heads, Task relationships,
Results, dispositions, carry-forward, revocation, and terminal decisions from
immutable records. Forks, cycles, missing references, conflicting Results, and
invalid Evidence fail closed. Model transcripts are not authority.

Concurrency uses compare-and-swap and narrow locks:

- Work revision compares the expected current head digest;
- Result submission serializes per Task;
- supersession compares the expected source leaf;
- conflicting dispositions serialize per Result;
- carry-forward rechecks the target head at commit;
- Work completion rechecks all closure facts at commit.

Same-digest replay succeeds. Same identity with different content is a
conflict. Last-write-wins is forbidden.

Multi-record commands use a transaction or write-ahead intent plus Evidence
outbox and commit marker. Uncommitted records are invisible to Projection.

Parallel Tasks share immutable input digests. Conflicting outputs are preserved
and reconciled by a new integration Task rather than overwriting either output.

## 15. Coordination truth table

| Scenario | Decision |
| --- | --- |
| Create revision 1 with valid Team, Spec, and Policy refs | allow |
| Create a second revision 1 for the same workId | deny |
| Revise the current head to revision +1 | allow |
| Revise a non-head Work revision | deny |
| Create a Task for the current Work revision | allow |
| Create or dispatch a Task for an old Work revision | deny |
| Dispatch a cancelled or superseded Task | deny |
| Let an already-running old-revision Task finish | allow Result sealing; mark not currently eligible |
| Submit Result by the exact assignee with passing Checkpoint | allow |
| Submit Result by another Agent | deny |
| Completion candidate fails | do not seal; continue the Task |
| External information is truly missing and blocked policy passes | seal blocked Result |
| Execution budget expires without a valid candidate | seal framework-produced failed Result |
| Replay identical Result for one Task | replay success |
| Submit a different second Result for one Task | conflict |
| Accept completed, current-scope, Checkpoint-valid Result | allow |
| Accept blocked, failed, or Checkpoint-invalid Result | deny |
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
| Revoke an eligible acceptance with no unsafe dependency | allow as a new Decision |
| Modify the original acceptance | deny |
| Revoke a revoke or erase an irreversible effect | deny |
| Concurrent Work revisions | one commit, one stale-head conflict |
| Concurrent different Results for one Task | one commit, one conflict |
| Recovery finds a fork, cycle, digest mismatch, or missing ref | fail closed |

## 16. Package 2: trust and completion

Package 2 defines three orthogonal mechanisms:

- Artifact identifies what immutable content was produced;
- Evidence records what a trusted machine boundary observed;
- Completion checks whether those facts satisfy the minimum machine-provable
  contract for one Task outcome.

Artifact provenance does not prove semantic correctness. Evidence does not prove
an arbitrary claim merely because it was recorded. Completion is necessary for
Result sealing; Leader or Human acceptance remains the sufficient semantic
condition.

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
| `eventType` | Selects the authoritative fact meaning, facts schema, and allowed Recorders. |
| `recorderRef` | Identifies the trusted machine boundary that observed the fact. |
| `actorRef` | Identifies the authenticated actor or system that caused the action. |
| `subjects` | Binds the fact to exact registered records or Artifacts, including Work, Task, Result, TaskRun, Human interaction, and Operation. |
| `facts` | Carries bounded, event-specific machine observations. |
| `recordedAt` | Supplies trusted ledger time for audit and explicit temporal freshness. |
| `previousHash` | Binds the event to the preceding chain position. |
| `hash` | Protects the event content and gives EvidenceRef its integrity identity. |

`eventType` is an authoritative semantic discriminator. Each type has a strict
facts schema, required subject roles, Recorder allowlist, event-key derivation,
sensitive-data policy, and size bound. `facts` is not a free-form payload.

`actorRef` answers who caused an action. `recorderRef` answers which trusted
boundary observed it. The Agent may influence tool input but cannot choose its
authenticated actor, Recorder, sequence, time, predecessor, or hash.

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

Administrative Catalog, schema, authority, revocation, and security facts use
separate namespace-scoped administrative ledgers with the same envelope,
anchoring, Recorder, and fail-closed rules. They do not merge unrelated Work
orders into a false global sequence. A Work ledger records exact adoption and
use of external Catalog facts, while live security revocation is also checked at
dispatch, context, tool, Gate, and recovery boundaries.

The first event uses a ledger-specific genesis value:

```text
genesisHash = SHA-256(canonicalJson({
  schema: "tiangong.evidence-ledger/v1",
  ledgerId
}))
```

Each event hash is:

```text
hash = SHA-256(canonicalJson(eventWithoutHash))
```

Append validates the current terminal, next sequence, previous hash, event key,
event and facts schemas, Recorder authority, subjects, and sensitive-data rules
before atomically appending and syncing the record.

A hash chain is only tamper-evident relative to a trusted terminal hash. Package
2 therefore requires signed Evidence Anchors held outside model write authority.
An Anchor binds a contiguous sequence range, previous Anchor, terminal event
hash, segment digest, Recorder implementation, and signature. Rotation preserves
sequence and terminal-hash continuity. Evidence is not automatically deleted.

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
    future verification impossible and therefore requires an explicit retained
    decision; it is never silent.
11. Rejection or Work cancellation does not automatically delete an Artifact.
12. AI-produced content may be an Artifact, but remains a claim-bearing output.

ArtifactSchema and HandlingPolicy are referenced, immutable, content-addressed
packages. ArtifactSchema supplies deterministic payload validation and never
runs arbitrary model or tool code. HandlingPolicy governs classification and
lifecycle without changing Artifact identity or provenance.

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
command, and resource deletion. Reading, searching, isolated workspace edits,
builds, tests, internal Artifact persistence, Evidence append, and read-only
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
| `spec` | Binds exact target, inputs, preconditions, and desired effect. |
| `effectPolicyRef` | Pins authorization, risk, idempotency, verification, retry, compensation, and recovery rules. |
| `contentDigest` | Lets Approval and Journal bind the exact Operation. |

`spec.schema` is an authoritative, code-owned Operation type with a strict
schema and Adapter allowlist. It never contains an arbitrary shell command.
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

A Prepare Task seals the Operation and produces an OperationProposal Artifact.
The Proposal contains the OperationRef, safe target and effect summary, exact
Artifact, configuration and environment digests, risk and cost, preconditions,
verification plan, failure impact, and compensation or recovery plan.

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
idempotencyKey = SHA-256(canonicalJson({
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
The Receipt semantically binds Operation, Approval, Adapter, idempotency-key
digest, backend receipt, observed terminal outcome, verified postcondition,
target and environment, and any compensation Operation.

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
| `teamId` | Supplies stable Team and platform mapping identity. |
| `leaderMemberId` | Identifies exactly one Leader without inferring a role name. |
| `members` | Binds each Worker identity to an exact AgentDefinition. |
| `teamPolicyRef` | Pins Team defaults and configurable policy boundaries. |
| `contentDigest` | Lets Work bind the exact roster snapshot. |

A Team has exactly one Leader and any number of approved professional members.
Member and Worker identities are unique. The Leader definition must include
coordination capability. The Kernel has no fixed Designer, Implementor,
Assessor, or Operator enumeration.

TeamDefinition is immutable. Roster or TeamPolicy change produces a new digest.
An existing Work adopts it only through a new Work revision. Old Task bindings
remain historical facts. Security revocation can prevent dispatch or execution
without rewriting the old TeamDefinition.

TeamDefinition excludes mutable presence or health, Work and Task references,
actor and time, platform container or Matrix details, permission content, Skill
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

Code owns a finite slot catalog, including task control, resource budget,
quality baseline, effect authorization, environment access, knowledge access,
Concern selection, Human interaction, reporting, and retention. Each slot has
at most one resolved PolicyRef and a strict schema with defaults and bounded
override ranges. This is policy composition, not a workflow or expression DSL.

Work creation resolves Team defaults plus allowed Work overrides into an
immutable ResolvedWorkPolicy referenced by Work.policyRef. Omitted values are
materialized before hashing. Overrides cannot breach Kernel floors. TeamPolicy
updates do not retroactively change a Work; adoption requires a Work revision.

TeamPolicy excludes stages, fixed role lists, Agent tool grants, Skill content,
knowledge content, Concern evaluator code, arbitrary rule DSL, Prompt snippets,
mutable overrides, metadata, and extensions.

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

## 47. Retrieved knowledge

Knowledge sources first exist as provenance-bearing Artifacts, including a fixed
repository snapshot, architecture and interface documents, System Map,
requirements, tests, Results and Findings, incidents, runbooks, and organization
rules. Search index and embeddings are rebuildable caches, not authority.

A RetrievalBundle Artifact records query digest, index snapshot digest,
knowledge-policy digest, and exact source slices with Artifact and slice digests.
`knowledge.retrieved` Evidence binds Task, Agent, query, sources, policy, and
Bundle. Rich query text follows handling policy and need not enter Evidence.

Retrieved content is untrusted data, never system instruction. It cannot override
Kernel, CapabilityPolicy, Task, Gate, or Skill. Handling policy is checked before
retrieval and again before model context. A Bundle without exact provenance is
not admitted. Source changes make old slices structurally stale. Model synthesis
of retrieved material is a Claim or Artifact, not Evidence.

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

Each Agent turn assembles exact references in authority order:

```text
Control Kernel and tool schemas
Agent Capability boundary
Agent responsibility instructions
Work and Task contracts
selected Skills
current ConcernViews
retrieved Knowledge Bundles
conversation and Task-local prose
```

Lower layers cannot change higher-layer authority. Prompt marks Skills as
method, Concern as advice, and RAG as untrusted data. Framework emits
`agent.context.assembled` with AgentDefinition, Task, selected Skill,
RetrievalBundle, Concern snapshot, model/runtime, and system-prompt digests. It
does not copy the full sensitive Prompt into Evidence.

Leader is the unique Team member with coordination capability and relevant
coordination Skills and Team Concern view. It decides semantic next actions and
Human communication, but cannot bypass Gate, Completion, Approval, Catalog, or
Capability boundaries.

## 50. Package 4 commands and Guards

| Command | Deterministic Guard |
| --- | --- |
| `register_agent_definition` | Administrative/code-owned entry; valid responsibility, Capability, Skill and supply-chain refs; no hidden permission or private dependency. |
| `register_team_definition` | Valid Worker identities; unique members and Worker bindings; exactly one coordination-capable Leader; valid TeamPolicy. |
| `register_team_policy` | Valid Kernel; unique known slots; strict module schemas; no Kernel weakening. |
| `resolve_work_policy` | Materialize defaults; permit only bounded overrides; emit immutable resolved policy. |
| `create_task` | Extend Package 1: assignee belongs to exact Work Team; definition is not revoked; Task policy is a capability subset. |
| `assemble_agent_context` | Exact Agent and Task; only allowed Skills; authorized knowledge and handling; bounded Concern snapshot. |
| `load_skill` | Skill in AgentDefinition allowlist, not revoked, capability compatible, and resources valid. |
| `retrieve_knowledge` | Authorized sources and classification; valid snapshot and source refs; bounded query and output. |
| `evaluate_concerns` | Valid definition and implementation; matching scope; read-only facts; no side effect. |
| `update_team_roster` | Create new TeamDefinition; never mutate old; current Work adopts through revision. |
| `revoke_agent_or_skill` | Administrative authority and recorded revocation; prevent new use; safely terminate affected high-risk execution. |

## 51. Package 4 Evidence, recovery, and concurrency

Required events include definition, policy, Team, Skill, retrieval, context, and
Concern recording, loading, revocation, and presentation. Events carry exact
digests rather than full sensitive instructions, RAG content, or Prompt.
Skill-loaded does not prove method compliance; knowledge-retrieved does not prove
truth; Concern-presented does not prove drift.

Catalog records are immutable, content addressed, reviewed, public-dependency
safe, and revocable by new administrative facts. A new version does not revoke
an old version. Security revocation blocks new dispatch, Skill load, tool use, or
Operation and terminates affected running work according to policy without
rewriting history.

Recovery validates Catalog and revocation state, TeamDefinition and unique
Leader, Work team binding, Task assignee AgentDefinition digest, TaskRun
binding, Context Evidence Skill digests, RetrievalBundles, and context
snapshots. ConcernViews are
recomputed. Runtime never guesses loaded Skills or knowledge from transcript.
Missing exact context packages cause exact recovery or Task termination; they
are not silently replaced by latest versions.

Catalog updates use CAS. Work keeps exact Team digest. Concurrent identical
Skill loads replay. RAG indices rebuild concurrently but Bundles bind one
snapshot. Concern evaluators are pure and repeatable. Security revocation is
linearized against dispatch and tool invocation.

## 52. Package 4 truth table

| Scenario | Decision |
| --- | --- |
| Team has one Leader and arbitrary approved professionals | allow |
| Team has no Leader or multiple Leaders | deny |
| Define a new security, data, or testing Agent | allow through approved AgentDefinition |
| Core requires the original five role names | reject target design |
| One Worker is bound to two members in one Team | deny |
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
| RetrievalBundle has exact source, slice, index, and policy digests | allow context injection |
| Retrieval result lacks source provenance | deny formal Bundle |
| Retrieved content contains instruction injection | treat as untrusted data |
| Agent lacks source classification access | deny retrieval |
| Model summary of RAG content | Claim or Artifact, not Evidence |
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
Task has exactly one TaskRun. Process restart may resume that same Run only when
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
- authenticated Worker must match Task assignee and AgentDefinition digest;
- Runtime and Workspace must satisfy Task ExecutionPolicy;
- TaskRun never waits for Human input;
- TaskRun has no business phase;
- each Context Assembly records exact digests;
- Skill, RAG, Concern, or model changes do not mutate TaskRun;
- execution budget is resolved from Task policy;
- budget exhaustion seals a framework failed Result;
- terminal authority comes from Result and Evidence, not a Run status;
- recovery uses Task, Artifact, Evidence, Journal, and exact Context refs;
- missing or revoked required material fails rather than silently changing the
  execution identity;
- external-effect uncertainty is reconciled before Task terminal handling;
- replacement creates a new Task, not another Run for the old Task.

Each model turn has a logical Context Snapshot binding TaskRun,
AgentDefinition, Responsibility, selected Skills, Work and Task, RetrievalBundles,
Concern snapshot, resolved policy digests, actual model/runtime, system Prompt
digest, and optional protected conversation-summary Artifact. The
`agent.context.assembled` Evidence event records these references and digests.
A conversation summary is a Claim Artifact under HandlingPolicy; hidden model
reasoning is neither required nor stored.

On restart the runtime reads Task and TaskRun, resolves exact AgentDefinition,
Skills and RetrievalBundles, recomputes current Concern, and builds a
machine-fact RecoveryContext from Artifact and Evidence. It continues the same
Run only when all required bindings verify and no tool or Operation uncertainty
is unresolved.

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
default. Slots include task control, execution budget, completion, capability,
quality, effect, environment, knowledge, Concern, Human interaction, reporting,
retention, and any other Kernel-mandated policy. Slot names and resolution rules
are code-owned.

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
- Operation EffectPolicy is selected from the resolved effect module;
- TestPlan QualityPolicy and allowed environments are selected from the
  resolved quality and environment modules;
- Human audience, interaction, reporting, and authorization policy come from
  the resolved Human and effect modules;
- Handling, knowledge, retention, and Concern policy use the corresponding
  resolved slots.

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
`SHA-256(canonicalJson(JournalBinding))` as its genesis previous hash, and every
event hash is computed over the canonical event without `hash`.

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

Agent runtime composition is:

```text
dispatch Task
-> open TaskRun
-> assemble exact context
-> autonomous model turn
-> tool Guard, Evidence, and Artifact capture
-> recompute Agent Concern
-> Result candidate
-> deterministic Completion Check
   -> continue within Task, or seal completed/blocked/failed Result
-> terminate TaskRun
```

Leader composition is:

```text
read Work projection, accepted Results, Team Concerns, policy, and budget
-> choose semantic coordination action
-> create or supersede Tasks, accept or reject Results
-> create HumanInteraction when needed
-> create Work revision for scope change
-> terminate Work when the objective is resolved
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
do not prescribe the Leader's professional strategy.

## 79. Runtime closure commands and Guards

| Command | Deterministic Guard |
| --- | --- |
| `open_task_run` | Task dispatched; no Run or Result; exact Runtime and Workspace; Worker matches assignee. |
| `assemble_context` | Valid TaskRun; valid AgentDefinition, Skills, RAG, Concern, and Policy refs; HandlingPolicy permits material. |
| `resume_task_run` | Exact Run; no terminal Result; Context reconstructible; no unresolved effect uncertainty; budget permits. |
| `terminate_task_run` | Result sealed or framework failed Result sealed; no hidden active execution. |
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

Required events include `task-run.opened`, `task-run.resumed`,
`task-run.budget-exhausted`, `task-run.terminated`,
`agent.context.assembled`, `human-interaction.recorded`,
`human-interaction.delivered`, `human-response.captured`,
`human-response.consumed`, `human-response.rejected`,
`work-policy.resolved`, `operation-journal.opened`,
`operation-payload.released`, and `operation-journal.compacted`. Package 3
`operation.execution.*`, `operation.reconciliation.*`, and
`operation.receipt.recorded` Evidence additionally binds Journal sequence and
attempt identity; Runtime Closure does not create duplicate execution event
meanings.

TaskRun events bind exact Task. Context events contain references and digests,
not copied secrets. Human delivery binds exact Presentation; response Evidence
binds authenticated Human; consumption binds the resulting Decision, Work
revision, or Approval. Journal and Evidence outbox recover without exposing
protected payload, credential, hidden reasoning, or raw sensitive Prompt.

## 81. Runtime closure recovery and concurrency

TaskRun opening uses Task CAS. Same binding replays; another binding conflicts.
Result sealing and Run termination are coordinated. Exact recoverable Run uses
the same runId. Missing context, revoked authority, unreconciled tool outcome, or
exhausted budget seals failed Result rather than creating another Run.

Outstanding Human interactions are projected from delivery and response
Evidence. Captured unconsumed responses are deterministically consumed. Same
response replays; conflicting or expired response cannot overwrite authority.
A Work revision revalidates outstanding interaction applicability.

ResolvedWorkPolicy resolution is deterministic and content-addressed. Concurrent
identical resolution deduplicates. TeamPolicy update does not affect resolved
Work. Work revision CAS determines adoption.

Operation Journal uses per-Operation CAS or serialization. Approval revocation
and attempt start share a linearization boundary. Only one attempt is active;
replay never invokes backend. Journal compaction serializes with read and
reconciliation. Restore from backup respects terminal tombstones and never
resurrects protected payload or completed effects.

## 82. Runtime closure truth table

| Scenario | Decision |
| --- | --- |
| Undispatched Task opens Run | deny |
| Dispatched Task opens first exact Run | allow |
| Same Task and Run binding replay | idempotent |
| Same Task opens a different Run | conflict |
| Worker differs from assignee | deny |
| Workspace baseline differs from Task input | deny |
| TaskRun waits for Human | deny; seal blocked Result |
| Exact Context is reconstructible | resume same Run |
| Recovery needs transcript guess | deny recovery |
| Required Skill, Artifact, or authority is revoked | fail Run and Task |
| Budget exhausted | framework failed Result |
| Tool call follows terminal Result | deny |
| Leader sends progress or file delivery | inform |
| Human reviews scope, design, tests, or acceptance | decide |
| Human grants external effect permission | authorize |
| Decide response is used as Operation authorization | deny |
| Presentation and proposed Operation differ | deny Approval |
| No trusted Evidence proves exact Presentation delivery | deny response authority |
| Respondent fails AudiencePolicy | deny |
| Same HumanResponse replays | idempotent |
| Consumed single response receives a conflict | do not overwrite; create new interaction |
| Quiet mode faces authorize or recovery exception | still notify |
| Same progress projection repeats | suppress |
| Resolved policy fully materializes legal inputs | allow |
| Runtime reads mutable current defaults | deny |
| Override weakens Kernel | deny |
| TeamPolicy updates | old Work unchanged |
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
Every exact reference belongs to one of four closed families:

- a domain RecordRef containing its stable identity fields and content digest;
- an ArtifactRef containing artifact ID and Manifest digest;
- a PolicyRef containing policy ID, version, and content digest;
- an ImplementationRef containing implementation identity, version where
  applicable, and implementation digest.

EvidenceRef is the defined ledger, sequence, and hash tuple. Authenticated
principal references are resolved by the platform identity boundary and are not
model-authored content references.

Policy packages include TaskExecutionPolicy, closure, effect, environment,
quality, handling, knowledge, Human-interaction, reporting, retention, and the
other finite TeamPolicy slots. Implementation packages include Kernel,
Checker, Adapter, Recorder, Concern evaluator, SystemMap extractor, Runtime,
and schema validators. Each package has an immutable reviewed catalog entry, a
strict code-owned schema, public supply-chain provenance, and revocation facts.
It cannot contain a Prompt-controlled permission expression or generic rule bag.

ArtifactSchema, event facts schema, Operation spec schema, response contract,
and environment state schema are validator packages, not extra authoritative
records. Human audience and approval-role definitions are authority-policy
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
