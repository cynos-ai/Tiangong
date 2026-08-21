# M8 AgentLoop diagnostic integration

Status: M8 complete; M8.5 bounded Web diagnostics addendum implemented and independently verified.

## Objective

Add replaceable AgentLoop diagnostics to the OpenClaw Worker path without changing Tiangong product authority, completion semantics, or credential ownership.

## Decisions

1. **Diagnostics are non-authoritative.** PostgreSQL and Matrix retain their M7 authority boundaries. AgentLoop cannot create or mutate Work, Task, Result, ToolResult, admission, outbox, approval, or completion state.
2. **The Worker has no AgentLoop credential.** Workers export credential-free OTLP HTTP/Protobuf to a dedicated Collector. The Collector alone injects the Alibaba Cloud write headers.
3. **Disabled by default.** Enabling AgentLoop requires `TIANGONG_AGENTLOOP_ENABLED=1` and the explicit `isolated-test` content-capture marker. Unsupported values fail before OpenClaw starts.
4. **No remote installer.** The fixed public plugin archive and license are checksum-verified. Dependency installation is lock-based, lifecycle scripts are disabled, and high/critical audit findings fail the image build.
5. **Stable correlation, no invented facts.** Work, Task, Member, Session, Turn, Skill, tool-call, and ToolResult identifiers are attached only after their owning runtime observes them.
6. **Web links, not a copied console.** Tiangong validates the official AgentLoop console origin/path and emits filtered links. It does not ingest, cache, or render AgentLoop trace payloads.
7. **Failure isolation.** Export loss, Collector absence, AgentLoop outage, sampling, or missing correlation cannot alter an authoritative operation or Result.

## Runtime shape

```text
AgentTeams Provider/model authority
              │
       OpenClaw 2026.4.14
        ├─ LoongSuite trace plugin 0.1.5-beta
        ├─ built-in diagnostics-otel metrics
        └─ Tiangong control spans/correlation
              │ no credentials; fixed OTLP/HTTP protobuf endpoint
              ▼
   OpenTelemetry Collector 0.136.0
              │ x-arms-license-key/project/workspace
              ▼
       Alibaba Cloud AgentLoop
```

The Collector is deployment infrastructure, not Worker runtime authority. Its fixed name is part of the network contract. It runs read-only with dropped capabilities, no-new-privileges, memory/PID bounds, and an ownership label used by cleanup.

## Data boundary

Default state is no AgentLoop export. The first enabled profile is disposable isolated testing because the vendor trace plugin is designed to expose model/tool observability. It must not be enabled against sensitive work until an explicit content, redaction, retention, access, and deletion policy exists.

Tiangong's own span attributes are bounded identifiers and stable categories. They exclude prompt/response text, Matrix message bodies, tool arguments and results, source content, credentials, headers, raw errors, and stack traces. Provider-internal hidden reasoning is outside the contract.

## Deterministic acceptance

The local M8 contract requires:

- fixed plugin/archive/license checksums and Apache-2.0 license;
- an audited locked dependency graph;
- OpenClaw `2026.4.14` loading exactly `diagnostics-otel`, the AgentLoop plugin, and `tiangong-control` without plugin ownership/config warnings;
- HTTP/Protobuf trace and metric configuration with logs disabled;
- direct Worker credential and endpoint override denial;
- secret-file symlink, permission, field, and endpoint rejection;
- Collector config validation and disposable start/stop cleanup;
- bounded correlation tests for Work/Task/Member/Session/Turn/Skill/ToolResult;
- Web console URL origin/path validation and Work/Task filter links;
- complete Worker/App suites and generic Worker image build.

## Real-service acceptance

A real AgentLoop run is a separate external integration check. It must use a newly issued credential that has never appeared in conversation or repository material. Required machine observations are:

1. Collector receives protobuf OTLP from an owned disposable Worker.
2. Collector export succeeds without logging credential values.
3. AgentLoop returns a queryable trace for the configured service.
4. The trace contains the real Work and Task identifiers from PostgreSQL facts.
5. Content shown is limited to the explicitly approved isolated test fixture.
6. Collector, Workers, Team, network additions, volumes, and external secret file are cleaned by their owners.

M8's isolated real-service run satisfied these observations: a read-only SLS `logstore-tracing` query returned the exact disposable service, the expected OpenClaw lifecycle and business span shape, and real same-run PostgreSQL Work/Task correlation; the owned scope was then proven absent. This historical result closes M8 but does not replace per-run external observation for future environments.

## M8.5 bounded Web diagnostics addendum

M8 decision 6 describes the original M8 delivery, not a general prohibition on every future diagnostic view. M8.5 adds an explicitly deployed read-only metadata projection while retaining the external AgentLoop console as a fallback. It does not copy the console, store traces, or change any M8 authority decision.

The query path is a deployment-owned Python Adapter using the public official SLS SDK. The read-only RAM key is mounted only into that Adapter from a repository-external owner-only mode-`0600` two-field file. Endpoint, project, `logstore-tracing`, exact service allowlist, environment, time/result limits, and query shape are separate validated configuration. The Node Coordination runtime receives only the fixed private URL `http://agentloop-query-adapter:8791`; Workers share no network with the Adapter.

The browser route accepts only the selected Work ID. Before querying, Coordination revalidates the current Matrix Web session and bound-Room membership, then reads PostgreSQL and requires exact Team/route/Room ownership. It derives a maximum 24-hour interval from the Work's persisted timestamps. Browser input, credentials, Work text, and span content cannot select the backend target or query.

The Adapter returns at most 100 deduplicated span summaries containing only Trace/Span/parent IDs, exact service, span name/kind, timestamp/duration, status, model, Work/Task IDs, and optional usage counters. Raw attributes, model content, Matrix content, tool content, status messages, stack traces, backend messages, and credentials are excluded in both the Adapter and Coordination projections. Timeout, capacity, oversized/malformed response, service/environment mismatch, duplicate conflict, and truncation are bounded and fail closed.

The panel is loaded only by an explicit Human click and is visually marked **non-authoritative**. Empty or unavailable diagnostics remain unknown. Queries do not enter PostgreSQL transactions, `/api/runtime`, SSE, Matrix routing, CloseGuard, readiness, Result, ToolResult, or Work timeline. A bounded in-memory TTL cache is the only cache. Usage totals count only model-bearing LLM spans because AgentLoop can repeat child LLM usage on parent agent spans; missing fields remain unknown and cost is never estimated.

M8.5 verification separates three facts:

1. deterministic fixtures prove secret/config/schema denial, Web session and PostgreSQL scope, timeout/concurrency/cache, SSE independence, raw-content exclusion, and exact deployment cleanup;
2. the built Adapter image queried historical M8 SLS records and returned four bounded correlated spans with no raw content;
3. an owned disposable PostgreSQL replay plus a real Matrix Web login exercised the complete read path against those historical SLS observations, including cache and cross-scope denial, then removed its containers/network. This is a read-path replay, not a claim of fresh span emission; a future fresh writer run still requires a new LicenseKey.
