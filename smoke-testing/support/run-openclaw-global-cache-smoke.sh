#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly MANAGER_CONTAINER="${TIANGONG_AGENTTEAMS_MANAGER_CONTAINER:-agentteams-manager}"
readonly CONTROLLER_CONTAINER="${TIANGONG_AGENTTEAMS_CONTROLLER_CONTAINER:-agentteams-controller}"
readonly IMAGE="${TIANGONG_CODEX_CAPABILITY_IMAGE:-tiangong-worker-canary:dev}"
readonly NETWORK="${TIANGONG_AGENTTEAMS_NETWORK:-agentteams-net}"
readonly SUFFIX="$(date -u +%Y%m%d%H%M%S)-$$"
readonly WORKER_A="tiangong-codex-cache-a-${SUFFIX}"
readonly WORKER_B="tiangong-codex-cache-b-${SUFFIX}"
readonly CONTAINER_A="agentteams-worker-${WORKER_A}"
readonly CONTAINER_B="agentteams-worker-${WORKER_B}"
readonly STORAGE_PREFIX_A="agentteams/agentteams-storage/agents/${WORKER_A}/"
readonly STORAGE_PREFIX_B="agentteams/agentteams-storage/agents/${WORKER_B}/"
readonly MIRROR_A="/root/agentteams-fs/agents/${WORKER_A}"
readonly MIRROR_B="/root/agentteams-fs/agents/${WORKER_B}"
readonly MANIFEST_CONTAINER="/tmp/tiangong-codex-global-cache-${SUFFIX}.yaml"
readonly RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tiangong-codex-global-cache.XXXXXX")"
created=0

fail() { printf 'codex_global_cache_smoke=fail code=%s\n' "$1" >&2; exit 1; }
worker_json() { docker exec "${MANAGER_CONTAINER}" agt get workers "$1" -o json 2>/dev/null; }
container_exists() { docker container inspect "$1" >/dev/null 2>&1; }

purge_worker() {
  local name="$1" storage="$2" mirror="$3" container="$4"
  docker exec "${MANAGER_CONTAINER}" agt delete worker "${name}" >/dev/null 2>&1 || true
  docker exec "${CONTROLLER_CONTAINER}" mc rm --recursive --force "${storage}" >/dev/null 2>&1 || true
  docker exec "${CONTROLLER_CONTAINER}" rm -rf -- "${mirror}" >/dev/null 2>&1 || true
  docker exec "${MANAGER_CONTAINER}" rm -rf -- "${mirror}" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    if ! worker_json "${name}" >/dev/null 2>&1 && ! container_exists "${container}"; then break; fi
    sleep 1
  done
  worker_json "${name}" >/dev/null 2>&1 && return 1
  container_exists "${container}" && return 1
  docker exec "${CONTROLLER_CONTAINER}" mc ls "${storage}" 2>/dev/null | grep -q . && return 1 || true
  docker exec "${CONTROLLER_CONTAINER}" test ! -e "${mirror}" || return 1
  docker exec "${MANAGER_CONTAINER}" test ! -e "${mirror}" || return 1
}

