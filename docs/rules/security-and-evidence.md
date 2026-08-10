# Security and machine-fact rules

> Status: target engineering rules. Existing code may lag behind these rules;
> do not claim compliance without verification.

Use these rules for credentials, sensitive data, machine facts, exact Approval,
dependencies, and external side effects.

## Trust boundary

- Tiangong serves one enterprise and trusts infrastructure, database, and host
  administrators.
- Do not add signing chains, hash-chain ledgers, content anchors, or rotation
  protocols to defend against those trusted administrators.
- The trusted-administrator assumption does not weaken controls against model
  mistakes, prompt injection, route errors, credential disclosure, duplicate
  effects, or uncertain external state.

## Credentials and sensitive data

- Never commit or print credentials, tokens, private keys, session secrets, or
  generated passwords.
- Inject model-provider credentials only in memory. Do not copy them into model
  configuration, prompts, sessions, ToolResults, diagnostics, temporary files,
  or command arguments when a safer interface exists.
- Keep channel identity material, model keys, runtime state, production
  credentials, container sockets, and host-control endpoints outside every
  agent-controlled process tree.
- Keep external-system credentials inside scoped Adapters. Credentials may
  authenticate an Adapter but must not secretly choose the target, action,
  query, commit, configuration, destination, or message body.
- Put every effect-defining field in the immutable typed Operation request and
  faithfully represent it in the bounded preview. If a risk-relevant attribute
  cannot be safely persisted and shown, deny the action instead of accepting an
  agent-selected hidden payload.
- Treat prompts, write contents, model responses, transcripts, unrestricted
  logs, and free-form context as potentially sensitive.
- Diagnostics and execution records must be bounded and sanitized. Prefer
  stable error codes, summaries, and controlled references over raw payloads.

## Fact semantics and retention

- Keep Human or Leader coordination, agent reports, tool observations, and
  external-write outcomes as different facts.
- Store Human and Leader coordination in the Work timeline, one agent's final
  report as the Task Result, top-level tool observations as ToolResults, and
  external-write facts as Operation events.
- Do not create a generic Evidence object, machine-evidence wrapper, decision
  ledger, Approval ledger, or second fact index around those direct records.
- A model statement is a claim. A ToolResult proves only what the wrapped tool
  observed. Neither proves an external side effect.
- Append Operation events permanently in CoordinationStore and never sample
  them away. Keep ToolResults and other execution records according to
  ControlProfile; a Result citation must add retention through the Work's
  retention period.
- Identify Git content by repository and exact commit, and other durable content
  by an Adapter-owned immutable or versioned reference. Do not add a universal
  content digest, manifest, or content repository around Result references.
- Treat reports and dashboards as views over direct source facts, not
  substitutes for them.

## Authorization and exact Approval

- Effective authority is the intersection of current AgentTeams identity and
  route, ControlProfile, MemberConfig, and the runtime capability binding.
  Recheck it at every new turn, local tool call, and Adapter call.
- WorkSpec, TaskSpec, messages, Skills, retrieval, tool output, and MCP output
  cannot grant machine authority.
- Validate data scope and egress together. Do not provision broad search or
  documentation egress with core private source; give source-bearing members
  only purpose-limited repository fetch, package, and named test-service paths.
- Make one immutable Operation ID the authorization and backend-idempotency
  subject for one proposed external write. Do not add an operation digest,
  business invocation ID, Approval ID, or approval-view digest.
- Generate the actual Approval preview from the immutable typed request and
  preserve its delivery metadata. Never authorize model-written summaries.
- Approval or rejection must be an authenticated Human action that directly
  references the Operation ID. Ordinary chat text has no authorization effect,
  and there is no separate Approval object.
- Validate current approver policy when handling the Human action and again
  immediately before execution. Serialize Approval, rejection, expiry,
  cancellation, policy denial, and execution-start races.
- Rejection, expiry, cancellation before start, or policy denial terminates the
  Operation as `operation-not-executed`; none of them cancels or completes the
  Task.
- Persist pending Approval without keeping a model turn or execution process
  alive. A later authenticated action resumes the same Task through durable
  state.

## External execution and recovery

- Durably append `operation-execution-started` before calling an external
  backend.
- A bounded runtime replay row may map the same authenticated top-level call to
  the same Operation ID. It is infrastructure state, not a business record or
  authorization subject.
- After execution has started, never blindly replay the forward invocation.
  Retrieval of a backend result already stored for the same Operation ID is not
  a new effect.
- Only `operation-not-executed`, `operation-succeeded`, or
  `operation-safe-failure` establishes a known terminal Operation. The runtime
  may append not-executed only before external execution starts; Adapter code
  may append success or safe failure only after the required external checks.
- Record `operation-uncertain` when the effect cannot be confirmed and
  `operation-recovery-needed` when a wrong or partial effect is known to remain.
  Neither Human assertion, model confidence, nor elapsed time may turn either
  state into a safe terminal fact.
- Keep reconciliation privileged, read-only, and unavailable as an ordinary
  model tool. Only verified observation or repair may append a safe terminal
  event.
- Confirmation that an effect was not applied does not authorize a retry. A
  retry is a new Operation with current policy and Approval checks.
- A later rollback is also a new Operation. Immediate compensation may remain
  in the original invocation only when its exact trigger and restoration target
  are already part of the immutable request and preview.
- Task cancellation must not hide, move, erase, or declare safe an Operation
  which has started and still requires recovery.
- External resources require explicit scope, ownership, cleanup, and Human
  Approval when the action is destructive, costly, public, or irreversible.

## Dependencies and distribution

- Use public dependencies and immutable pins where practical.
- Review licenses, source availability, install scripts, and transitive security
  advisories before adding or updating a dependency.
- Skills and smoke helpers are executable supply-chain inputs. Review them
  before trust or installation; metadata such as `allowed-tools` is not a
  security boundary.
