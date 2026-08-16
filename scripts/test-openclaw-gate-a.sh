#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

readonly PREFLIGHT="${REPO_ROOT}/worker/agent/preflight/openclaw-preflight.mjs"
readonly CLI="${REPO_ROOT}/worker/scripts/openclaw-preflight.mjs"
readonly TEST="${REPO_ROOT}/worker/test/openclaw-preflight.test.mjs"
for path in "${PREFLIGHT}" "${CLI}" "${TEST}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || fail "required Gate A preflight asset is missing or symlinked: ${path}"
done

node --check "${PREFLIGHT}"
node --check "${CLI}"
node --check "${TEST}"
node --test "${TEST}"

if grep -Eqi 'password|access_token|apiKey|secret|token:' "${PREFLIGHT}" "${CLI}" "${TEST}"; then
  fail 'Gate A preflight contract contains credential-bearing field names.'
fi

printf 'OpenClaw Gate A preflight contract tests passed.\n'
