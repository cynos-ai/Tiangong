# Tiangong control architecture overview

> Status: non-normative executive summary of the accepted superseding target
> architecture; the contract specification remains under closure. Public v0.2
> is still the current implementation baseline. This summary does not authorize
> a delivery claim. The sole normative target source is
> [`evidence-backed-team-control.md`](evidence-backed-team-control.md).

## Positioning

Tiangong is an evidence-backed control architecture for an autonomous AI team:
a Leader decides what the Team should do, professional Agents decide how to do
their assigned work, and deterministic runtime boundaries enforce identity,
permission, authorization, evidence, completion, and recovery.

It **constrains rather than orchestrates**. There is no fixed delivery pipeline
and no general workflow DSL.

## Current and target boundary

The target supersedes the fixed five-role, four-TaskKind, TeamPlaybook path as
future architecture without pretending it is already implemented. The five
public v0.2 roles remain the first-party `software-change-delivery` profile, not
Kernel enumeration. Current WorkRun and AgentTeams Project/Task integration are
replaced only through vertically complete, fail-closed target slices.

AgentTeams owns actual Team/Worker/container lifecycle and platform storage
integration; OpenClaw owns Matrix mechanics. Tiangong owns professional
Work/Task/Result control, TeamDefinition admission, Capability, Context, Gate,
Evidence, Completion, Approval, quality, and recovery. Platform state proves a
resource exists; TeamDefinition determines whether its exact generation is
admitted. Platform files and messages are carriers or projections, never a
second semantic authority.

A deployment is single-tenant unless it proves end-to-end isolation across
identity, Matrix, storage, containers, network, credentials, Runner, knowledge,
model providers, and administration.

## Core philosophy

- **Two autonomous loops** — an Agent autonomously completes one Task; the
  Leader autonomously plans and adapts the Team's Work.
- **Unique authority, reentrant execution** — one Leader is the sole coordination
  authority, but isolated Leader turns and Tasks may progress across several
  Works within bounded capacity.
- **Concurrency is constrained machine state** — immutable Work ceilings,
  live Team capacity, fairness, leases, fencing, and run-scoped isolation bound
  execution without introducing a workflow graph.
- **Simple business plane** — users and the Leader reason about
  `Work -> Task -> Result`.
- **Single source of truth** — immutable records and exact digests replace
  mutable duplicated status.
- **Claim is not Evidence** — model prose, Artifacts, machine observations,
  Decisions, Approvals, and external effects remain separate facts. Evidence
  establishes only that an authorized Recorder recorded its defined bounded
  observation.
- **Meaning, legality, and strategy are separate** — a code-owned action says
  what a record means, a Guard decides whether it is legal, and the Leader
  decides why and when to choose it.
- **A Task never waits for a Human** — missing input or authorization produces a
  terminal blocked Result; the Leader interacts with the Human and creates a
  new Task.
- **Uncertainty is preserved** — an external effect with unknown outcome is not
  retried or described as success until privileged reconciliation proves it.
- **Knowledge authority is preserved** — exact source Artifacts and slices remain
  authoritative; indexes, vectors, rankings, retrieved prose, and model summaries
  are derived untrusted data.

## Concept layers

