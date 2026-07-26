#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/pi-smoke-team.yaml"
readonly RUNNER="${REPO_ROOT}/smoke-testing/support/run-team-runtime-smoke.sh"
readonly TOPOLOGY_HELPER="${REPO_ROOT}/smoke-testing/support/matrix-room-members.sh"
readonly ALIAS_CLEANUP_HELPER="${REPO_ROOT}/smoke-testing/support/matrix-clean-team-smoke-aliases.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_exact_line_count() {
  local count="$1" line="$2" actual
  actual="$(grep -Fxc -- "${line}" "${MANIFEST}" || true)"
  [[ "${actual}" == "${count}" ]] || \
    fail "expected ${count} exact manifest line(s) '${line}', found ${actual}."
}

assert_pattern_count() {
  local count="$1" pattern="$2" label="$3" actual
  actual="$(grep -Ec -- "${pattern}" "${MANIFEST}" || true)"
  [[ "${actual}" == "${count}" ]] || \
    fail "expected ${count} manifest ${label} line(s), found ${actual}."
}

for path in "${MANIFEST}" "${RUNNER}" "${TOPOLOGY_HELPER}" "${ALIAS_CLEANUP_HELPER}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || fail "required Team smoke asset is missing or symlinked: ${path}"
done
[[ -x "${RUNNER}" && -x "${TOPOLOGY_HELPER}" && -x "${ALIAS_CLEANUP_HELPER}" ]] || \
  fail "Team smoke support scripts must be executable."

bash -n "${RUNNER}"
bash -n "${TOPOLOGY_HELPER}"
bash -n "${ALIAS_CLEANUP_HELPER}"

assert_exact_line_count 1 'apiVersion: agentteams.io/v1beta1'
assert_exact_line_count 1 'kind: Team'
assert_exact_line_count 1 '  name: tiangong-team-smoke'
assert_exact_line_count 1 '    name: tiangong-team-smoke-leader'
assert_exact_line_count 1 '    - name: tiangong-team-smoke-engineer'
assert_pattern_count 2 '^[[:space:]]+model: qwen3\.5-plus$' model
assert_pattern_count 2 '^[[:space:]]+runtime: openclaw$' runtime
assert_pattern_count 2 '^[[:space:]]+image: tiangong-worker:dev$' image
assert_pattern_count 2 '^[[:space:]]+state: Running$' state

if grep -Eq '(^|[[:space:]])(package|skills|mcpServers):' "${MANIFEST}"; then
  fail 'Phase 0 Team fixture must not enable packages, Skills, or MCP servers.'
fi
if grep -Eq 'apiKey|accessToken|password|secret|token:' "${MANIFEST}"; then
  fail 'Team fixture appears to contain credential-bearing fields.'
fi

for identity in \
  tiangong-team-smoke \
  tiangong-team-smoke-leader \
  tiangong-team-smoke-engineer; do
  [[ "${identity}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || \
    fail "reserved identity is not DNS-safe: ${identity}"
done

unsafe_config="$(mktemp)"
trap 'rm -f "${unsafe_config}"' EXIT INT TERM
printf '{"channels":{"matrix":{}}}\n' >"${unsafe_config}"
if "${TOPOLOGY_HELPER}" "${unsafe_config}" '!room:example.test' 'bad-label' '' '' \
    >"${unsafe_config}.out" 2>&1; then
  fail 'Matrix topology helper accepted an invalid observation label.'
fi
rm -f "${unsafe_config}.out"

printf 'Team runtime smoke contract tests passed.\n'
