#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

mkdir -p "${TEST_ROOT}/bin"
cat >"${TEST_ROOT}/bin/jq" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == "-e" ]]; then
  query="${!#}"
  input="$(cat)"
  if [[ "${query}" == *'accessEntries'* && "${input}" == *'accessEntries'* ]]; then exit 0; fi
  if [[ "${query}" == *'type == "object"'* ]]; then exit 0; fi
fi
exit 1
EOF
chmod +x "${TEST_ROOT}/bin/jq"

state="${TEST_ROOT}/state"
mkdir -p "${state}"
cat >"${TEST_ROOT}/bin/docker" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
state="${state}"
name="tiangong-admission-probe"
case "\${1:-}:\${2:-}:\${3:-}" in
  exec:*:agt)
    if [[ "\$*" == *"get workers \${name}"* ]]; then
      if [[ -f "\${state}/present" ]]; then
        if [[ "\$*" == *"-o json"* ]]; then printf '%s\\n' '{"accessEntries":[{"service":"object-storage","permissions":["read"],"scope":{"bucketRef":"workspace","prefix":"agents/probe/*"}}]}' ; else exit 0; fi
      fi
      exit 1
    fi
    if [[ "\$*" == *"apply -f"* ]]; then touch "\${state}/present"; exit 0; fi
    if [[ "\$*" == *"delete worker \${name}"* ]]; then rm -f "\${state}/present"; exit 0; fi
    ;;
  exec:*:rm) exit 0 ;;
  cp:*:*) exit 0 ;;
esac
exit 0
EOF
chmod +x "${TEST_ROOT}/bin/docker"

PATH="${TEST_ROOT}/bin:${PATH}" \
TIANGONG_AGENTTEAMS_MANAGER_CONTAINER=manager-test \
TIANGONG_AGENTTEAMS_PROBE_NAME=tiangong-admission-probe \
  "${REPO_ROOT}/scripts/verify-agentteams-worker-admission.sh" >"${TEST_ROOT}/pass.out"
grep -q 'agentteams_worker_admission=pass' "${TEST_ROOT}/pass.out"
[[ ! -e "${state}/present" ]]

cat >"${TEST_ROOT}/bin/docker" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
state="${state}"
case "\${1:-}:\${2:-}:\${3:-}" in
  exec:*:agt)
    if [[ "\$*" == *"get workers tiangong-admission-probe"* ]]; then
      if [[ -f "\${state}/present" && "\$*" == *"-o json"* ]]; then printf '%s\\n' '{"phase":"Pending"}' ; else exit 1; fi
    fi
    if [[ "\$*" == *"apply -f"* ]]; then touch "\${state}/present"; exit 0; fi
    if [[ "\$*" == *"delete worker"* ]]; then rm -f "\${state}/present"; exit 0; fi
    ;;
  exec:*:rm) exit 0 ;;
  cp:*:*) exit 0 ;;
esac
exit 0
EOF
chmod +x "${TEST_ROOT}/bin/docker"
if PATH="${TEST_ROOT}/bin:${PATH}" \
  TIANGONG_AGENTTEAMS_MANAGER_CONTAINER=manager-test \
  TIANGONG_AGENTTEAMS_PROBE_NAME=tiangong-admission-probe \
  "${REPO_ROOT}/scripts/verify-agentteams-worker-admission.sh" >"${TEST_ROOT}/fail.out" 2>&1; then
  printf 'FAIL: dropped accessEntries were accepted.\n' >&2
  exit 1
fi
grep -q 'ACCESS_ENTRIES_DROPPED' "${TEST_ROOT}/fail.out"
if grep -q 'scope' "${TEST_ROOT}/fail.out"; then
  printf 'FAIL: diagnostic leaked the access scope.\n' >&2
  exit 1
fi

printf 'agentteams_worker_admission_contract=pass\n'
