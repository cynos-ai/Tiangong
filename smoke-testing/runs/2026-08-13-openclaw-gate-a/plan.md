# OpenClaw Gate A compatibility canary — focused run plan

## Status and ownership

- Status: **IN IMPLEMENTATION — no Gate A canary run has passed yet**.
- Scope: public, credential-free compatibility and fail-closed probes for an
  isolated OpenClaw Worker lane.
- Product code enabled by this plan: the deterministic plugin/control-API
  preflight contract in `worker/agent/preflight/` and the Gateway wrapper hook.
- Driver still to be added: `smoke-testing/support/run-openclaw-gate-a.sh`.
- This plan is the public S0.1 inventory and Gate A test contract. It does not
  copy private research, schedules, credentials, or internal reports.

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
| A2 required plugin and preflight | required Tiangong plugin loads before readiness and reports its bounded identity/capabilities | plugin absent, load error, or control API timeout keeps Worker not-ready | readiness is absent/false and the startup record names the failing preflight; no turn is admitted |
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
make openclaw-gate-a-stop
```

`make test-openclaw-gate-a-contract` is now available and proves the
credential-free A2 preflight contract. The `start`, `status`, and `stop`
commands remain unavailable until the isolated Worker/Team/room driver lands;
a missing command is a blocked implementation item, not a passing result.

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

Gate A promotes only to Gate B design/implementation review. It does **not**
authorize deleting the pi harness, migrating existing data structures,
opening external writes, changing the default Worker lane, or claiming that
the target Work/Task/Result/Operation model is implemented.

Gate B must separately prove the minimal Work/Task/Result path, cross-Gateway
delivery, prepared local coding, restart/recovery, and a clean-cut canary
before any legacy caller is retired. Gate C owns the first external write,
exact Approval, Operation lifecycle, and recovery proof.
