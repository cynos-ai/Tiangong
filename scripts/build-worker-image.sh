#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker:dev"
readonly CANARY_IMAGE="tiangong-worker-canary:dev"
readonly LEADER_IMAGE="tiangong-worker-leader:dev"
readonly DESIGNER_IMAGE="tiangong-worker-designer:dev"
readonly IMPLEMENTOR_IMAGE="tiangong-worker-implementor:dev"
readonly ASSESSOR_IMAGE="tiangong-worker-assessor:dev"
readonly OPERATOR_IMAGE="tiangong-worker-operator:dev"
readonly RUNNER_BROKER_IMAGE="tiangong-runner-broker:dev"
readonly DEPLOYMENT_SERVICE_IMAGE="tiangong-deployment-service:dev"
readonly DEPLOYMENT_BROKER_IMAGE="tiangong-deployment-broker:dev"
readonly CODEX_CAPABILITY_CACHE_IMAGE="tiangong-codex-capability-cache:dev"
readonly OPENCODEX_SIDECAR_IMAGE="tiangong-opencodex-sidecar:dev"
readonly OPENCODEX_RECEIPT_SERVICE_IMAGE="tiangong-opencodex-receipt-service:dev"
readonly OPENCODEX_ADAPTER_IMAGE="tiangong-opencodex-adapter:dev"
readonly EXPECTED_NODE_VERSION="v22.23.2"
readonly EXPECTED_PI_VERSION="0.82.0"
readonly EXPECTED_CODEX_VERSION="codex-cli 0.120.0"
readonly EXPECTED_GIT_VERSION="git version 2.43.0"
readonly EXPECTED_UTIL_LINUX_VERSION="2.39.3"
readonly EXPECTED_DOCKER_CLI_VERSION="28.3.3"

command -v docker >/dev/null 2>&1 || {
  printf 'ERROR: docker is required.\n' >&2
  exit 1
}

docker info >/dev/null 2>&1 || {
  printf 'ERROR: the Docker daemon is unavailable.\n' >&2
  exit 1
}

build_args=(--pull --build-context "team_playbooks=${REPO_ROOT}/team-playbooks")
if [[ -n "${TIANGONG_OTEL_EXPORTER_ENDPOINT:-}" ]]; then
  build_args+=(--build-arg "TIANGONG_OTEL_EXPORTER_ENDPOINT=${TIANGONG_OTEL_EXPORTER_ENDPOINT}")
fi

printf '[Tiangong] Building %s\n' "${IMAGE}"
docker build "${build_args[@]}" --target default --tag "${IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building isolated OpenClaw canary image %s\n' "${CANARY_IMAGE}"
docker build "${build_args[@]}" --target canary --tag "${CANARY_IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building leader profile image %s\n' "${LEADER_IMAGE}"
docker build "${build_args[@]}" --target leader --tag "${LEADER_IMAGE}" "${REPO_ROOT}/worker"
for role in designer implementor assessor operator; do
  image_var="${role^^}_IMAGE"
  image="${!image_var}"
  printf '[Tiangong] Building %s profile image %s\n' "${role}" "${image}"
  docker build "${build_args[@]}" --target "${role}" --tag "${image}" "${REPO_ROOT}/worker"
done
printf '[Tiangong] Building controlled Runner broker image %s\n' "${RUNNER_BROKER_IMAGE}"
docker build "${build_args[@]}" --target runner-broker --tag "${RUNNER_BROKER_IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building disposable deployment service image %s\n' "${DEPLOYMENT_SERVICE_IMAGE}"
docker build "${build_args[@]}" --target deployment-service --tag "${DEPLOYMENT_SERVICE_IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building controlled deployment broker image %s\n' "${DEPLOYMENT_BROKER_IMAGE}"
docker build "${build_args[@]}" --target deployment-broker --tag "${DEPLOYMENT_BROKER_IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building deployment-owned Codex capability cache image %s\n' "${CODEX_CAPABILITY_CACHE_IMAGE}"
docker build "${build_args[@]}" --target codex-capability-cache --tag "${CODEX_CAPABILITY_CACHE_IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building deployment-owned OpenCodex sidecar image %s\n' "${OPENCODEX_SIDECAR_IMAGE}"
docker build "${build_args[@]}" --target opencodex-sidecar --tag "${OPENCODEX_SIDECAR_IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building OpenCodex receipt service image %s\n' "${OPENCODEX_RECEIPT_SERVICE_IMAGE}"
docker build "${build_args[@]}" --target opencodex-receipt-service --tag "${OPENCODEX_RECEIPT_SERVICE_IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building OpenCodex AgentTeams adapter image %s\n' "${OPENCODEX_ADAPTER_IMAGE}"
docker build "${build_args[@]}" --target opencodex-adapter --tag "${OPENCODEX_ADAPTER_IMAGE}" "${REPO_ROOT}/worker"

