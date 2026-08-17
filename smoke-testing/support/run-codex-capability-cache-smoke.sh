#!/usr/bin/env bash
set -Eeuo pipefail

readonly IMAGE="${TIANGONG_CODEX_CAPABILITY_IMAGE:-tiangong-worker-canary:dev}"
readonly VOLUME="tiangong-codex-capability-smoke-${BASHPID}"
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tiangong-codex-capability.XXXXXX")"
readonly RUN_ROOT
readonly CACHE_DIR="/var/lib/tiangong-capabilities"

cleanup() {
  rm -rf -- "${RUN_ROOT}"
  docker volume rm "${VOLUME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || { printf 'docker is required.\n' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'jq is required.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'Docker daemon is unavailable.\n' >&2; exit 1; }
docker image inspect "${IMAGE}" >/dev/null 2>&1 || {
  printf 'Missing canary image: %s\n' "${IMAGE}" >&2
  exit 1
}
docker volume create "${VOLUME}" >/dev/null

run_probe() {
  docker run --rm -i \
    --volume "${VOLUME}:${CACHE_DIR}" \
    --entrypoint node "${IMAGE}" --input-type=module
}

run_probe >"${RUN_ROOT}/caller-a.json" 2>"${RUN_ROOT}/caller-a.err" <<'NODE' &
import { createCodexCapabilityCache } from "file:///opt/tiangong-worker/agent/preflight/codex-capability-cache.mjs";

const cache = createCodexCapabilityCache({
  path: "/var/lib/tiangong-capabilities/codex.json",
  ttlMs: 60_000,
  pollMs: 10,
});
const result = await cache.resolve({
  provider: "agentteams-gateway",
  model: "smoke/model",
  baseUrl: "http://agentteams-controller:8080/v1",
  detectorVersion: "responses-probe-v1",
  probe: async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { outcome: "supported", reasonCode: "responses-supported", status: 200, transport: "native-responses" };
  },
});
console.log(JSON.stringify({ cacheHit: result.cacheHit, key: result.record.key, transport: result.record.transport }));
NODE
pid_a=$!

run_probe >"${RUN_ROOT}/caller-b.json" 2>"${RUN_ROOT}/caller-b.err" <<'NODE' &
import { createCodexCapabilityCache } from "file:///opt/tiangong-worker/agent/preflight/codex-capability-cache.mjs";

const cache = createCodexCapabilityCache({
  path: "/var/lib/tiangong-capabilities/codex.json",
  ttlMs: 60_000,
  pollMs: 10,
});
const result = await cache.resolve({
  provider: "agentteams-gateway",
  model: "smoke/model",
  baseUrl: "http://agentteams-controller:8080/v1",
  detectorVersion: "responses-probe-v1",
  probe: async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { outcome: "supported", reasonCode: "responses-supported", status: 200, transport: "native-responses" };
  },
});
console.log(JSON.stringify({ cacheHit: result.cacheHit, key: result.record.key, transport: result.record.transport }));
NODE
pid_b=$!

set +e
wait "${pid_a}"
status_a=$?
wait "${pid_b}"
status_b=$?
set -e
if ((status_a != 0 || status_b != 0)); then
  cat "${RUN_ROOT}/caller-a.err" "${RUN_ROOT}/caller-b.err" >&2
  exit 1
fi
[[ ! -s "${RUN_ROOT}/caller-a.err" && ! -s "${RUN_ROOT}/caller-b.err" ]] || {
  cat "${RUN_ROOT}/caller-a.err" "${RUN_ROOT}/caller-b.err" >&2
  exit 1
}

mapfile -t results < <(jq -s -c '.[].cacheHit' "${RUN_ROOT}/caller-a.json" "${RUN_ROOT}/caller-b.json")
[[ "${#results[@]}" == 2 && "${results[*]}" == *false* && "${results[*]}" == *true* ]] || {
  printf 'Expected one cache miss and one cache hit; got %s.\n' "${results[*]}" >&2
  exit 1
}
key_a="$(jq -er '.key' "${RUN_ROOT}/caller-a.json")"
key_b="$(jq -er '.key' "${RUN_ROOT}/caller-b.json")"
[[ "${key_a}" == "${key_b}" ]] || { printf 'Concurrent callers selected different cache keys.\n' >&2; exit 1; }
jq -e 'select(.transport == "native-responses")' "${RUN_ROOT}/caller-a.json" >/dev/null
jq -e 'select(.transport == "native-responses")' "${RUN_ROOT}/caller-b.json" >/dev/null

cache_record="$(docker run --rm -i \
  --volume "${VOLUME}:${CACHE_DIR}:ro" \
  --entrypoint node "${IMAGE}" --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
const value = JSON.parse(await readFile("/var/lib/tiangong-capabilities/codex.json", "utf8"));
console.log(JSON.stringify({
  schemaVersion: value.schemaVersion,
  entries: value.entries.length,
  hasCredential: JSON.stringify(value).includes("token") || JSON.stringify(value).includes("secret"),
}));
NODE
)"
[[ "$(jq -er '.schemaVersion' <<<"${cache_record}")" == 1 ]] || exit 1
[[ "$(jq -er '.entries' <<<"${cache_record}")" == 1 ]] || exit 1
[[ "$(jq -er '.hasCredential' <<<"${cache_record}")" == false ]] || exit 1

printf 'Codex capability shared-volume smoke passed: one probe, one cache hit, one sanitized record.\n'
