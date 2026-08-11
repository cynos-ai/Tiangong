#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly REPO_ROOT
readonly CONTRACT="${REPO_ROOT}/smoke-testing/support/matrix-browser-contract.test.mjs"
readonly CONTRACT_MODULE="${REPO_ROOT}/smoke-testing/support/matrix-browser-contract.mjs"
readonly SERVER="${REPO_ROOT}/smoke-testing/support/run-matrix-browser-smoke.mjs"
readonly RUNNER="${REPO_ROOT}/smoke-testing/support/run-matrix-browser-smoke.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for path in "${CONTRACT}" "${CONTRACT_MODULE}" "${SERVER}" "${RUNNER}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || fail "required browser smoke asset is missing or symlinked: ${path}"
done
[[ -x "${RUNNER}" ]] || fail 'browser smoke runner must be executable.'
for script in "${SERVER}" "${RUNNER}"; do
  if [[ "${script}" == *.sh ]]; then bash -n "${script}"; else node --check "${script}"; fi
done
node --test "${CONTRACT}"

# Keep the browser boundary explicit: credentials may be used by the server in
# memory, but no credential-bearing value or unrestricted payload is printed or
# placed in the URL, page title, or local smoke state.
if grep -Eqi 'console\.(log|error).*?(password|access[_-]?token|secret|authorization)' \
    "${CONTRACT_MODULE}" "${SERVER}" "${RUNNER}"; then
  fail 'browser smoke assets appear to print a credential-bearing value.'
fi
if grep -Eqi 'localStorage\.(setItem|clear)|sessionStorage\.(setItem|clear)|document\.cookie[[:space:]]*=[^=]' \
    "${CONTRACT_MODULE}"; then
  fail 'browser page must not persist credentials or session state in browser storage.'
fi
if grep -Eq 'curl.*(password|access[_-]?token|secret)' "${RUNNER}"; then
  fail 'browser smoke runner must not place credentials in curl arguments.'
fi
cleanup_fragment="rm -rf -- \"\${STATE_DIR}\""
if grep -Eqi 'rm[[:space:]]+-rf[[:space:]]+--[[:space:]]+\$\{[^}]+\}' "${RUNNER}" && \
   ! grep -Fq -- "${cleanup_fragment}" "${RUNNER}"; then
  fail 'browser smoke cleanup must target only its fixed state directory.'
fi

printf 'Matrix browser smoke contract tests passed.\n'
