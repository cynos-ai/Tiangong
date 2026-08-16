# Codex capability global-cache focused run

## Scope

- Boundary: Tiangong canary image, Codex capability detector/cache, AgentTeams
  v1.2.2 Worker startup, and a deployment-owned shared Docker volume.
- Provider/model: `agentteams-gateway/deepseek-v4-pro` for the real canary;
  an isolated synthetic provider fingerprint for the concurrency probe.
- Pre-gate image observation: `sha256:59e01c909bca77641c134bd912ce41a9f98fad9a4cf0a662dabdd86e10c90c4c`;
  current fail-closed image: `sha256:2f856b9e6114eb3de51e39c22e2bab024fa039b8ec54ee029885fafd1f7443c6`.
- Owned resources: one disposable Gate A Worker/container and one disposable
  capability-cache Docker volume. No provider credential is retained.

## Deterministic checks

- Focused Worker suite: 37/37 passed, including the remote cache service lease
  and sanitized persistence test.
- Worker observability contract: passed.
- OpenClaw Gate A fixture contract and shell syntax: passed.

## Machine facts

- The pre-gate real canary reached `phase=Running`, container `running`,
  `runtime_lane=openclaw-canary`, and `harness_fallback=none`; its first startup
  selected `cacheHit=false`, and restart selected `cacheHit=true`.
- The current image, with embedded AgentTeams' missing shared-volume declaration,
  failed before readiness with the stable error
  `Codex auto routing requires a deployment-owned shared capability cache`.
- Two independent containers sharing one deployment volume produced exactly one
  cache miss and one cache hit for the same fingerprint. The persisted cache had
  one entry and contained no credential-shaped value.
- Both Gate A runs reported `gate_a_cleanup=pass`; Worker, containers, and
  run-owned storage were removed.

## Boundary and limitation

This run proves the shared-file implementation, the deployment-owned service
adapter, the earlier real DeepSeek native startup path, and the current
fail-closed behavior. The embedded AgentTeams Docker `agt apply` route still does
not expose a Worker shared-volume field, so the adapter deliberately uses an
internal network service backed by its own labeled volume rather than mutating
Worker mounts. The direct Kubernetes PodTemplate/shared-mount alternative remains
available, but is not required by the current Docker adapter. The prior Qwen
OpenCodex bridge Team canary remains valid for the explicit bridge route; its
sidecar lifecycle is still a separate deployment-owned gate.

## Deployment adapter completion

The embedded Docker `agt apply` route still has no Worker volume field, so the
deployment-side implementation uses `scripts/deploy-codex-capability-cache.sh`.
It runs `tiangong-codex-capability-cache` on `agentteams-net`, stores the bounded
cache in the deployment-owned volume `tiangong-codex-capability-cache`, and exposes
only credential-free `lookup`/`commit` requests to Workers. The canary image now
defaults `TIANGONG_CODEX_CAPABILITY_CACHE_SHARED=1` and the internal service URL;
service absence or malformed state remains fail-closed.

The real two-Worker run `smoke-testing/support/run-openclaw-global-cache-smoke.sh`
passed on 2026-08-15. The exact Workers were
`tiangong-codex-cache-a-20260815013102-50013` and
`tiangong-codex-cache-b-20260815013102-50013`. Both were AgentTeams-managed
`runtime=openclaw` Workers using the current canary image, both reached Running and
passed the Codex gateway preflight, one logged `hit=false` and the other `hit=true`,
the shared file contained one `native-responses` entry with `hasCredential=false`,
and both Workers, containers, storage prefixes, and mirror paths were removed with
`codex_global_cache_cleanup=pass`. The deployment service and its owned volume were
intentionally retained for subsequent Worker startups.
