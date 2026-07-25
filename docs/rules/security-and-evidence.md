# Security and Evidence rules

Use these rules for credentials, logs, Evidence, approvals, dependencies, and external side effects.

## Credentials and sensitive data

- Never commit or print credentials, tokens, private keys, session secrets, or generated passwords.
- Inject provider credentials only in memory. Do not copy them into model configuration, prompts, sessions, Evidence, diagnostics, temporary files, or command arguments when a safer interface exists.
- Copy only explicitly allowlisted non-secret provider fields across the OpenClaw/Tiangong boundary.
- Treat raw prompts, write contents, model responses, session transcripts, and unrestricted logs as potentially sensitive.
- When deterministic restart recovery requires a raw write payload, keep it separate from the operation envelope and Evidence, bind it by digest and stable invocation identity, restrict its filesystem permissions, and document storage-administrator visibility and retention.
- Diagnostics must be bounded and sanitized. Record stable error codes and digests instead of raw sensitive payloads.

## Evidence semantics

- Claims, model prose, state transitions, and machine-captured execution evidence are separate facts.
- A tool event emitted by an agent loop proves an attempted call, not necessarily a backend side effect.
- Record proposal, Gate decision, execution start, execution completion, replay, rollback, and failure as distinct events when applicable.
- Evidence may include normalized operation metadata and content digests; it must not include credentials or raw write content.
- Validate an Evidence chain before appending or trusting it. Do not repair tampering silently.
- Evidence rotation must preserve sequence continuity and terminal-hash linkage across segments. Never delete Evidence automatically; export and explicit retention approval are required.

## Authorization and side effects

- Authorization must bind actor, operation digest, policy version, workspace scope, and stable invocation identity.
- The Channel Plane may authenticate an actor identity, but Tiangong must own approval roles and must not treat an upstream owner boolean as sufficient authorization.
- Approval text must be generated from machine operation fields, not model prose.
- Pending approval must not block a Matrix turn. Persist it and validate a later command independently of the model.
- Completed operations replay saved safe results without duplicate execution within the declared replay window. Expiring that window must be explicit, auditable, preceded by Evidence summarization, and followed by physical journal compaction.
- Validate the idempotency journal hash chain on initial load and reject partial or ambiguous records. Serialize readers with append/compaction writers across processes.
- Erase protected raw write payloads only after a terminal outcome no longer needs them; uncertain and conflict states retain their recovery material. Do not rely on directory deletion when the storage synchronizer may recreate deleted objects; publish a zero-length replacement and terminal marker through the official AgentTeams storage credential layer.
- Treat an interrupted `executing` operation as outcome-uncertain until reconciliation proves its state.
- Keep reconciliation outside model-accessible tools. Local container execution access is its authority; an operator-supplied actor label is audit attribution, not authentication.
- External resources require explicit scope, ownership, cleanup, and user approval when the operation is destructive, costly, public, or irreversible.

## Dependencies and distribution

- Use public dependencies and immutable pins where practical.
- Review licenses, source availability, install scripts, and transitive security advisories before adding or updating a dependency.
- Skills and smoke helpers are executable supply-chain inputs. Review them before trust or installation; metadata such as `allowed-tools` is not a security boundary.
