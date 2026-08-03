#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Focused deterministic proof for the production Runner preparation boundary.
# It uses exact disposable Worker-image containers, not model or Matrix turns.
# The shared broker itself is started by the code-owned scripts/runner-broker.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly BROKER_SCRIPT="${REPO_ROOT}/scripts/runner-broker.sh"
readonly NETWORK="agentteams-net"
readonly LABEL="runner-preparation-smoke"
readonly SUFFIX="$(printf '%s' "$$-${RANDOM}-$(date +%s%N)" | sha256sum | cut -c1-10)"
readonly LEADER_NAME="prep-smoke-${SUFFIX}-leader"
readonly IMPLEMENTOR_NAME="prep-smoke-${SUFFIX}-implementor"
readonly ASSESSOR_NAME="prep-smoke-${SUFFIX}-assessor"
readonly LEADER_CONTAINER="agentteams-worker-${LEADER_NAME}"
readonly IMPLEMENTOR_CONTAINER="agentteams-worker-${IMPLEMENTOR_NAME}"
readonly ASSESSOR_CONTAINER="agentteams-worker-${ASSESSOR_NAME}"
readonly PROJECT_ID="prep-smoke-${SUFFIX}-project"
readonly IMPLEMENT_TASK_ID="prep-smoke-${SUFFIX}-implement"
readonly ASSESS_TASK_ID="prep-smoke-${SUFFIX}-assess"
readonly TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tiangong-runner-preparation-smoke.XXXXXX")"
readonly IMPLEMENT_REQUEST="${TEMP_ROOT}/implement.json"
readonly ASSESS_REQUEST="${TEMP_ROOT}/assess.json"
readonly IMAGE_LEADER="tiangong-worker-leader:dev"
readonly IMAGE_IMPLEMENTOR="tiangong-worker-implementor:dev"
readonly IMAGE_ASSESSOR="tiangong-worker-assessor:dev"
export IMPLEMENT_REQUEST ASSESS_REQUEST

cd "$REPO_ROOT"