actual_node_version="$(docker run --rm --entrypoint node "${IMAGE}" --version)"
[[ "${actual_node_version}" == "${EXPECTED_NODE_VERSION}" ]] || {
  printf 'ERROR: expected Node.js %s, got %s.\n' "${EXPECTED_NODE_VERSION}" "${actual_node_version}" >&2
  exit 1
}

actual_docker_cli_version="$(docker run --rm --entrypoint /usr/local/bin/docker "${RUNNER_BROKER_IMAGE}" --version | awk '{print $3}' | tr -d ',')"
[[ "${actual_docker_cli_version}" == "${EXPECTED_DOCKER_CLI_VERSION}" ]] || {
  printf 'ERROR: expected Runner broker Docker CLI %s, got %s.\n' "${EXPECTED_DOCKER_CLI_VERSION}" "${actual_docker_cli_version}" >&2
  exit 1
}

actual_pi_version="$(docker run --rm --entrypoint pi "${IMAGE}" --version)"
[[ "${actual_pi_version}" == "${EXPECTED_PI_VERSION}" ]] || {
  printf 'ERROR: expected pi %s, got %s.\n' "${EXPECTED_PI_VERSION}" "${actual_pi_version}" >&2
  exit 1
}

# `bin/codex` is the runtime app-server entrypoint and intentionally requires
# the in-memory gateway environment. Inspect the managed CLI package directly
# for the image-version contract instead of starting that runtime wrapper.
actual_codex_version="$(docker run --rm --entrypoint /opt/tiangong-worker/node_modules/.bin/codex "${CANARY_IMAGE}" --version)"
[[ "${actual_codex_version}" == "${EXPECTED_CODEX_VERSION}" ]] || {
  printf 'ERROR: expected managed Codex %s, got %s.\n' "${EXPECTED_CODEX_VERSION}" "${actual_codex_version}" >&2
  exit 1
}
actual_opencodex_version="$(docker run --rm --entrypoint ocx "${OPENCODEX_SIDECAR_IMAGE}" --version)"
[[ "${actual_opencodex_version}" == *"2.15.0"* ]] || {
  printf 'ERROR: expected OpenCodex 2.15.0, got %s.\n' "${actual_opencodex_version}" >&2
  exit 1
}
# Probe the managed CLI's app-server directly; the `bin/codex` wrapper is the
# credential-gated runtime entrypoint and is not a build-time health probe.
docker run --rm --workdir /opt/tiangong-worker \
  --env OPENCLAW_CODEX_APP_SERVER_BIN=/opt/tiangong-worker/node_modules/.bin/codex \
  --entrypoint node "${CANARY_IMAGE}" \
  scripts/probe-codex-app-server.mjs

actual_git_version="$(docker run --rm --entrypoint /usr/bin/git "${IMAGE}" --version)"
[[ "${actual_git_version}" == "${EXPECTED_GIT_VERSION}" ]] || {
  printf 'ERROR: expected Git %s, got %s.\n' "${EXPECTED_GIT_VERSION}" "${actual_git_version}" >&2
  exit 1
}
actual_prlimit_version="$(docker run --rm --entrypoint /usr/bin/prlimit "${IMAGE}" --version | head -n 1)"
[[ "${actual_prlimit_version}" == "prlimit from util-linux ${EXPECTED_UTIL_LINUX_VERSION}" ]] || {
  printf 'ERROR: expected prlimit from util-linux %s, got %s.\n' "${EXPECTED_UTIL_LINUX_VERSION}" "${actual_prlimit_version}" >&2
  exit 1
}
actual_flock_version="$(docker run --rm --entrypoint /usr/bin/flock "${IMAGE}" --version | head -n 1)"
[[ "${actual_flock_version}" == "flock from util-linux ${EXPECTED_UTIL_LINUX_VERSION}" ]] || {
  printf 'ERROR: expected flock from util-linux %s, got %s.\n' "${EXPECTED_UTIL_LINUX_VERSION}" "${actual_flock_version}" >&2
  exit 1
}

docker run --rm --workdir /opt/tiangong-worker --entrypoint node "${IMAGE}" \
  --input-type=module -e '
    import {
      createWorkerObservability,
      resolveObservabilityConfig,
    } from "./observability/tracing.mjs";
    const config = resolveObservabilityConfig(undefined, process.env);
    const expected = Boolean(process.env.TIANGONG_OTEL_EXPORTER_ENDPOINT);
    if (config.enabled !== expected) process.exit(1);
    const observability = createWorkerObservability({ config });
    await observability.shutdown();
  '