```mermaid
flowchart TB
    H[Human]

    subgraph Business[Business plane]
        W[Work]
        T[Task]
        R[Result / Claim]
        D[CoordinationDecision]
        W --> T --> R
        R --> D
    end

    subgraph Runtime[Runtime closure]
        RWP[ResolvedWorkPolicy]
        RUN[TaskRun]
        SCH[Team scheduler / leases]
        HI[HumanInteraction]
        HR[HumanResponse]
        RWP --> W
        SCH --> RUN
        T --> RUN
        HI --> HR
        HR --> D
    end

    subgraph Organization[Organization and shaping]
        TD[TeamDefinition]
        AD[AgentDefinition]
        CP[CapabilityPolicy]
        S[Skills]
        K[Source Artifacts / RetrievalBundles]
        C[Concerns]
        TD --> AD
        AD --> CP
        AD --> S
        K -. context .-> AD
        C -. guidance .-> AD
    end

    subgraph Trust[Trust foundation]
        A[Artifact]
        E[Evidence Ledger + Anchor]
        CC[Completion Check]
        R --> A
        R --> E
        A --> E
        E --> CC
        CC --> R
    end

    subgraph Quality[Quality and environment]
        SM[SystemMap]
        IA[ImpactAssessment]
        TP[TestPlan]
        TR[TestRun]
        QA[QualityAssessment]
        ED[EnvironmentDefinition]
        ES[Environment start/end snapshots]
        SM --> IA --> TP --> TR --> QA
        ED --> ES --> TR
    end

    subgraph Effects[External effects]
        O[Operation]
        AP[Exact Approval]
        G[Gate]
        J[Operation Journal / Recovery]
        O --> AP --> G --> J
    end

    H --> W
    H --> HI
    HR --> AP
    TD --> W
    RUN --> AD
    T --> O
    HI --> O
    A --> SM
    QA --> G
    J --> E
    J --> A
```

### Business plane

- **Work** is one evolving Human engagement, represented by immutable revisions.
- **Task** is one immutable delegation to one accountable Agent.
- **Result** is the Task's one immutable terminal handoff: completed, blocked,
  or failed.
- **CoordinationDecision** records acceptance, rejection, replacement,
  carry-forward, cancellation, closure, and explicit revocation.
- **Finding** is a lightweight structured field inside Result, not a separate
  aggregate.
- There is no universal Change object; code, configuration, documentation, and
  tests are Artifact kinds.

### Runtime closure

- **TaskRun** is the single immutable runtime binding for one dispatched Task;
  dynamic Context and tool facts remain Evidence or Artifacts. Every live Run
  isolates Session, Context, Workspace, tools, budget, cancellation, Completion,
  and recovery state.
- A valid undispatched **Task is the durable dispatch authority**. Scheduler
  capacity shortage creates no TaskRun or blocked Result; deterministic retry
  needs no DispatchIntent or Leader polling.
- Leader turns, scheduler queues, capacity, slots, leases, and fencing epochs are
  machine state and Evidence, not new business aggregates.
- **HumanInteraction** is an immutable Leader-to-Human contract with authoritative
  `inform`, `decide`, or `authorize` semantics. HumanResponse is a separate
  Artifact and never mutates the request.
- **ResolvedWorkPolicy** fully materializes Team defaults and legal Work
  overrides before Work execution; runtime never reads mutable current defaults.
- **Operation Journal** keeps append-only idempotency, attempt, replay, and
  reconciliation state separate from Evidence.

### Trust foundation

- **Artifact** identifies the exact delivered bytes and their provenance.
- **Evidence** records that an authorized Recorder made one bounded observation
  under an exact EventDefinition; it does not independently prove semantic truth
  or an external effect.
- **Completion** deterministically checks the minimum machine-provable Task
  contract. An effective Leader or Human-backed Decision is authoritative
  semantic disposition under exact policy, not proof of objective correctness.
- One logical Evidence Ledger per Work gives multi-Agent facts a common order.
  Signed Anchors protect critical frontiers from later rewrite relative to a
  trusted key; they do not make a compromised Recorder truthful.
- Human ingress and cross-Work capacity observations use namespace-scoped
  administrative ledgers with the same genesis, Recorder, anchoring, and
  fail-closed rules; Work events cite their exact EvidenceRefs.

### Quality and environment

- **SystemMap** links exact source snapshots to code, API, data, journey,
  deployment, test, and environment subjects while preserving known gaps.
- **ImpactAssessment** combines deterministic dependency propagation with
  explicitly source-backed semantic inference and unknown boundaries.
- **TestPlan** converts accepted impact into exact quality obligations, Core
  tests, selected tests, environments, and coverage gaps.
