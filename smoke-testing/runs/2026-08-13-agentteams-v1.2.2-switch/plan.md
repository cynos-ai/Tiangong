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
- **Current stack version: OBSERVED.** The live Manager is `Running`, but its
  image is still `agentteams-manager-copaw:v1.2.0`. The running stack also has
  a mixed controller/dashboard image state, so it is not evidence of a
  completed v1.2.2 deployment.
- **Ownership guard: BLOCKED FOR IN-PLACE SWITCH.** The containers are mounted
  from a different workspace and this repository has no matching `.env` or
  ownership state. The switch command therefore was not run; changing named
  containers or the shared data volume here would risk deleting or replacing
  state outside this run's ownership.
- **Model/Codex claim: NOT TESTED IN THIS RUN.** No key was copied or printed,
  and no LLM request was needed for the version/continuity preflight. The
  existing OpenClaw Gate A records remain the source for the separate Codex
  gateway/WebSocket compatibility result.

## Promotion decision

**Do not promote the live stack to v1.2.2 from this workspace.** Run the
checksum-verified upgrade from the workspace that owns the current containers,
or provision an isolated stack with distinct container names, ports, and data
volume. After that, repeat the Gate A Matrix/Element continuity and Codex
gateway checks against the v1.2.2 Worker before changing the default lane.
