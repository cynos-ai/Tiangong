# M8 AgentLoop diagnostic integration

Status: complete; local contracts and isolated real-service reporting/query acceptance verified.

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