- **TestRun** binds exact TestDefinitions and subject Artifacts to configuration,
  data boundary, and both start and end EnvironmentSnapshots.
- **QualityAssessment** deterministically checks whether a semantically accepted
  TestPlan was executed with fresh passing evidence.
- **EnvironmentDefinition** is authority and policy; EnvironmentSnapshot is the
  point-in-time machine-observed state. Environment class does not prescribe a
  fixed release pipeline.

### External effects

- **Operation** is one exact external effect intent originating from a Task or
  formal HumanInteraction delivery.
- **Approval** authorizes one exact Operation. Human bounded grants and standing
  policy first derive an exact Approval; they never execute directly.
- **Gate** checks capability, policy, Approval, idempotency, recovery state, and
  immediate preconditions before execution.
- **Operation Journal** supplies exactly-once coordination and safe replay.
- An uncertain effect is reconciled outside model-accessible tools. External
  compensation is a new Operation, not a hidden rollback callback.

### Organization and behavior shaping

- **TeamDefinition** binds exactly one Leader and any number of approved
  professional members to exact Agent definitions. Multiple pre-bound exact
  Workers may share one AgentDefinition for horizontal capacity; roster changes
  require a new TeamDefinition and Work revision.
- **AgentDefinition** combines stable responsibility instructions, a hard
  CapabilityPolicy, and an allowed Skill catalog.
- **Skills** teach methods without changing profession or permission. Classic
  multi-Agent methods are Leader coordination Skills.
- **RAG** supplies exact provenance-bearing source slices through a
  policy-filtered RetrievalBundle bound to one TaskRun or fenced Leader turn.
  Physical indexes and embeddings are rebuildable caches; generated output is
  not reusable organizational knowledge without separate governed promotion.
- **Concerns** give Agent- or Team-scoped early guidance. They are advisory; any
  must-block rule belongs in Gate or Completion.

## End-to-end trust chain

```text
Human request
  -> human-request.received under exact platform or tenant IngressPolicy
  -> deny, or reserve workId and Work ledger
  -> atomically/outbox-equivalently commit Work + work.recorded + admitted Evidence
  -> replay returns that exact Work; execution saturation never discards it

Leader plans
  -> one fenced Work-scoped turn and Work-head CAS
  -> optional or required Leader-subject retrieval under exact Work policy
  -> immutable Task bound to Work, assignee, inputs, and resolved policies
  -> exact TeamDefinition and AgentDefinition
  -> scheduler intersects Work ceilings with live Team and Worker capacity
  -> dispatch atomically reserves slots and opens the Task's single TaskRun

Agent works autonomously
  -> exact TaskRun-subject knowledge policy and live revocation checks
  -> exact source snapshots + rebuildable search cache -> sealed RetrievalBundle
  -> selected Skills + delimited untrusted retrieval + Agent Concerns
  -> tools constrained by Capability and Task policy
  -> authorized Recorders capture bounded observations under exact definitions
  -> outputs become immutable Artifacts

Agent proposes Result
  -> deterministic Completion Check
  -> pass: seal Result + completion Evidence
  -> fail: continue inside Task
  -> external dependency: seal blocked Result and return to Leader

Leader reviews
  -> Completion Check pass is required
  -> semantic accept/reject is an immutable CoordinationDecision under policy
  -> Human input uses an immutable inform/decide/authorize interaction
  -> scope change creates a new Work revision, never mutation

Quality closes the delivery claim
  -> SystemMap binds current source and known system relationships
  -> ImpactAssessment identifies direct, transitive, inferred, and unknown impact
  -> TestPlan selects Core, impacted, regression, and risk-required obligations
  -> every TestRun binds exact subject, test, config, data, and start/end environment state
  -> QualityAssessment aggregates fresh runs without hiding failures or gaps

External effect, when required
  -> Prepare Task seals exact Operation and Proposal Artifact
  -> authorize HumanInteraction presents the exact effect
  -> authenticated HumanResponse or standing policy produces exact Approval
  -> new Execute Task invokes Gate
  -> Journal begins before backend call
  -> receipt, postcondition, Evidence, and Artifact establish the bounded outcome
  -> uncertain outcome blocks retry and enters privileged reconciliation

Work termination
  -> current-scope accepted Results and fresh anchored Evidence
  -> successful completion or cancellation has no live or uncertain effects
  -> failure may explicitly preserve recovery-required uncertainty
  -> immutable completion, failure, or cancellation Decision
  -> Human-facing report backed by accepted Artifacts and facts
```