reconciliation_help="$(docker run --rm --entrypoint tiangong-reconcile "${IMAGE}" --help)"
grep -Fq 'tiangong-reconcile inspect' <<<"${reconciliation_help}" || {
  printf 'ERROR: the Worker reconciliation entrypoint is unavailable.\n' >&2
  exit 1
}
work_run_recovery_help="$(docker run --rm --entrypoint tiangong-work-run "${IMAGE}" --help)"
grep -Fq 'tiangong-work-run inspect' <<<"${work_run_recovery_help}" || {
  printf 'ERROR: the WorkRun recovery entrypoint is unavailable.\n' >&2
  exit 1
}
retention_help="$(docker run --rm --entrypoint tiangong-retain "${IMAGE}" --help)"
grep -Fq 'tiangong-retain compact' <<<"${retention_help}" || {
  printf 'ERROR: the Worker retention entrypoint is unavailable.\n' >&2
  exit 1
}

kernel_profile="$(docker run --rm --entrypoint node "${IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role kernel)"
leader_profile="$(docker run --rm --entrypoint node "${LEADER_IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role leader)"
designer_profile="$(docker run --rm --entrypoint node "${DESIGNER_IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role designer)"
implementor_profile="$(docker run --rm --entrypoint node "${IMPLEMENTOR_IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role implementor)"
assessor_profile="$(docker run --rm --entrypoint node "${ASSESSOR_IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role assessor)"
operator_profile="$(docker run --rm --entrypoint node "${OPERATOR_IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role operator)"
docker run --rm --workdir /opt/tiangong-worker --entrypoint node "${LEADER_IMAGE}" \
  --input-type=module -e '
    const [
      { loadFixedRoleProfileBundle },
      { readPlaybookManifest },
      { TeamCoordinationGate },
      { createLeaderToolRegistry },
    ] = await Promise.all([
      import("./agent/config/role-profile.mjs"),
      import("./agent/playbook/resolver.mjs"),
      import("./agent/team/tool-wrapper.mjs"),
      import("./agent/work/leader-tools.mjs"),
    ]);
    const profileBundle = await loadFixedRoleProfileBundle();
    if (profileBundle.profile.roleId !== "leader") process.exit(1);
    const playbook = readPlaybookManifest("software-change-delivery");
    const registry = createLeaderToolRegistry({
      playbook,
      deps: {
        rootDir: "/root/agentteams-fs/shared",
        env: { AGENTTEAMS_WORKER_NAME: "tiangong-leader" },
        gate: new TeamCoordinationGate(),
        evidence: { append: async () => {} },
        getInvocation: () => { throw new Error("image contract does not execute tools"); },
      },
    });
    if (registry.names().join(",") !== "team_create_project,team_dispatch_task,team_check_result,team_decide_task,team_report") process.exit(1);
  '
node -e '
  const [kernel, leader, ...professionals] = process.argv.slice(1).map(JSON.parse);
  if (kernel.roleId !== "kernel" || kernel.runtimeReady !== true) process.exit(1);
  if (leader.roleId !== "leader" || leader.runtimeReady !== true) process.exit(1);
  if (leader.toolIds.join(",") !== "team_create_project,team_dispatch_task,team_check_result,team_decide_task,team_report") process.exit(1);
  if (professionals.map((profile) => profile.roleId).join(",") !== "designer,implementor,assessor,operator") process.exit(1);
  const expectedProfessionalTools = {
    designer: "team_resolve_task,team_submit_result",
    implementor: "team_resolve_task,run_command,team_submit_result",
    assessor: "team_resolve_task,run_test_command,team_submit_result",
    operator: "team_resolve_task,deploy_release,team_submit_result",
  };
  if (professionals.some((profile) => profile.runtimeReady !== true || profile.toolIds.join(",") !== expectedProfessionalTools[profile.roleId])) process.exit(1);
' "${kernel_profile}" "${leader_profile}" "${designer_profile}" "${implementor_profile}" "${assessor_profile}" "${operator_profile}"

printf '[Tiangong] Worker image ready: %s (Node.js %s, pi %s, fixed core profile)\n' \
  "${IMAGE}" "${actual_node_version}" "${actual_pi_version}"
printf '[Tiangong] Leader profile image validated: %s (runtimeReady=true; closed coordination tool surface)\n' \
  "${LEADER_IMAGE}"
printf '[Tiangong] Professional profile images validated: %s, %s, %s, %s (runtimeReady=true; role-scoped closed tools)\n' \
  "${DESIGNER_IMAGE}" "${IMPLEMENTOR_IMAGE}" "${ASSESSOR_IMAGE}" "${OPERATOR_IMAGE}"
printf '[Tiangong] Runner broker image validated: %s (Docker CLI %s; socket authority isolated from Workers)\n' \
  "${RUNNER_BROKER_IMAGE}" "${actual_docker_cli_version}"
