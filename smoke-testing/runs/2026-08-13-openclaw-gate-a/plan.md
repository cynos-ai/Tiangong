# OpenClaw Gate A compatibility canary — focused run plan

## Status and ownership

- Status: **IN IMPLEMENTATION — A2/A3 readiness and hook seams are proven; A4-A6 remain open**.
- Scope: public, credential-free compatibility and fail-closed probes for an
  isolated OpenClaw Worker lane.
- Product code enabled by this plan: the deterministic plugin/control-API
  preflight contract in `worker/agent/preflight/`, the Gateway wrapper hook,
  the isolated `tiangong-worker-canary:dev` image target, and the pure
  two-stage admission contract in `worker/agent/gates/admission-boundary.mjs`
  and its fail-closed OpenClaw hook registration.
- Driver: `smoke-testing/support/run-openclaw-gate-a.sh` (start/status/stop/run).
- This plan is the public S0.1 inventory and Gate A test contract. The W0
  read-only Runtime Console shell now exists under `app/` and reports unknown
  until direct runtime facts are configured. It does not copy private research,
  schedules, credentials, or internal reports.

## Why this gate exists

The target design keeps AgentTeams responsible for Worker/channel/storage
integration and keeps Tiangong responsible for Worker control, admission,
tools, operations, approvals, recovery, and the Web experience. Gate A tests
whether an unmodified, pinned OpenClaw process can sit behind that boundary in a
separate canary lane.

The existing Web UI remains the continuity witness for this gate: the current
Dashboard and Element/Matrix view must stay usable before, during, and after a
canary run. Gate A does not replace, hide, or redesign the UI.

## Current public caller and retirement inventory

These are current public callers of the legacy Tiangong pi harness. They are
control-path dependencies, not permission to remove them during Gate A.

| Current caller | Direct dependency or assertion | Retirement condition |
|---|---|---|
| `worker/Dockerfile` | packages the current Worker image, installs the OpenClaw wrapper/plugin, and sets `OPENCLAW_AGENT_RUNTIME=tiangong-pi` | Gate B clean-cut run proves the replacement Worker image and readiness path |
| `worker/plugin/index.mjs` | exports plugin id `tiangong-pi` and registers the current Agent harness | replacement plugin has an equivalent tested control contract and all callers are migrated |
| `worker/plugin/openclaw-adapter.mjs` | implements `createTiangongPiHarness`, turn routing, and bounded harness evidence | Gate B proves Work/Task/Result plus restart and recovery without this adapter |
| `worker/agent/runtime.mjs` and `worker/agent/model-gateway.mjs` | import the current pi runtime/model abstractions | replacement local coding path is prepared, bounded, and observable |
| `worker/agent/session-store.mjs` | persists sessions through the current pi package | replacement session boundary is explicitly owned and restart-tested |
| `worker/agent/tools/registry.mjs` and `worker/agent/tools/constrained-write.mjs` | reuse current pi tool definitions and constrained-write helpers | replacement tool boundary passes allowed, denied, replay, and capture-gap probes |
| `worker/bin/openclaw` and `worker/scripts/patch-dependencies.mjs` | wrap or patch the current runtime dependency at image startup/build time | replacement image starts without the wrapper/patch path and retains fail-closed startup |
| `smoke-testing/support/run-worker-smoke.sh` and peer/leader/P0.2 drivers | assert `tiangong-pi`, `/tmp/tiangong-pi-harness.last-run`, and current runtime markers | the corresponding public scenarios are updated only after Gate B evidence |
| `scripts/agentteams.sh` | accepts `openclaw` as a supported Worker runtime | remains compatible with the selected canary runtime; change only with a tested platform contract |

No item in this table is deleted or renamed by Gate A. A passing canary is not
permission to remove the legacy path, migrate data in place, or change the
default lane.

## Lane isolation and Web continuity

The run owns a disposable `openclaw-canary` Worker and its own Team/room,
storage prefix, Matrix identity, and run state. It must not attach to a
`legacy-v0.2` Team, reuse a production/default storage prefix, or double-write
the same Work. The current Dashboard and Element/Matrix room remain available
as read-only continuity witnesses; the authoritative assertions below come
from direct machine facts, not screenshots or model prose.

## Gate A contract

The run must establish all six boundaries below. Every hard control has an
allowed path, a denied path, and its nearest replay/race or failure path.

| Boundary | Allowed path | Denied/failure path | Direct machine fact |
|---|---|---|---|
| A1 pinned image | the declared OpenClaw image/version is immutable and starts the canary Worker | mutable/unresolved image, missing executable, or image drift | image digest/version, container id, and startup manifest match the run input |
| A2 required plugin and preflight | required Tiangong plugin loads before readiness, reports its bounded identity/capabilities, and binds the explicit runtime lane | plugin absent, load error, lane mismatch, or control API timeout keeps Worker not-ready | readiness is absent/false and the startup record names the failing preflight; no turn is admitted |
| A3 AgentTeams entrypoint/storage/Matrix | entrypoint mirrors only the owned prefix, renders config, restores Matrix credentials, and reaches channel readiness | wrong prefix, missing config, stale login, or restart before channel readiness | bounded storage-prefix, config-hash, Matrix identity/room, and readiness observations |
| A4 two-stage admission | a permitted source passes the pre-model gate and then the pre-tool gate under the active binding | ordinary chat, stale policy, wrong source, changed request, or revoked binding is denied before model/tool execution | admission decision, source, binding revision, and zero model/tool invocation on denial |
| A5 ToolResult capture | built-in, local-coding, and other tools each produce a bounded ToolResult record | tool-result persistence hook is absent, malformed, or loses the result | per-tool capture matrix with success/error/denied/replay rows and no credential-bearing payload |
| A6 restart/recovery | a clean restart preserves the declared canary identity and leaves no duplicate active execution owner | crash, readiness loss, or duplicate delivery cannot create a second owner or silently replay an effect | pre/post restart ids, owner count, delivery key, and terminal/recovery state |

