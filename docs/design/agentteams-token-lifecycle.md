# AgentTeams controller bearer-token lifecycle

## Scope

This note records the local, non-destructive revocation boundary for the
AgentTeams controller and Manager integration. It does not define authority
for Tiangong WorkRuns, Evidence, approvals, or Worker tools.

## Observed contract

The stock `agt` CLI bundled with the local AgentTeams controller supports
controller authentication through `AGENTTEAMS_AUTH_TOKEN` or
`AGENTTEAMS_AUTH_TOKEN_FILE`. Its credential-rotation command exposes only
`agt rotate appservice-token`, which rotates Matrix Application Service
credentials. That command is unrelated to the controller service-account
bearer token and must not be used as a substitute for controller-token
revocation.

The current local deployment keeps the controller token file as an owner-only
regular file. The Manager receives its controller bearer token through its
container-owned runtime configuration. No token value is copied into this
repository, logs, Evidence, prompts, or diagnostics.

## Fail-closed conclusion

The pinned local AgentTeams stack does not expose a verified, non-destructive
operation that invalidates an already-issued controller service-account bearer
token. Therefore Tiangong must not claim that an old token was revoked merely
because an operator:

- generated or installed a replacement token;
- restarted a container or reread its environment;
- deleted a local token file; or
- rotated Matrix Application Service credentials.

A revocation claim requires an upstream issuer operation that explicitly
rejects the old token, followed by a sanitized negative authorization test. The
old token itself must never be printed or persisted as evidence.

## Required remediation boundary

A safe product-level remediation needs one of the following upstream
contracts:

1. issuer-backed revocation or deny-listing for the token identity;
2. short-lived controller credentials with a documented refresh and revocation
   path; or
3. an explicitly approved destructive rebuild that replaces the issuer and all
   dependent credentials.

Tiangong does not emulate any of these in prompts, environment-variable
names, runtime names, or compatibility shims. Until an upstream contract is
available, the residual risk is recorded as **revocation unproven**. The
local-only network profile limits ordinary network exposure, but it does not
turn possession of a valid controller token or container-runtime authority
into a revocable capability.

## Operational rule

Do not run `agt rotate appservice-token` while investigating this boundary
unless Matrix Application Service rotation is the separately approved change.
Keep controller-token recovery and AgentTeams teardown outside model-accessible
Worker tools; any destructive teardown requires explicit operator approval.
