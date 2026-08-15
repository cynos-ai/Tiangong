# Codex capability global-cache focused run

## Scope

- Boundary: Tiangong canary image, Codex capability detector/cache, AgentTeams
  v1.2.2 Worker startup, and a deployment-owned shared Docker volume.
- Provider/model: `agentteams-gateway/deepseek-v4-pro` for the real canary;
  an isolated synthetic provider fingerprint for the concurrency probe.
- Image: `sha256:59e01c909bca77641c134bd912ce41a9f98fad9a4cf0a662dabdd86e10c90c4c`.
- Owned resources: one disposable Gate A Worker/container and one disposable
  capability-cache Docker volume. No provider credential is retained.

## Deterministic checks

- Focused Worker suite: 36/36 passed.
- Worker observability contract: passed.
- OpenClaw Gate A fixture contract and shell syntax: passed.

## Machine facts

- Real AgentTeams canary reached `phase=Running`, container `running`,
  `runtime_lane=openclaw-canary`, and `harness_fallback=none`.
- The first startup selected `transport=native-responses` with
  `cacheHit=false`; the same container restarted and selected the same route with
  `cacheHit=true`.
- Two independent containers sharing one deployment volume produced exactly one
  cache miss and one cache hit for the same fingerprint. The persisted cache had
  one entry and contained no credential-shaped value.
- Gate A cleanup reported `gate_a_cleanup=pass`; the Worker, container, and
  run-owned storage were removed.

## Boundary and limitation

This run proves the shared-volume implementation and the real DeepSeek native
startup path. The current embedded AgentTeams Docker `agt apply` route does not
expose a Worker shared-volume field, so it does not yet prove a production
multi-Worker mount. Production promotion remains conditional on a deployment
adapter/PodTemplate mounting the same RW cache path into every Worker. The prior
Qwen OpenCodex bridge Team canary remains valid for the explicit bridge route, but
the sidecar lifecycle and shared-volume mount are still deployment-owned work.
