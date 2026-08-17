#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly RUNNER="${REPO_ROOT}/smoke-testing/support/run-specialist-leader-handoff.sh"
readonly VALIDATOR="${REPO_ROOT}/smoke-testing/support/matrix-specialist-handoff.mjs"
readonly CONTRACT_TEST="${REPO_ROOT}/smoke-testing/support/matrix-specialist-handoff.test.mjs"
readonly PROBE_TEST="${REPO_ROOT}/worker/test/handoff-transport-probe.test.mjs"
readonly CHANNEL_TEST="${REPO_ROOT}/worker/test/specialist-handoff-channel.test.mjs"
readonly TEAM_FIXTURE="${REPO_ROOT}/smoke-testing/fixtures/specialist-handoff-smoke-team.yaml"
readonly WORKER_FIXTURE="${REPO_ROOT}/smoke-testing/fixtures/specialist-handoff-smoke-workers.yaml"
readonly GENERATED_ENV="${TIANGONG_GENERATED_ENV:-${REPO_ROOT}/.runtime/agentteams/manager.env}"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for path in "${RUNNER}" "${VALIDATOR}" "${CONTRACT_TEST}" "${PROBE_TEST}" \
  "${CHANNEL_TEST}" "${TEAM_FIXTURE}" "${WORKER_FIXTURE}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || fail "required handoff asset is missing or symlinked: ${path}"
done
[[ -x "${RUNNER}" ]] || fail 'handoff runner must be executable.'
bash -n "${RUNNER}"
bash -n "${SCRIPT_DIR}/../smoke-testing/support/matrix-specialist-handoff-aliases.sh"
for path in "${VALIDATOR}" "${CONTRACT_TEST}" "${PROBE_TEST}" "${CHANNEL_TEST}"; do
  node --check "${path}"
done

node --test "${CONTRACT_TEST}" "${PROBE_TEST}" "${CHANNEL_TEST}" >/tmp/tiangong-specialist-handoff-contract.log
cat /tmp/tiangong-specialist-handoff-contract.log
rm -f /tmp/tiangong-specialist-handoff-contract.log

for required in \
  'TG_HANDOFF_START work=' \
  'TG_HANDOFF_SENDER_ACK transaction_id=' \
  'stock_session_snapshot' \
  'leader_room_messages' \
  'handoff_specialist_sender_ack=pass' \
  'handoff_invalid_reference_fail_closed=pass' \
  'handoff_leader_receipt=pass' \
  "assert_no_work_admission \"\${work_id}\" \"\${intent_id}\"" \
  'handoff_agent_communication_not_human_work=pass' \
  "assert_trace_complete \"\${source_event_id}\" specialist_handoff handoff.transport.sent" \
  'read -r sender_transaction_id handoff_event_id replay_event_id'; do
  grep -Fq -- "${required}" "${RUNNER}" || fail "runner is missing required handoff contract: ${required}"
done
grep -Fq -- 'com.tiangong.handoff' "${REPO_ROOT}/worker/agent/team/channel-adapter.mjs" || \
  fail 'channel adapter is missing the namespaced handoff reference.'
grep -Fq -- '{"action":"NO_REPLY"}' "${REPO_ROOT}/worker/agent/runtime.mjs" || \
  fail 'handoff runtime is missing the official OpenClaw no-reply envelope.'
if grep -Eqi 'password|access_token|apiKey|secret|token:' "${TEAM_FIXTURE}" "${WORKER_FIXTURE}"; then
  fail 'handoff fixtures contain credential-bearing fields.'
fi
for identity in \
  tiangong-specialist-handoff \
  tiangong-specialist-handoff-leader \
  tiangong-specialist-handoff-specialist \
  tiangong-specialist-handoff-observer; do
  grep -Fq -- "${identity}" "${TEAM_FIXTURE}" "${WORKER_FIXTURE}" || \
    fail "handoff fixture omitted ${identity}."
done
[[ "$(grep -Ec '^  runtime: copaw$' "${WORKER_FIXTURE}")" == 1 ]] || fail 'handoff fixture must have one stock Leader.'
[[ "$(grep -Ec '^  runtime: openclaw$' "${WORKER_FIXTURE}")" == 2 ]] || fail 'handoff fixture must have two Tiangong Workers.'
[[ "$(grep -Fc 'dmDenyExtra:' "${WORKER_FIXTURE}")" == 1 ]] || fail 'handoff fixture must remove Leader from Specialist DM-only peers.'

if [[ "${TIANGONG_RUN_REAL:-0}" == 1 ]]; then
  [[ -f "${GENERATED_ENV}" && ! -L "${GENERATED_ENV}" ]] || \
    fail 'real handoff run requires the generated AgentTeams environment.'
  mode="$(stat -c '%a' "${GENERATED_ENV}" 2>/dev/null || stat -f '%Lp' "${GENERATED_ENV}")"
  [[ "${mode}" == 600 ]] || fail 'generated AgentTeams environment must be mode 600.'
  value() {
    awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit}' "${GENERATED_ENV}"
  }
  gateway_port="$(value AGENTTEAMS_PORT_GATEWAY)"
  matrix_domain="$(value AGENTTEAMS_MATRIX_DOMAIN)"
  admin_user="$(value AGENTTEAMS_ADMIN_USER)"
  admin_password="$(value AGENTTEAMS_ADMIN_PASSWORD)"
  export AGENTTEAMS_MATRIX_URL="http://127.0.0.1:${gateway_port}"
  export AGENTTEAMS_MATRIX_DOMAIN="${matrix_domain}"
  export AGENTTEAMS_ADMIN_USER="${admin_user}"
  export AGENTTEAMS_ADMIN_PASSWORD="${admin_password}"
  [[ -n "${AGENTTEAMS_MATRIX_DOMAIN}" && -n "${AGENTTEAMS_ADMIN_USER}" && \
     -n "${AGENTTEAMS_ADMIN_PASSWORD}" ]] || fail 'generated Matrix environment is incomplete.'
  TIANGONG_SPECIALIST_HANDOFF_MODE=full "${RUNNER}"
fi

printf 'Specialist-to-Leader handoff contract tests passed.\n'
