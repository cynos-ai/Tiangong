# AgentLoop Web diagnostics smoke scenarios

## Ownership

- Related implementation: `agentloop_query_adapter/`, `app/coordination/agentloop-diagnostics.mjs`, `app/server.mjs`, `app/public/`, `scripts/deploy-agentloop-query-adapter.sh`.
- Related Skills: none; this is a deployment diagnostic read, not an Agent capability.
- Related state/Evidence: PostgreSQL Work is product authority; SLS span metadata is an external diagnostic observation; Matrix Web session is current read authorization.
- Update triggers: query schema, SLS SDK, Adapter network/secret boundary, Work scope, Matrix Web authorization, cache, UI semantics, or deployment cleanup changes.

## Boundary truth table

| Matrix session | PostgreSQL Work scope | Adapter/SLS | Expected result | Product authority impact |
|---|---|---|---|---|
| current member | exact Team/route/Room | bounded matching spans | 200 observed metadata, explicitly non-authoritative | none |
| current member | exact Team/route/Room | no match/unavailable | unknown or bounded unavailable state | none |
| absent/revoked | any | any | deny before Adapter query | none |
| current member | another Team/route/Room | any | 404 before Adapter query | none |
| current member | exact scope | timeout/capacity/truncation | bounded error or explicit partial result | none |
| Worker process | any | Adapter network | network unreachable | none |

## Basic smoke

### B1: fresh same-run Work diagnostics

- Purpose: prove the complete causal path from one disposable PostgreSQL Work and real Worker spans to the Human-visible panel.
- Setup:
  - use a unique owned `isolated-test` Team, Workers, service names, Work, Task, containers, networks, storage prefixes, and secret files;
  - use a newly issued write LicenseKey only in the Collector and a separate read-only RAM key only in the query Adapter;
  - run deterministic contracts and image builds first;
  - start the Collector, Workers, query Adapter, and Coordination runtime explicitly.
- Prompt: send one bounded synthetic Human request that produces one member model turn without private source, customer data, or external writes.
- Expected observations:
  - PostgreSQL contains the Work/Task and remains authoritative;
  - an authenticated Human opens that Work and explicitly presses **按需加载轨迹**;
  - the panel shows the fixed non-authoritative notice and bounded span metadata;
  - at least one returned business span has the exact same Work/Task IDs;
  - summary usage equals the model-bearing LLM span and does not double-count a parent span;
  - `/readyz`, `/api/runtime`, SSE, Matrix routing, and Work state remain independent of the query.
- Required evidence:
  - Work/Task IDs from PostgreSQL;
  - sanitized Adapter response fields: availability, complete/truncated, span count/names, model, correlation IDs, `rawContentEmitted: false`;
  - Web status, current Matrix membership check, and exact cross-scope denial;
  - Docker network intersection proving no Worker shares the Adapter network;
  - zero credential environment fields in Worker and Coordination;
  - exact owned-resource cleanup and absence.
- Skip/block rules:
  - block fresh emission if no new write LicenseKey exists; never reuse an old key;
  - local OTLP traffic, Collector readiness, model prose, or a replay fixture cannot replace same-run SLS observation;
  - any cleanup residue keeps the run failed.

### B2: authorized historical read-path replay

- Purpose: re-exercise the Web/PG/Adapter/SLS read path when a new write credential is intentionally unavailable, without claiming fresh emission.
- Setup:
  - use only an owner-authorized prior `isolated-test` observation whose exact Work ID, service, environment, and bounded time interval are already machine facts;
  - create a disposable PostgreSQL instance and explicitly label the recreated Work as a historical diagnostics replay;
  - use a real current Matrix Web login and the real read-only Adapter; do not recreate any original Result or claim same-run causality.
- Prompt: open the replay Work and explicitly load diagnostics.
- Expected observations:
  - matching bounded historical spans are returned;
  - second query is a bounded in-memory cache hit;
  - another Work ID is denied before query;
  - cost remains null and parent usage is not double-counted.
- Required evidence:
  - separate labels for historical SLS observation, disposable PostgreSQL replay, and current Matrix authorization;
  - bounded response and UI screenshot with the non-authoritative notice;
  - exact cleanup of replay PostgreSQL, Coordination container, network, files, and Matrix session.
- Skip/block rules:
  - this scenario proves only the read path and must never be reported as fresh span emission;
  - do not put historical identifiers or private Evidence into the public scenario asset.

## Full smoke

### F1: authorization, isolation, and degradation matrix

- Purpose: prove diagnostics cannot become authority or create a performance/credential path.
- Setup: complete B1 or B2 first, then use the same owned scope.
- Prompt: none; drive deterministic HTTP, revocation, network, and backend-failure boundaries.
- Expected observations:
  - absent and revoked Matrix sessions fail before Adapter invocation;
  - cross-Room/Team Work fails before Adapter invocation;
  - browser-supplied query/target/time parameters fail;
  - concurrent saturation, timeout, oversized/malformed response, environment/service mismatch, duplicate conflict, and backend error return bounded states without raw messages;
  - one blocked query does not delay a concurrent `/api/runtime` read or SSE event;
  - stopping the Adapter leaves readiness, PostgreSQL, Matrix, and Work state unchanged;
  - Worker DNS/network access to the Adapter fails;
  - neither Worker nor Coordination environment/process tree contains the RAM key or LicenseKey.
- Required evidence:
  - per-cell HTTP status and bounded code;
  - Adapter invocation count proving pre-query denials;
  - direct network attachment/intersection and failed Worker request;
  - readiness/SSE observations during a blocked query;
  - credential-field counts without printing values;
  - cleanup absence for every owned resource.
- Skip/block rules:
  - do not run a third external attempt after two failures of the same class without a lower-level diagnostic;
  - preserve only bounded sanitized observations before cleanup;
  - cleanup failure keeps F1 red.

## Maintenance notes

- Keep real SLS access explicit; builds, unit tests, image startup, Worker startup, and Collector startup must never query it.
- Fixtures may prove parsing, projection, authorization, cache, timeout, and concurrency, but not cloud reporting.
- Empty telemetry is `unknown`, never proof that a Work did not run or failed.
- Do not add raw span JSON, prompt/response, tool content, status messages, or credentials to smoke reports.
