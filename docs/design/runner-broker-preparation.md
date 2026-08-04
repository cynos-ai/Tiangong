# Runner broker preparation boundary

> Status: implemented and covered by deterministic Worker tests. This document
> describes the current professional Implementor/Assessor dispatch boundary;
> it does not authorize a `DELIVERED` claim by itself.

## Ownership

The Leader's Tiangong `TeamTaskPort` owns the ordering boundary. AgentTeams
Project/Task records remain authoritative. Tiangong writes only its immutable
binding and dispatch-state supplements under those records. The Matrix channel
adapter is called only after the broker preparation receipt is verified.

The shared `tiangong-runner-broker` is the only component with Docker authority.
Professional Workers use the fixed internal execution endpoint
`http://tiangong-runner-broker:8787/v1/execute`; they never receive the Docker
socket or platform credentials. The broker preparation endpoint is the same
service at `/v1/prepare` and is called by code, not exposed as a model tool.

## Ordering contract

For an Implementor or Assessor Task, the Leader performs this sequence:

1. authenticate the Team Leader and verify the five-member roster;
2. write the immutable Tiangong Task binding and the native AgentTeams Task;
3. synchronize the shared coordination record;
4. call the broker `/v1/prepare` boundary with the exact Project/Task bindings;
5. require a `status=ready` receipt bound to the Task digest and fixed endpoint
   digest;
6. only then send the Matrix mention to the assignee.

A preparation failure records an immutable `dispatch-state.json` with
`status=preparation_failed` and a stable error code. The same Task binding
cannot be prepared or notified again through normal dispatch; a later call
returns `RUNNER_BROKER_PREPARATION_RETRY_BLOCKED`. No notification, Runner
plan, command, or replay is inferred from the durable native Task record.

## Preparation request and receipt

The request has exactly these fields:

```json
{
  "schemaVersion": 1,
  "projectBinding": "verified immutable Project binding",
  "taskBinding": "verified immutable Implementor or Assessor binding",
  "inputTaskBinding": "null for Implementor; the one accepted Implementor binding for Assessor"
}
```

The response has exactly these fields:

```json
{
  "schemaVersion": 1,
  "status": "ready",
  "taskId": "...",
  "taskBindingDigest": "sha256",
  "bindingDigest": "sha256",
  "endpointDigest": "sha256 of the fixed /v1/execute endpoint",
  "replayed": false
}
```

No raw endpoint, credential, prompt, response, or unrestricted log is placed
in Tiangong Evidence. Evidence records only Task/binding digests, the fixed
endpoint digest, the broker binding digest, replay status, and stable failure
codes.

## Broker registration

A preparation-enabled broker starts with an empty immutable registration set
and a fixed configuration containing:

- the exact Leader image digest;
- the exact Implementor and Assessor Runner image digests;
- the AgentTeams network and fixed broker port.

The startup configuration is fixed; the broker-owned registration state is the
only code-owned append/replace-atomic extension point.

The broker authenticates the preparation caller by Docker network source,
exact `agentteams-worker-<leader>` container, image, running state, and
`AGENTTEAMS_WORKER_NAME`. It verifies the Project/Task binding and exact role
mapping, discovers the exact assignee Worker container, and registers a
binding in its broker-owned append/replace-atomic state. The fixed execution
contract is code-owned: `["node", "probe.mjs"]`, role-derived cwd,
30-second timeout, and 65536-byte output limit. An Assessor registration is
allowed only after its exact Implementor binding is registered for the same
revision. Assessor `inputRefs` may also carry a
ChangeRevision artifact reference; only the single matching Implement Task
binding is used for preparation, while malformed Task references fail closed.

Registration is idempotent for the exact Task binding and rejects a different
binding for the same Task. Historical bindings may retain the same exact Worker
and container across revision waves, but their Task identities remain unique
and their Worker/container/image/role identity must stay consistent. After
registration, the broker independently re-authenticates the assignee's exact
container and requested Task before returning `ready`. Runner `/v1/plan` and
`/v1/execute` select the registered Task from the request body, then
authenticate the exact source container, Worker name, image, network, and
selected Task.

## Verification

Deterministic coverage is provided by:

- `worker/test/runner-preparation.test.mjs` — request/receipt, input, and
  transport contract;
- `worker/test/runner-preparation-server.test.mjs` — dynamic registration,
  replay, persistence, fixed command, exact peer, and negative paths;
- `worker/test/team-task-port.test.mjs` — preparation-before-notification and
  terminal no-retry state;
- `scripts/runner-broker.sh` — starts the fixed DNS service before professional
  Task dispatch and probes its network reachability without a Worker socket.

This boundary is necessary but not sufficient for `DELIVERED`; Assessor
acceptance, explicit approval, deployment verification, requester delivery,
and durable terminal Evidence remain separate gates.
