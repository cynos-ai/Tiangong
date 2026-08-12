# P0.4 identity, PostgreSQL, and network probe — focused run

## Ownership

- Related implementation: none yet. This is a P0 feasibility probe.
- Related Skills: `tiangong-smoke-authoring`, `tiangong-smoke-running`.
- Driver: `smoke-testing/support/run-p0-identity-pg.sh`
- Deterministic contract: `smoke-testing/support/p0-identity-pg-contract.mjs`
  (`make test-p0-identity-pg-contract`)
- App fixture: `smoke-testing/fixtures/p0-identity-pg/`
- Update triggers: any change to the frozen Human read-authorization
  mechanism, the step-up contract, the PostgreSQL race facts, or the
  credential-containment boundary.

## Scope

This is a **probe scaffold**, not a product implementation. It proves the
P0.4 identity / PostgreSQL / network boundary on the pinned local AgentTeams
stack and freezes the Human read-authorization mechanism. It explicitly does
**not** implement the Tiangong Web product, CoordinationStore, Work admission,
Team route / MemberConfig binding (a P1 target), or the P1 API.

## Frozen authorization decision

P0.4 freezes a single Human read-authorization mechanism for the product
design:

- **Transient Matrix proof** carried on every protected request (and every SSE
  poll). The browser-held Matrix session is the only proof of the current
  Human actor.
- `max_staleness_ms = 0`: the app re-runs Matrix `whoami` on every protected
  read and on every SSE verification tick, so a revoked token takes effect
  within the verification interval (≤ 750 ms in this probe), not at a
  session-boundary.
- An HttpOnly + SameSite=Strict app session binds the CSRF token and the
  step-up challenge, but the session alone never authorizes a protected read or
  a dangerous action.
- Dangerous actions (`approve` / `reject`) require a **fresh user-bound
  step-up**: a one-time server challenge bound to app-session + actor + exact
  Operation id + decision action, with a short expiry; replay and
  cross-operation/action use are rejected.

This selection is recorded so P1 does not re-choose between transient proof,
read-only service identity, and bounded TTL.

## Probe facts (observed 2026-08-12)

- Disposable Fastify/Vite app container joined the shared `agentteams-net`
  and served a bounded page plus a `/healthz` that proved database and network
  readiness.
- Disposable PostgreSQL container (no host volume) on the same network: the
  app executed and returned the race facts directly — unique constraint
  rejected the duplicate insert, two `SELECT ... FOR UPDATE` transactions
  committed serially (final epoch 2), optimistic-epoch update accepted exactly
  one of two concurrent writers and rejected the other, and the observed rows
  contained no credential-shaped text.
- Disposable Matrix Human identity (registered via the pinned appservice) and
  disposable Worker identity both verified by `whoami` through the app; the
  Human actor authorized `/protected/read`, the Worker actor authorized its
  internal route, and cross-actor use was rejected (403).
- HttpOnly + SameSite=Strict session cookie issued; protected read without the
  cookie returned 401.
- Fresh step-up: challenge without CSRF rejected (403); complete bound to the
  issuing session/actor/operation/action accepted; one-time replay rejected;
  cross-operation/action binding rejected; expired challenge rejected.
- SSE started only with a current transient Matrix proof; after the Human
  Matrix token was revoked, the existing stream received `event: revoked` and
  closed, and subsequent reads returned 401.
- Credential containment: the app's bounded `/diagnostics` reported Matrix
  token in memory only, not in the database or logs; direct scans of the app
  and PostgreSQL container logs found no token, password, or proof.

## Required evidence (direct machine facts)

- HTTP status sequence and bounded JSON fields from the driver assertions.
- `network_facts` from `docker network inspect agentteams-net`.
- PostgreSQL race facts from the app's `/database/probe` response.
- SSE `event: ready` then `event: revoked` after token revocation.
- `/diagnostics` credential-storage flags.
- App and database container log scans (no credential-shaped text).

## Owned resources and cleanup proof

Owned per run: one disposable Worker (`tiangong-p0-4-identity-worker`), one
app container, one PostgreSQL container, one app image tag, one Matrix Human
identity, the app/DB containers' admin-DM leave, and the reserved storage
prefix `agents/tiangong-p0-4-identity-worker`.

Cleanup is fail-closed: the driver revokes the Human Matrix token, deactivates
the disposable Human (verified by password-login denial), removes the Worker
(after the Manager leaves the Worker's room and the storage prefix is purged),
removes the app and PostgreSQL containers and the app image, logs out the
disposable admin session, and verifies each owned resource is absent. If any
credential leak is observed, cleanup is withheld and the run stays red.

On the recorded passing run, the Worker resolved to 404, the storage prefix
was empty, the Manager worker manifest was absent, no labeled containers
remained, and the run state directory was removed.

## Not claimed

- Tiangong Web product origin, CoordinationStore, Work admission, durable
  intent/outbox, Team route binding, or MemberConfig.
- Production Leader handling, takeover, or reconciliation.
- Any P1 API.
