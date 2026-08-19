# Chat-first Web workbench smoke scenarios

## Ownership

- Related implementation: `app/matrix-web-gateway.mjs`, `app/server.mjs`, `app/public/`
- Related Skills: `work-coordination`, `work-planning`, `plan-challenge`
- Related state: Matrix Room history; CoordinationStore Work/Task/Result projections; bounded ToolResult capture
- Update triggers: Matrix login/sync/send contract, Web session authorization, Room binding, runtime SSE, Work projection, or workbench layout changes

## Boundary truth table

| Path | Expected fact | Forbidden shortcut |
|---|---|---|
| Human login and read | current Matrix `whoami`, current bound-Room membership, unencrypted Room, HttpOnly app session | token in URL, browser storage, logs, or PostgreSQL |
| Human send | Matrix event sender remains the authenticated Human; stable client transaction ID reaches Matrix | proxy sends as Leader; selected Work ID enters message content or request |
| Work selection | only the right-side fact projection changes | selection routes the next Matrix message |
| Runtime facts/SSE | every request and stream tick revalidates the Matrix session and membership | stale session continues after revocation |
| Encrypted Room | explicit unsupported error | empty history or apparent success |
| Matrix failure | local echo becomes failed and remains visible | fabricated event ID or successful Work admission |
| Work facts | WorkSpec, Plan refs/history, Agents, actual Skills, Task/Result, ToolResult, deliverables, and timeline come from their direct projections | model prose or UI-local state becomes a product fact |

## Basic smoke

### B1: Human Matrix chat and Work facts share one workbench

- Purpose: prove the M3 product shell uses Matrix as the only chat source while showing Tiangong facts beside it.
- Setup:
  - use an explicitly owned, unencrypted Matrix Team Room bound by the current runtime binding;
  - configure the Coordination runtime with `AGENTTEAMS_MATRIX_URL`; a deployment sender token is optional for Web chat and required only for the outbox consumer;
  - use an owned Human Matrix identity already joined to the Room;
  - load at least one open Work with a nullable or formed WorkSpec and one Task/Result projection.
- Prompt: send one ordinary Human message from the Tiangong composer without selecting a Work routing field.
- Expected observations:
  - login establishes an HttpOnly, SameSite session and clears the password field;
  - Room history and the sent message are visible in Tiangong and Element with the same Human sender and Matrix event ID;
  - a local echo appears before acknowledgement and resolves to the Matrix event;
  - left navigation shows Team/Room and Leader backlog metrics;
  - right navigation shows Room Work history; changing the selected Work does not change the next send request;
  - `workSpec: null` is rendered as “需求待形成”, not as missing data;
  - Plan references, Challenger Result, Agent/model/actual Skill use, Tasks, Results, ToolResults, deliverables, and timeline are shown only when their direct facts exist.
- Required evidence:
  - Matrix `whoami`, joined-members observation, send response event ID, and history echo;
  - browser console/network evidence with no credential in URL or response body;
  - Coordination `/api/runtime` projection containing the displayed Work IDs and direct facts;
  - no Matrix message body column or payload in PostgreSQL;
  - exact owned resource list and cleanup result.
- Skip/block rules:
  - block if the Room is encrypted, the Human is not currently joined, the runtime route differs, or a disposable identity/Room cannot be owned safely;
  - do not replace a blocked real Matrix run with model prose or a mocked success claim.

## Full smoke

### F1: revocation, pagination, restart, and send failure remain honest

- Purpose: prove failure and recovery do not create a second chat source or stale authorization.
- Setup: B1 plus enough messages for two history pages and an owned Coordination runtime restart.
- Expected observations:
  - backward pagination preserves stable event IDs without duplicates;
  - a forced Matrix send failure leaves a visible failed local echo and creates no fake event ID;
  - revoking the Matrix token or Room membership causes protected API requests to fail and the runtime SSE to emit `revoked` before closing;
  - refreshing or restarting the Coordination runtime rebuilds chat from Matrix and facts from PostgreSQL/capture sources; it does not restore a token from disk;
  - Work selection remains view-only after refresh;
  - cleanup removes only the owned identity/session/runtime/Room resources and verifies absence.
- Required evidence:
  - two Matrix pagination responses and deduplicated browser event IDs;
  - failed-send network result distinct from Work or Result facts;
  - SSE `revoked` event plus denied subsequent query;
  - post-restart Matrix history and Coordination projections;
  - zero owned resource residue.
- Skip/block rules: cleanup failure keeps the run red; E2EE is an explicit unsupported result, not an empty-room pass.

## Maintenance notes

- Deterministic App tests prove request bounds, CSRF, route binding, sender preservation, token containment, expiry, encrypted-room denial, and SSE revocation before any real smoke.
- The browser UI renders text and links through DOM text nodes and ships no third-party scripts. Keep the strict CSP and no-browser-storage checks in the deterministic suite.
- Matrix messages and Tiangong facts are separate evidence sources. A visible message does not prove Work routing, and a Work timeline reference does not duplicate or prove the message body.
