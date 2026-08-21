# Worker observability and AgentLoop

Tiangong can export diagnostic OpenTelemetry traces and OpenClaw runtime metrics to an OTLP/HTTP collector. Export is disabled by default and is never a product authority.

## Authority and privacy boundary

PostgreSQL remains the sole Tiangong authority for Work, Task, Result, Matrix admission, request replay, and wake-outbox state. Matrix remains the Room/message/history authority. AgentLoop and OpenTelemetry data can be delayed, sampled, dropped, or unavailable, so they cannot authorize an operation, satisfy CloseGuard, prove an external side effect, or certify a Result.

Tiangong does not restore the removed hash-chain Evidence runtime. Machine facts, model prose, Matrix delivery observations, and diagnostic telemetry remain distinct facts.

AgentLoop content capture is **off by default**. This integration permits it only when the Worker is explicitly marked `isolated-test`. Do not enable it for production, private repositories, customer data, or unreviewed retention policies. Hidden chain of thought is neither collected nor claimed.

## Supported integration

The M8 integration is pinned and verified against:

- OpenClaw built-in `2026.4.14`;
- Alibaba LoongSuite `opentelemetry-instrumentation-openclaw` `0.1.5-beta` release archive and Apache-2.0 license, both checksum-verified during the image build;
- OpenClaw's built-in `diagnostics-otel` plugin;
- OTLP over HTTP/Protobuf only;
- OpenTelemetry Collector Core `0.136.0` at an immutable image digest.

The release plugin's original lock selected vulnerable OpenTelemetry/protobuf dependencies. Tiangong replaces only that transport dependency set with locked, audited `@opentelemetry/exporter-trace-otlp-proto@0.221.0` and OpenTelemetry SDK `2.10.0`; the image build fails on a high/critical production audit finding. The complete replacement lock is `worker/agentloop-package-lock.json`.

Official references:

- [Alibaba Cloud: Integrate OpenClaw with Cloud Monitor 2.0](https://www.alibabacloud.com/help/en/cms/cloudmonitor-2-0/monitor-openclaw-applications)
- [OpenClaw: OpenTelemetry export](https://docs.openclaw.ai/gateway/opentelemetry)

Tiangong does not execute the vendor's remote `curl | bash` installer. The Worker image downloads a fixed public release archive and license, verifies their hashes, installs locked dependencies without lifecycle scripts, and verifies plugin loading in the finished image.

## Credential-isolating topology

```text
OpenClaw Worker (no Alibaba Cloud credential)
  ├─ AgentLoop traces ─┐
  ├─ diagnostics metrics ── OTLP HTTP/Protobuf ──> tiangong-agentloop-collector
  └─ Tiangong control spans ─┘                       └─ inject x-arms-* headers ──> AgentLoop
```

Workers are hard-coded to `http://tiangong-agentloop-collector:4318`. They reject Alibaba Cloud AgentLoop credentials, arbitrary OTLP endpoint overrides, OTLP headers, certificate/key paths, and ambient exporter overrides. Only the collector receives the write credential.

Create a repository-external file owned by the operator with mode `0600`:

```dotenv
AGENTLOOP_ENDPOINT=https://<project>.<region>.log.aliyuncs.com/apm/trace/opentelemetry
AGENTLOOP_LICENSE_KEY=<new-license-key>
AGENTLOOP_PROJECT=<sls-project>
AGENTLOOP_WORKSPACE=<cms-workspace-id>
```

Use the base endpoint without `/v1/traces` or `/v1/metrics`; the Collector appends the signal path. Never reuse a key that has appeared in chat, source, logs, shell history, or an evidence artifact—rotate it first.

Start the collector only after the AgentTeams network exists:

```bash
export TIANGONG_AGENTLOOP_SECRET_FILE=/absolute/path/outside/Tiangong/agentloop.env
make agentloop-collector-start
make agentloop-collector-status
```

Enable a disposable Worker injection explicitly:

```bash
export TIANGONG_AGENTLOOP_ENABLED=1
export TIANGONG_AGENTLOOP_CONTENT_CAPTURE=isolated-test
export TIANGONG_AGENTLOOP_SERVICE_NAME=tiangong-m8-test
```

Then run the existing Leader/member injection command for the owned disposable Workers. Stop the collector with:

```bash
make agentloop-collector-stop
```

The secret file is validated as a non-symlink regular file, limited to four exact fields, mode `0600` or stricter, and an exact Alibaba Cloud HTTPS OTLP base. The collector is read-only, capability-dropped, resource-bounded, attached only to the AgentTeams network, and ownership-labeled for exact cleanup.

## Correlation model

The Tiangong control plugin adds bounded attributes to matching spans:

```text
tiangong.work.id
tiangong.task.id
tiangong.member.id
tiangong.session.ref
tiangong.turn.id
tiangong.skill.id
tiangong.tool_result.id
tiangong.tool_call.id
```

Leader admission establishes Work/turn correlation. Member Task admission establishes Work/Task/member/session correlation. Skill selection and ToolResult persistence fill their identifiers when those machine facts exist. Correlation does not grant authority and missing correlation remains `unknown`; it is never guessed.

The Web runtime may expose a validated `https://agentloop4service.console.aliyun.com/.../app/llm_agent/app-list` link. Work and Task links add only their Tiangong identifier filter. The Web does not copy AgentLoop traces or credentials.

## Tiangong-owned spans

The `tiangong-control` plugin can also export sanitized control spans to the same local collector. Its endpoint is credential-free and supports only absolute `/v1/traces` OTLP HTTP/Protobuf URLs. It does not export prompts, responses, Matrix bodies, tool arguments/results, headers, credentials, raw exception text, or stack traces.

The diagnostic hierarchy can include control attempts, lifecycle checkpoints, model boundary checkpoints, and tool execution. A trace shows observed timing and correlation only. Silence is `unknown`; it is not proof of a deadlock. Only an explicit timeout or abort is a terminal machine observation.

## Verification

Run the deterministic contracts and image build:

```bash
make test-agentloop-contract
npm --prefix worker test
npm --prefix app test
make build-worker-image
```

A real AgentLoop acceptance run additionally requires a newly issued LicenseKey injected only through the external collector secret file. Success requires machine-observed OTLP export plus a queryable AgentLoop trace correlated to real Work/Task identifiers. Until that run is performed, local plugin loading and collector validation do **not** constitute cloud reporting proof.
