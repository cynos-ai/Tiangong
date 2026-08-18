#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly DRIVER="${REPO_ROOT}/smoke-testing/support/run-leader-smoke.sh"
readonly REPORT_CHECK="${REPO_ROOT}/smoke-testing/support/requester-report-check.sh"

fail() {
  printf 'leader-smoke-contract: %s\n' "$*" >&2
  exit 1
}

[[ -f "${DRIVER}" && ! -L "${DRIVER}" ]] || fail "driver is missing or symlinked"
[[ -x "${REPORT_CHECK}" && ! -L "${REPORT_CHECK}" ]] || fail "requester report checker is missing, non-executable, or symlinked"

# docker exec does not attach stdin unless -i is explicit. Every heredoc-backed
# in-container oracle must carry -i or the shell/Node process executes no probe
# and can return a false success.
while IFS= read -r command; do
  [[ "${command}" == *"docker exec -i "* ]] || fail "heredoc probe omits docker exec -i: ${command}"
done < <(grep -E 'docker exec .* (sh -s|node --input-type=module -)' "${DRIVER}")

for required in \
  'leader_smoke_implementor_blocker=pass' \
  'leader_smoke_requester_report=pass' \
  'leader_smoke_gate3=partial_blocked_terminal_only' \
  'team.requester.report.delivered' \
  'terminal-report.json'; do
  grep -Fq "${required}" "${DRIVER}" || fail "missing requester-report oracle: ${required}"
done

grep -Fq 'AgentTeams-reserved shared/tasks files' "${REPO_ROOT}/smoke-testing/support/leader-coordination-turn.sh" || \
  fail "coordination smoke must forbid writes to AgentTeams-reserved files"

grep -Fq 'leader_smoke_requester_matrix_report=pass' "${REPORT_CHECK}" || \
  fail "Matrix requester report marker is missing"

printf 'leader_smoke_contract=pass\n'