## Six contract packages

| Package | Primary question | Core boundary |
| --- | --- | --- |
| Coordination core | How does the Team collaborate without a fixed workflow? | Work, Task, Result, CoordinationDecision; immutable scope and local Guards |
| Trust and completion | How can the Team prove what happened and what was produced? | Evidence, Anchor, Artifact, deterministic Completion and freshness |
| Effects and authorization | How can Agents safely touch real systems? | Operation, exact Approval, Gate, Journal, reconciliation and compensation |
| Organization and shaping | Who is an Agent, what may it do, and how is behavior guided? | TeamDefinition, AgentDefinition, Capability, TeamPolicy, Skills, RAG, Concern |
| Quality and environment | What does a credible test or promotion claim mean? | SystemMap, ImpactAssessment, TestPlan, exact TestRun environment binding, QualityAssessment |
| Runtime closure | How are immutable contracts composed and safely recovered at runtime? | TaskRun, HumanInteraction, ResolvedWorkPolicy, formal Operation Journal, bounded scheduling, leases and fencing |

The packages reference one another but do not collapse authority:

```text
Skills/RAG/Concern shape behavior
Capability/Gate constrain actions
Evidence captures facts
Completion certifies minimum facts
Leader/Human decides semantics
Approval authorizes exact effects
```

## Non-negotiable invariants

1. One Team has exactly one Leader; professional Agent definitions are
   extensible and not hard-coded to five roles.
2. Work, Task, Result, Decision, Artifact, Operation, Approval, TaskRun, and
   HumanInteraction are immutable.
3. Task has one assignee and at most one sealed Result; every dispatched Task
   has exactly one immutable TaskRun.
4. A Task never waits for Human input or authorization.
5. Actor and trusted time come from Evidence, not self-reported object fields.
6. Claim, Artifact, Evidence, Decision, Approval, and Operation are never used as
   substitutes for one another.
7. All authoritative references bind exact content digests.
8. Capability is deny-by-default and computed as an intersection; Prompt,
   Skills, RAG, and Concerns cannot expand it.
9. Completion Checkers are deterministic, side-effect-free, and model-free;
   indeterminate fails closed.
10. Result cannot receive new Evidence after sealing; expired proof requires a
    new verification Task.
11. Every external execution has an exact Approval for the exact Operation.
12. Approval-required never suspends a Task or Matrix turn.
13. Execution begins durably before the backend call and uses an
    Operation-centric idempotency key.
14. Started-without-terminal means outcome-uncertain and blocks automatic retry.
15. External compensation is another explicit Operation.
16. Evidence chains are validated and anchored; tampering is never silently
    repaired or truncated.
17. TestRun binds exact subject Artifact, TestDefinition, TestPlan,
    configuration, data boundary, and start and end EnvironmentSnapshots.
18. Cleanup failure keeps a TestRun red; retries create new Runs and never erase
    earlier failures.
19. Promotion uses the same immutable Artifact and a fresh satisfied
    QualityAssessment; a rebuild is a new Artifact requiring new proof.
20. Work binds a fully materialized ResolvedWorkPolicy; mutable current defaults
    never alter existing authority.
21. HumanInteraction and HumanResponse are separate; decide never substitutes
    for authorize.