cleanup() {
  local status=$?
  set +e
  rm -rf -- "${RUN_ROOT}"
  docker exec "${MANAGER_CONTAINER}" rm -f "${MANIFEST_CONTAINER}" >/dev/null 2>&1 || true
  if ((created == 1)); then
    purge_worker "${WORKER_A}" "${STORAGE_PREFIX_A}" "${MIRROR_A}" "${CONTAINER_A}" || status=1
    purge_worker "${WORKER_B}" "${STORAGE_PREFIX_B}" "${MIRROR_B}" "${CONTAINER_B}" || status=1
  fi
  if ((status == 0)); then
    printf 'codex_global_cache_cleanup=pass workers=%s,%s\n' "${WORKER_A}" "${WORKER_B}"
  else
    printf 'codex_global_cache_cleanup=fail\n' >&2
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

[[ "${TIANGONG_RUN_REAL:-0}" == 1 ]] || fail REAL_RUN_DISABLED
docker info >/dev/null 2>&1 || fail DOCKER_UNAVAILABLE
docker container inspect "${MANAGER_CONTAINER}" >/dev/null 2>&1 || fail MANAGER_MISSING
docker container inspect "${CONTROLLER_CONTAINER}" >/dev/null 2>&1 || fail CONTROLLER_MISSING
docker network inspect "${NETWORK}" >/dev/null 2>&1 || fail NETWORK_MISSING
docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail IMAGE_MISSING
bash "${REPO_ROOT}/scripts/deploy-codex-capability-cache.sh" status | grep -Fq 'running=true' || fail CACHE_SERVICE_NOT_READY
worker_json "${WORKER_A}" >/dev/null 2>&1 && fail WORKER_A_EXISTS
worker_json "${WORKER_B}" >/dev/null 2>&1 && fail WORKER_B_EXISTS
container_exists "${CONTAINER_A}" && fail CONTAINER_A_EXISTS
container_exists "${CONTAINER_B}" && fail CONTAINER_B_EXISTS

cat >"${RUN_ROOT}/workers.yaml" <<EOF
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: ${WORKER_A}
spec:
  model: codex/deepseek-v4-pro
  runtime: openclaw
  image: ${IMAGE}
  state: Running
  identity: |
    Name: Tiangong global capability cache smoke A
    Purpose: Disposable two-Worker shared capability cache verification.
---
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: ${WORKER_B}
spec:
  model: codex/deepseek-v4-pro
  runtime: openclaw
  image: ${IMAGE}
  state: Running
  identity: |
    Name: Tiangong global capability cache smoke B
    Purpose: Disposable two-Worker shared capability cache verification.
EOF
docker exec -i "${MANAGER_CONTAINER}" sh -c 'umask 077; cat >"$1"' _ "${MANIFEST_CONTAINER}" <"${RUN_ROOT}/workers.yaml"
created=1
timeout 45 docker exec "${MANAGER_CONTAINER}" agt apply -f "${MANIFEST_CONTAINER}" >/dev/null || fail APPLY_REJECTED

for worker in "${WORKER_A}" "${WORKER_B}"; do
  for _ in $(seq 1 90); do
    container_exists "agentteams-worker-${worker}" && break
    sleep 2
  done
  container_exists "agentteams-worker-${worker}" || fail "${worker}_CONTAINER_MISSING"
  docker container inspect "agentteams-worker-${worker}" --format '{{json .NetworkSettings.Networks}}' | jq -e --arg network "${NETWORK}" 'has($network)' >/dev/null || fail "${worker}_NETWORK_MISSING"
done

for _ in $(seq 1 100); do
  phase_a="$(worker_json "${WORKER_A}" | jq -r '.phase // empty' 2>/dev/null || true)"
  phase_b="$(worker_json "${WORKER_B}" | jq -r '.phase // empty' 2>/dev/null || true)"
  logs_a="$(docker logs "${CONTAINER_A}" 2>&1 || true)"
  logs_b="$(docker logs "${CONTAINER_B}" 2>&1 || true)"
  if [[ "${phase_a}" == Running && "${phase_b}" == Running &&
        "${logs_a}" == *"codex_capability_cache=pass"* && "${logs_b}" == *"codex_capability_cache=pass"* &&
        "${logs_a}" == *"codex_gateway_preflight=pass"* && "${logs_b}" == *"codex_gateway_preflight=pass"* &&
        "${logs_a}" == *"tiangong_preflight=pass"* && "${logs_b}" == *"tiangong_preflight=pass"* ]]; then
    break
  fi
  [[ "${phase_a}" == Failed || "${phase_b}" == Failed ]] && fail WORKER_PREFLIGHT_FAILED
  sleep 2
done
[[ "${phase_a}" == Running && "${phase_b}" == Running ]] || fail WORKER_READY_TIMEOUT

grep -F "codex_capability_cache=pass" <<<"${logs_a}" | tail -n 1 >"${RUN_ROOT}/cache-a.log"
grep -F "codex_capability_cache=pass" <<<"${logs_b}" | tail -n 1 >"${RUN_ROOT}/cache-b.log"
cat "${RUN_ROOT}/cache-a.log" "${RUN_ROOT}/cache-b.log"
hits="$(cat "${RUN_ROOT}/cache-a.log" "${RUN_ROOT}/cache-b.log" | grep -oE 'hit=(true|false)' | sort | tr '\n' ' ')"
[[ "${hits}" == *'hit=false'* && "${hits}" == *'hit=true'* ]] || fail "EXPECTED_ONE_MISS_ONE_HIT:${hits}"

record="$(docker run --rm --mount type=volume,src=tiangong-codex-capability-cache,dst=/var/lib/tiangong-capabilities,readonly --entrypoint node "${IMAGE}" --input-type=module -e "import { readFile } from 'node:fs/promises'; const v=JSON.parse(await readFile('/var/lib/tiangong-capabilities/codex.json','utf8')); console.log(JSON.stringify({entries:v.entries.length, routes:v.entries.map((entry)=>entry.transport), hasCredential:JSON.stringify(v).includes('token')||JSON.stringify(v).includes('secret')}));")" || fail CACHE_READ_FAILED
[[ "$(jq -er '.entries' <<<"${record}")" == 1 ]] || fail CACHE_ENTRY_COUNT
[[ "$(jq -er '.hasCredential' <<<"${record}")" == false ]] || fail CACHE_CONTAINS_CREDENTIAL
printf 'codex_global_cache_smoke=pass workers=%s,%s cache=%s\n' "${WORKER_A}" "${WORKER_B}" "${record}"
