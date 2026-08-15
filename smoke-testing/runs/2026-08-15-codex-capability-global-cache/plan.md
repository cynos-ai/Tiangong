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

- Focused Worker suite: 36/36 passed.
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

This run proves the shared-volume implementation, the earlier real DeepSeek native
startup path, and the current fail-closed behavior. The current embedded
AgentTeams Docker `agt apply` route does not expose a Worker shared-volume field,
so it does not yet prove a production multi-Worker mount. Production promotion
remains conditional on a deployment adapter/PodTemplate mounting the same RW
cache path into every Worker and setting `TIANGONG_CODEX_CAPABILITY_CACHE_SHARED=1`.
The prior Qwen OpenCodex bridge Team canary remains valid for the explicit bridge
route, but the sidecar lifecycle and shared-volume mount are still deployment-owned
work.
