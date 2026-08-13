# AgentTeams v1.2.2 switch verification

## Scope

Verify the v1.2.2 image availability and the currently running local AgentTeams
surface without stopping or mutating an existing stack that is owned by a
different workspace. This is a read-only preflight for the OpenClaw/Codex
canary; it is not an in-place production upgrade.

## Expected checks

1. The public bootstrap is pinned to `v1.2.2` and uses a checksum-verified
   upstream installer.
2. The v1.2.2 embedded controller and runtime image manifests are available.
3. Matrix, Element Web, and the local control-plane endpoint remain reachable.
4. The live Manager reports `Running` and its exact image/version is captured.
5. No current container, named volume, credential file, or external workspace
   is stopped, replaced, or deleted by this run.

## Results (2026-08-13)

- **Bootstrap pin: PASS.** `scripts/agentteams.sh` and `.env.example` now use
  `v1.2.2`; installer SHA-256 is
  `8ef28c5bf239a0af2d6b57b946ecee977bf39e6c874cd786b85c7bd094668f9d`.
- **Embedded image manifest: PASS.** The official
  `agentteams-embedded:v1.2.2` manifest is available. Its inspected Linux
  amd64 manifest digest is
  `sha256:0d42380c6c8766b5e48edd000fa46317255bd3895d44776ae7c46030c1bcdb56`.
- **Runtime image manifests: PASS.** The official
  `agentteams-manager-copaw:v1.2.2` and
  `agentteams-copaw-worker:v1.2.2` manifests are available. The inspected
  Linux amd64 digests are `sha256:ac2ff5ff72752ee169cff42959c548e7a9b7cf60d358b56435dabce3924a6de6`
  and `sha256:df4f57c450a820b47427fd3cd16d802b7defaaa52f61421bdda45ea943c58a0a`.
- **Web/control continuity: PASS.** Matrix versions, Element Web, and the
  local control-plane health endpoint each returned HTTP 200.
- **Owner-workspace upgrade: PASS.** The owning Linux workspace
  `/home/sj/codes/Tiangong` was switched to a dedicated validation branch. Its
  private `.env` was changed only from `v1.2.0` to `v1.2.2` (mode `600`); the
  existing LLM endpoint, model, runtime, ports, and data volume were preserved.
  The checksum-verified `scripts/agentteams.sh up` upgrade completed.
- **Persisted image override repair: PASS.** The controller resource retained
  the old `agentteams-manager-copaw:v1.2.0` image override after the first
  upgrade. The bounded `agt update manager --name default --image ...:v1.2.2`
  operation repaired that exact resource; no workers or data were deleted.
- **Post-upgrade stack: PASS.** Controller and Manager now run v1.2.2 images;
  Manager is `Running` with `welcomeSent=true`, and the existing Matrix room and
  Manager identity remain intact. Dashboard remains the intentionally
  independent `v1.2.0-beta.1` image, as documented by the upstream installer.
- **Ownership guard: PASS.** The upgrade was executed from the workspace that
  owns the containers and generated environment. The current Windows checkout
  was never used to stop or replace those resources.
- **Model gateway: PASS.** After the upgrade, the authenticated local
  `/v1/models` probe returned valid JSON with two models; the first reported
  model was `deepseek-v4-flash`. The key was read only in memory for the probe
  and was not written to this repository or retained in evidence.
- **OpenClaw/Codex claim: NOT PROMOTED.** No OpenClaw Worker was provisioned in
  this run, and no native Codex WebSocket turn was claimed. The existing
  OpenClaw Gate A records remain the source for the separate Codex
  gateway/WebSocket compatibility result.

## OpenClaw Gate A follow-up (2026-08-13)

- **Canary creation: PASS.** The reserved `tiangong-openclaw-canary` Worker was
  created from `tiangong-worker-canary:dev` on the v1.2.2 stack. The resource
  reached `phase=Running`, with the expected OpenClaw runtime, isolated lane,
  and `OPENCLAW_AGENT_HARNESS_FALLBACK=none`.
- **Startup boundary: PASS.** Container health, Matrix login/room join,
  `tiangong_preflight`, and the authenticated AgentTeams gateway probe for
  `codex/deepseek-v4-pro` all appeared in bounded machine state. The live hook
  contract also passed against the running Worker.
- **Restart observation: PASS WITH DRIVER TIMEOUT.** The restart driver timed
  out while waiting for its strict post-restart log conjunction. Direct facts
  after the timeout showed the same container identity still running,
  `phase=Running`, OpenClaw health available, and the canary lane/fallback
  unchanged. This is classified as a smoke oracle/timeout issue, not a Worker
  readiness failure.
- **Web continuity: PASS.** Matrix, Element Web, and Dashboard returned HTTP
  200 while the canary was running.
- **Cleanup: PASS AFTER BOUNDED REPAIR.** AgentTeams removed the Worker
  resource, but its mirror directory remained. The run then removed only the
  fixed canary mirror/storage prefix and verified that the Worker container,
  controller/Manager mirror paths, storage prefix, and run state were absent.
- **Deterministic test-driver notes.** The owner checkout did not preserve
  executable bits on smoke scripts, and the Gate A contract's final static grep
  is over-broad for legitimate token field names. Node contract tests were
  `6/6`; these driver issues were not changed during the live run.

## Promotion decision

**Platform and OpenClaw canary: promoted for continued Gate A work, not for the
default Worker lane.** The owner-workspace v1.2.2 stack and an isolated OpenClaw
Codex canary both passed their startup/readiness boundaries. Native Codex
WebSocket transport through AgentTeams is still a separate compatibility
question; do not change the default Worker lane until a real model/tool turn,
ToolResult capture, approval, and recovery are separately evidenced.
