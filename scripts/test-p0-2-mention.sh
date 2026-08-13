#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly RUNNER="${REPO_ROOT}/smoke-testing/support/run-p0-2-mention-delivery.sh"
readonly CONTRACT="${REPO_ROOT}/smoke-testing/support/p0-2-mention-contract.mjs"
readonly TEAM_FIXTURE="${REPO_ROOT}/smoke-testing/fixtures/p0-2-mention-team.yaml"
readonly WORKER_FIXTURE="${REPO_ROOT}/smoke-testing/fixtures/p0-2-mention-workers.yaml"
readonly GENERATED_ENV="${TIANGONG_GENERATED_ENV:-${REPO_ROOT}/.runtime/agentteams/manager.env}"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for path in "${RUNNER}" "${CONTRACT}" "${TEAM_FIXTURE}" "${WORKER_FIXTURE}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || fail "required P0.2 asset is missing or symlinked: ${path}"
done
[[ -x "${RUNNER}" ]] || fail 'P0.2 runner must be executable.'
bash -n "${RUNNER}"
node --check "${CONTRACT}"
node "${CONTRACT}"

for required in 'p0_2_dashboard_mention_no_turn=pass' 'p0_2_replay_same_event_id=pass' \
  'p0_2_rich_mention_wakes_worker=pass' 'p0_2_worker_reply_echo_sender_preserved=pass' \
  'p0_2_wire_format_and_delivery_contract=pass' 'assert_no_turn' 'assert_turn'; do
  grep -Fq -- "${required}" "${RUNNER}" || fail "runner is missing required P0.2 contract: ${required}"
done
if grep -Eqi 'password|access_token|apiKey|secret|token:' "${TEAM_FIXTURE}" "${WORKER_FIXTURE}"; then
  fail 'P0.2 fixtures contain credential-bearing fields.'
fi
[[ "$(grep -Ec '^  runtime: copaw$' "${WORKER_FIXTURE}")" == 1 ]] || fail 'P0.2 fixture must have one stock Leader.'
[[ "$(grep -Ec '^  runtime: openclaw$' "${WORKER_FIXTURE}")" == 1 ]] || fail 'P0.2 fixture must have one Tiangong Worker.'

if [[ "${TIANGONG_RUN_REAL:-0}" == 1 ]]; then
  [[ -f "${GENERATED_ENV}" && ! -L "${GENERATED_ENV}" ]] || fail 'real P0.2 run requires the generated AgentTeams environment.'
  mode="$(stat -c '%a' "${GENERATED_ENV}" 2>/dev/null || stat -f '%Lp' "${GENERATED_ENV}")"
  [[ "${mode}" == 600 ]] || fail 'generated AgentTeams environment must be mode 600.'
  value() { awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit}' "${GENERATED_ENV}"; }
  gateway_port="$(value AGENTTEAMS_PORT_GATEWAY)"
  matrix_domain="$(value AGENTTEAMS_MATRIX_DOMAIN)"
  admin_user="$(value AGENTTEAMS_ADMIN_USER)"
  admin_password="$(value AGENTTEAMS_ADMIN_PASSWORD)"
  export AGENTTEAMS_MATRIX_URL="http://127.0.0.1:${gateway_port}"
  export AGENTTEAMS_MATRIX_DOMAIN="${matrix_domain}"
  export AGENTTEAMS_ADMIN_USER="${admin_user}"
  export AGENTTEAMS_ADMIN_PASSWORD="${admin_password}"
  [[ -n "${AGENTTEAMS_MATRIX_DOMAIN}" && -n "${AGENTTEAMS_ADMIN_USER}" && -n "${AGENTTEAMS_ADMIN_PASSWORD}" ]] || \
    fail 'generated Matrix environment is incomplete.'
  "${RUNNER}"
fi

printf 'P0.2 mention-gating and delivery contract tests passed.\n'