The image pin must be recorded by an immutable digest or source commit in the
implementation change before the run is executed. This plan intentionally does
not invent a version or claim compatibility before the canary produces those
facts.

## Preconditions and execution order

The future driver must refuse to replace any existing fixed state directory or
named resource. It runs the cheapest deterministic checks first, then the
container boundary, then the isolated Matrix/storage readiness probe:

```text
make verify
make test-openclaw-gate-a-contract
make openclaw-gate-a-start
make openclaw-gate-a-status
make openclaw-gate-a-restart
make openclaw-gate-a-stop
```

While the disposable Worker is running, `make test-openclaw-gate-a-live-hooks`
queries OpenClaw's own plugin registry and proves the pinned typed-hook names
and priorities, rather than treating source inspection as runtime evidence.

`make test-openclaw-gate-a-contract`, `make test-openclaw-gate-a-fixture`,
`make test-openclaw-admission-contract`, and
`make test-openclaw-admission-hooks` are now available and prove the
credential-free A2 preflight contract. The `start`, `status`, and `stop`
commands exercise the isolated Worker/Team/room driver. A real run requires
`TIANGONG_RUN_REAL=1` and owns a fixed disposable Worker, storage prefix,
Matrix room, and local state file.

`make test-openclaw-admission-replay` proves the deterministic A4 allow, stale
binding replay, changed-request, and revoked-tool paths. `make
test-openclaw-tool-result-capture-matrix` proves bounded success, error, denied,
and replay metadata capture without retaining raw ToolResult payloads. These
focused checks advance the seams only; they do not claim a durable Control API
or AgentTeams ToolResult retention/reference implementation.

The driver must:

1. validate the immutable image pin and required plugin before creating a
   Worker;
2. create only the run-owned canary resources and record exact identifiers;
3. prove readiness and the A2 failure cases without invoking a real model;
4. use deterministic fixtures for admission, replay, and ToolResult capture;
5. run one bounded local coding turn only after the no-side-effect gates pass;
6. restart the same canary once and re-check identity, owner count, and
   readiness; and
7. clean every owned resource, verify absence, and keep the run red on any
   cleanup failure.

## Required evidence

The completion report must include only bounded, sanitized machine facts:

- immutable image reference and plugin/preflight result;
- Worker/Team/room/storage identifiers, with credentials and unrestricted
  payloads removed;
- readiness and Matrix channel observations before and after restart;
- A2 denial facts for missing plugin and unavailable control API;
- A4 admission truth table, including zero-invocation denial assertions;
- A5 ToolResult capture matrix for built-in, local-coding, and other tools;
- A6 owner/replay/recovery observations; and
- cleanup post-checks proving the canary resources and run state are absent.

UI screenshots may be retained as secondary evidence of continuity, but they
cannot prove readiness, authorization, idempotency, capture, or cleanup.

## Promotion and non-claims

## Recorded Gate A attempt

On 2026-08-13, after the wrapper was normalized to LF and the pinned
OpenClaw `2026.4.14 (2f35b6f)` config contract was corrected, the isolated
canary reached:

```text
tiangong_preflight=pass plugin=tiangong-pi lane=openclaw-canary control_api=disabled
gateway ready (8 plugins: ..., tiangong-pi; 12.9s)
worker/tiangong-openclaw-canary reported ready
gate_a_phase=Running
worker_running=true
runtime_lane=openclaw-canary
harness_fallback=none
gate_a_cleanup=pass
```

This proves the pinned image, Tiangong plugin/preflight, AgentTeams storage
entrypoint, OpenClaw Gateway, Matrix readiness, isolated lane, and cleanup
boundary. The live registry also reports the bounded `tool_result_persist`
capture hook. It does **not** prove A4 admission, A5 per-tool persistence
matrix, or A6 full recovery/ownership proof; a same-container
restart/readiness probe passes, while duplicate-owner and durable replay cases
remain open.
The pinned
image uses `api.on("before_dispatch", ...)` and `api.on("before_tool_call", ...)`
for typed hooks; the adapter must not assume the newer `before_agent_run` or
`allowConversationAccess` contracts.

On 2026-08-13, the isolated Worker resource was created with
`tiangong-worker-canary:dev` and its own storage prefix. The first attempt
failed before OpenClaw startup because the Windows checkout supplied CRLF to
the shell entrypoint (`/usr/bin/env: 'bash\\r'`); the image was rebuilt after
normalizing the wrapper to LF. The next attempt reached the AgentTeams Worker
container, but the container exited with code `127` before readiness. The
bounded container log identified the remaining local-stack blocker:

```text
/usr/bin/env: 'bash\\r': No such file or directory
```

The canary Worker, container, run state, and owned storage prefix were then
removed and verified absent. This is a failed/blocked run, not Gate A pass
evidence. The next run must rebuild from the normalized shell assets and must
record the first post-entrypoint exit reason before promotion.

Gate A promotes only to Gate B design/implementation review. It does **not**
authorize deleting the pi harness, migrating existing data structures,
opening external writes, changing the default Worker lane, or claiming that
the target Work/Task/Result/Operation model is implemented.

Gate B must separately prove the minimal Work/Task/Result path, cross-Gateway
delivery, prepared local coding, restart/recovery, and a clean-cut canary
before any legacy caller is retired. Gate C owns the first external write,
exact Approval, Operation lifecycle, and recovery proof.