cleanup_failed=0
started_broker=0
cleanup() {
  local container
  for container in "$LEADER_CONTAINER" "$IMPLEMENTOR_CONTAINER" "$ASSESSOR_CONTAINER"; do
    if docker inspect "$container" >/dev/null 2>&1; then
      if [[ "$(docker inspect --format '{{index .Config.Labels "io.tiangong.focused-run"}}' "$container" 2>/dev/null || true)" != "$LABEL" ]]; then
        cleanup_failed=1
      else
        docker rm --force "$container" >/dev/null 2>&1 || cleanup_failed=1
      fi
    fi
  done
  rm -rf "$TEMP_ROOT" || cleanup_failed=1
  if ((started_broker == 1)); then
    "$BROKER_SCRIPT" stop --purge >/dev/null 2>&1 || cleanup_failed=1
  fi
  if ((cleanup_failed == 1)); then
    printf 'runner_preparation_cleanup=fail\n' >&2
  else
    printf 'runner_preparation_cleanup=pass\n'
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
  printf 'runner_preparation=fail code=%s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE
command -v jq >/dev/null 2>&1 || fail JQ_UNAVAILABLE
[[ -x "$BROKER_SCRIPT" ]] || fail BROKER_SCRIPT_UNAVAILABLE

docker network inspect "$NETWORK" >/dev/null 2>&1 || fail NETWORK_UNAVAILABLE
for image in "$IMAGE_LEADER" "$IMAGE_IMPLEMENTOR" "$IMAGE_ASSESSOR"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail IMAGE_UNAVAILABLE
 done
for container in "$LEADER_CONTAINER" "$IMPLEMENTOR_CONTAINER" "$ASSESSOR_CONTAINER"; do
  if docker inspect "$container" >/dev/null 2>&1; then fail RESOURCE_ALREADY_EXISTS; fi
done

"$BROKER_SCRIPT" start >/dev/null
started_broker=1

export PREP_SMOKE_PROJECT_ID="$PROJECT_ID"
export PREP_SMOKE_IMPLEMENT_TASK_ID="$IMPLEMENT_TASK_ID"
export PREP_SMOKE_ASSESS_TASK_ID="$ASSESS_TASK_ID"
export PREP_SMOKE_LEADER_NAME="$LEADER_NAME"
export PREP_SMOKE_IMPLEMENTOR_NAME="$IMPLEMENTOR_NAME"
export PREP_SMOKE_ASSESSOR_NAME="$ASSESSOR_NAME"
export PREP_SMOKE_CREATED_AT="2026-08-03T14:00:00Z"
node --input-type=module <<'NODE'
import { writeFile } from "node:fs/promises";
import { createProjectBinding, createTaskBinding } from "./worker/agent/team/manifest.mjs";
import { sha256 } from "./worker/agent/canonical-json.mjs";
const project = createProjectBinding({
  projectId: process.env.PREP_SMOKE_PROJECT_ID,
  playbookId: "software-change-delivery", playbookVersion: "1.0.0", playbookDigest: sha256("runner-preparation-smoke-playbook"),
  requester: "@requester:example.test",
  roleBindings: {
    team_leader: process.env.PREP_SMOKE_LEADER_NAME,
    designer: `${process.env.PREP_SMOKE_PROJECT_ID}-designer`,
    implementor: process.env.PREP_SMOKE_IMPLEMENTOR_NAME,
    assessor: process.env.PREP_SMOKE_ASSESSOR_NAME,
    operator: `${process.env.PREP_SMOKE_PROJECT_ID}-operator`,
  },
  createdAt: process.env.PREP_SMOKE_CREATED_AT,
});
const common = {
  projectId: project.projectId, playbookStepId: "software-change-delivery-transition-v1", revisionIndex: 0,
  objective: "Prepare one fixed Runner binding for the focused boundary.",
  completionContractDigest: sha256("runner-preparation-smoke-contract"),
  sourceProfileDigest: sha256("runner-preparation-smoke-profile"),
  sourceSkillDigest: sha256("runner-preparation-smoke-skill"),
  createdAt: process.env.PREP_SMOKE_CREATED_AT,
};
const implement = createTaskBinding({
  ...common, taskId: process.env.PREP_SMOKE_IMPLEMENT_TASK_ID, taskKind: "implement",
  assignee: process.env.PREP_SMOKE_IMPLEMENTOR_NAME, sourceSkillId: "implementor-v1", inputRefs: [],
});
const assess = createTaskBinding({
  ...common, taskId: process.env.PREP_SMOKE_ASSESS_TASK_ID, taskKind: "assess",
  assignee: process.env.PREP_SMOKE_ASSESSOR_NAME, sourceSkillId: "assessor-v1", inputRefs: [implement.taskId],
});
await writeFile(process.env.IMPLEMENT_REQUEST, JSON.stringify({
  schemaVersion: 1, projectBinding: project, taskBinding: implement, inputTaskBinding: null,
}) + "\n", { mode: 0o600 });
await writeFile(process.env.ASSESS_REQUEST, JSON.stringify({
  schemaVersion: 1, projectBinding: project, taskBinding: assess, inputTaskBinding: implement,
}) + "\n", { mode: 0o600 });
NODE

for spec in \
  "$LEADER_CONTAINER $LEADER_NAME $IMAGE_LEADER" \
  "$IMPLEMENTOR_CONTAINER $IMPLEMENTOR_NAME $IMAGE_IMPLEMENTOR" \
  "$ASSESSOR_CONTAINER $ASSESSOR_NAME $IMAGE_ASSESSOR"; do
  read -r container worker image <<<"$spec"
  docker create --name "$container" --network "$NETWORK" \
    --label "io.tiangong.focused-run=${LABEL}" \
    --env "AGENTTEAMS_WORKER_NAME=${worker}" \
    --entrypoint /bin/sh "$image" -c 'sleep 600' >/dev/null
  docker start "$container" >/dev/null
done

docker cp "$IMPLEMENT_REQUEST" "$LEADER_CONTAINER:/tmp/implement.json"
docker cp "$ASSESS_REQUEST" "$LEADER_CONTAINER:/tmp/assess.json"
docker cp "$IMPLEMENT_REQUEST" "$IMPLEMENTOR_CONTAINER:/tmp/implement.json"
docker cp "$ASSESS_REQUEST" "$ASSESSOR_CONTAINER:/tmp/assess.json"

run_prepare() {
  local container="$1" file="$2"
  docker exec "$LEADER_CONTAINER" node --input-type=module -e \
    'import { readFile } from "node:fs/promises"; import { createRunnerBrokerPreparationClient } from "/opt/tiangong-worker/agent/runner/preparation-client.mjs"; const input = JSON.parse(await readFile("/tmp/" + process.argv[1] + ".json", "utf8")); const r = await createRunnerBrokerPreparationClient().prepare(input); console.log(JSON.stringify({ status:r.status, taskId:r.taskId, taskBindingDigest:r.taskBindingDigest, bindingDigest:r.bindingDigest, endpointDigest:r.endpointDigest, replayed:r.replayed }));' \
    "$file"
}

first="$(run_prepare "$LEADER_CONTAINER" implement)"
second="$(run_prepare "$LEADER_CONTAINER" implement)"
assessor="$(run_prepare "$LEADER_CONTAINER" assess)"
[[ "$(jq -r .status <<<"$first")" == ready && "$(jq -r .replayed <<<"$first")" == false ]] || fail IMPLEMENT_PREPARATION
[[ "$(jq -r .status <<<"$second")" == ready && "$(jq -r .replayed <<<"$second")" == true ]] || fail IMPLEMENT_REPLAY
[[ "$(jq -r .status <<<"$assessor")" == ready && "$(jq -r .replayed <<<"$assessor")" == false ]] || fail ASSESS_PREPARATION
[[ "$(jq -r .taskBindingDigest <<<"$first")" == "$(jq -r .taskBindingDigest <<<"$second")" ]] || fail REPLAY_DIGEST_CHANGED

for spec in "$IMPLEMENTOR_CONTAINER implement" "$ASSESSOR_CONTAINER assess"; do
  read -r container file <<<"$spec"
  output="$(docker exec "$container" node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { createRunnerBrokerExecutor } from "/opt/tiangong-worker/agent/runner/broker-client.mjs"; import { runnerRunIdForTask } from "/opt/tiangong-worker/agent/runner/runner-port.mjs"; const input = JSON.parse(await readFile("/tmp/" + process.argv[1] + ".json", "utf8")); const plan = await createRunnerBrokerExecutor({ endpoint:"http://tiangong-runner-broker:8787/v1/execute", taskId:input.taskBinding.taskId }).plan({ runId:runnerRunIdForTask(input.taskBinding) }); console.log(JSON.stringify({taskId:plan.taskId, command:plan.command, cwd:plan.cwd, timeoutMs:plan.timeoutMs, outputLimitBytes:plan.outputLimitBytes, planDigest:plan.contentDigest}));' "$file")"
  [[ "$(jq -r '.command|join(",")' <<<"$output")" == "node,probe.mjs" ]] || fail PLAN_COMMAND
  [[ "$(jq -r .timeoutMs <<<"$output")" == 30000 && "$(jq -r .outputLimitBytes <<<"$output")" == 65536 ]] || fail PLAN_BOUNDS
  if [[ "$file" == implement ]]; then [[ "$(jq -r .cwd <<<"$output")" == scratch/revision ]] || fail IMPLEMENT_CWD; else [[ "$(jq -r .cwd <<<"$output")" == fixture ]] || fail ASSESS_CWD; fi
done

for container in "$LEADER_CONTAINER" "$IMPLEMENTOR_CONTAINER" "$ASSESSOR_CONTAINER"; do
  mounts="$(docker inspect --format '{{json .Mounts}}' "$container")"
  jq -e 'all(.[]?; .Source != "/var/run/docker.sock" and .Destination != "/var/run/docker.sock")' <<<"$mounts" >/dev/null || fail WORKER_SOCKET_PRESENT
done
printf 'runner_preparation=pass\n'
