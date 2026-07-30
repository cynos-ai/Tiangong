#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly IMAGE="tiangong-worker:dev"
readonly REVIEWER_IMAGE="tiangong-worker-reviewer:dev"
readonly EXPECTED_NODE_VERSION="v22.23.1"
readonly EXPECTED_PI_VERSION="0.82.0"

command -v docker >/dev/null 2>&1 || {
  printf 'ERROR: docker is required.\n' >&2
  exit 1
}

docker info >/dev/null 2>&1 || {
  printf 'ERROR: the Docker daemon is unavailable.\n' >&2
  exit 1
}

build_args=(--pull)
if [[ -n "${TIANGONG_OTEL_EXPORTER_ENDPOINT:-}" ]]; then
  build_args+=(--build-arg "TIANGONG_OTEL_EXPORTER_ENDPOINT=${TIANGONG_OTEL_EXPORTER_ENDPOINT}")
fi

printf '[Tiangong] Building %s\n' "${IMAGE}"
docker build "${build_args[@]}" --target default --tag "${IMAGE}" "${REPO_ROOT}/worker"
printf '[Tiangong] Building trusted profile image %s\n' "${REVIEWER_IMAGE}"
docker build "${build_args[@]}" --target reviewer --tag "${REVIEWER_IMAGE}" "${REPO_ROOT}/worker"

actual_node_version="$(docker run --rm --entrypoint node "${IMAGE}" --version)"
[[ "${actual_node_version}" == "${EXPECTED_NODE_VERSION}" ]] || {
  printf 'ERROR: expected Node.js %s, got %s.\n' "${EXPECTED_NODE_VERSION}" "${actual_node_version}" >&2
  exit 1
}

actual_pi_version="$(docker run --rm --entrypoint pi "${IMAGE}" --version)"
[[ "${actual_pi_version}" == "${EXPECTED_PI_VERSION}" ]] || {
  printf 'ERROR: expected pi %s, got %s.\n' "${EXPECTED_PI_VERSION}" "${actual_pi_version}" >&2
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
retention_help="$(docker run --rm --entrypoint tiangong-retain "${IMAGE}" --help)"
grep -Fq 'tiangong-retain compact' <<<"${retention_help}" || {
  printf 'ERROR: the Worker retention entrypoint is unavailable.\n' >&2
  exit 1
}

kernel_profile="$(docker run --rm --entrypoint node "${IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role kernel)"
reviewer_profile="$(docker run --rm --entrypoint node "${REVIEWER_IMAGE}" \
  /opt/tiangong-worker/scripts/check-role-profile.mjs --expect-role reviewer)"
node -e '
  const [kernel, reviewer] = process.argv.slice(1).map(JSON.parse);
  if (kernel.roleId !== "kernel" || kernel.runtimeReady !== true) process.exit(1);
  if (reviewer.roleId !== "reviewer" || reviewer.runtimeReady !== false) process.exit(1);
  if (reviewer.toolIds.join(",") !== "start_work,extend_scope,read,check_completion,abandon_work") process.exit(1);
' "${kernel_profile}" "${reviewer_profile}"

printf '[Tiangong] Worker image ready: %s (Node.js %s, pi %s, fixed kernel profile)\n' \
  "${IMAGE}" "${actual_node_version}" "${actual_pi_version}"
printf '[Tiangong] Reviewer profile image validated: %s (runtimeReady=false for this PR boundary)\n' \
  "${REVIEWER_IMAGE}"