22. Recovery reconstructs authority from immutable records, not model
    transcripts.
23. Human-facing claims never exceed accepted Results, available Artifacts, and
    verified Evidence.
24. Every independent admissible Human objective is durably captured as an
    independent Work even when execution is saturated.
25. One Work has at most one current fenced Leader-turn lease; lease ownership
    never replaces Work-head CAS.
26. A valid undispatched Task is the dispatch authority; capacity shortage
    creates no TaskRun and no separate DispatchIntent.
27. Immutable Work concurrency ceilings and live Team-global capacity are
    separate authorities; live state can narrow but never exceed Work policy.
28. Concurrent TaskRuns isolate all mutable runtime axes, and stale fencing
    epochs cannot append trusted output or reclaim current resources.
29. Shared mutable resources use isolated Workspaces, deterministic integration,
    leases, or Operation preconditions—never model cooperation or last writer
    wins.
30. KnowledgeSourceSnapshot, KnowledgeIndexManifest, and RetrievalBundle are
    typed Artifacts; physical indexes, embeddings, and rankings are rebuildable
    derived state.
31. Retrieval binds one exact TaskRun or current fenced Leader turn. It never
    introduces a LeaderRun, expands permission, or substitutes for direct access
    to current mutable Workspace state.
32. Agent or model output never becomes reusable organization knowledge without
    an exact administrative promotion Policy, review, and Evidence.
33. Context admits only exact authorized source slices under live revocation and
    deterministic authority-preserving packing; retrieved instructions remain
    untrusted data.
34. Required retrieval failure terminates the exact TaskRun or aborts the exact
    Leader turn; restart reuses the sealed Bundle and never substitutes latest
    retrieval as equivalent.
35. AgentTeams platform state and Tiangong TeamDefinition are complementary:
    actual resource existence never implies admission, and admission never
    manufactures platform existence.
36. Every command binds an exact CommandEnvelope and replay identity; hashed and
    signed JSON uses the fixed versioned JCS and digest contract.
37. Task MemberRef resolves an exact Worker and AgentDefinition through its Work
    TeamDefinition. All inputs are committed before Task creation; there is no
    pending scheduler dependency graph.
38. Decision revocation is action-specific, open-Work-only, reverse-dependency
    checked, and cannot reopen terminal Work or erase TaskRun, Human, Approval,
    Operation, Receipt, Artifact, or Evidence history.
39. Evidence and Anchors provide bounded Recorder and integrity assurance, not
    semantic truth; unknown Recorder, key, isolation, or effect state fails
    closed.
40. Typed knowledge payloads use their outer ArtifactRef as formal identity;
    inner logical index coordinates never create a second Artifact identity.

## Why this is not a workflow platform

| Workflow-centric design | Tiangong control design |
| --- | --- |
| Models work as a predefined graph of stages | Leader creates and adapts Tasks as facts emerge |
| Complexity accumulates in workflow DSL and transition state | Business plane stays `Work -> Task -> Result` |
| A process type decides what must happen next | Local Guards decide only whether a proposed action is legal |
| Templates become runtime authority | Leader Skills and RAG provide non-authoritative methods |
| Flexibility requires adding branches and loops to the engine | New immutable Tasks naturally express parallelism and revision |
| Parallelism requires a workflow scheduler | Eligible Tasks, bounded slots, fairness, leases, and local Guards provide scheduling without business-flow authority |
| Completion is often a stage transition | Completion cross-checks Claims against machine facts |
| Authorization is attached to a stage | Approval binds one exact external Operation |
| Recovery guesses where the flow stopped | Immutable records, Evidence, and Journal reconstruct known state |

Tiangong does have substantial trust infrastructure, because safely allowing AI
to modify real systems requires evidence capture, immutable Artifacts, exact
authorization, idempotency, and uncertainty recovery. These are logical
persistence responsibilities, not necessarily separate physical databases. The
physical storage topology is an implementation decision that must preserve the
contracts above.
