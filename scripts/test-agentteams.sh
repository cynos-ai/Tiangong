#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT INT TERM

mkdir -p "${TEST_ROOT}/scripts"
cp "${REPO_ROOT}/Makefile" "${REPO_ROOT}/.env.example" "${TEST_ROOT}/"
cp "${REPO_ROOT}/scripts/agentteams.sh" "${TEST_ROOT}/scripts/"
chmod +x "${TEST_ROOT}/scripts/agentteams.sh"
cd "${TEST_ROOT}"

make init >/dev/null
[[ "$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)" == "600" ]] || {
  printf 'FAIL: make init did not create .env with mode 600.\n' >&2
  exit 1
}

before="$(sha256sum .env 2>/dev/null || shasum -a 256 .env)"
make init >/dev/null
after="$(sha256sum .env 2>/dev/null || shasum -a 256 .env)"
[[ "${before}" == "${after}" ]] || {
  printf 'FAIL: make init overwrote an existing configuration.\n' >&2
  exit 1
}

marker="${TEST_ROOT}/dotenv-executed"
python3 - "${marker}" <<'PY'
from pathlib import Path
import sys
path = Path('.env')
text = path.read_text()
text = text.replace('AGENTTEAMS_LLM_API_KEY=\n', f'AGENTTEAMS_LLM_API_KEY=$(touch {sys.argv[1]})\n')
path.write_text(text)
path.chmod(0o600)
PY

config="$(make config)"
[[ ! -e "${marker}" ]] || {
  printf 'FAIL: dotenv content was executed as shell code.\n' >&2
  exit 1
}
# The literal command-substitution marker must remain secret data, not execute.
# shellcheck disable=SC2016
[[ "${config}" != *'$(touch '* ]] || {
  printf 'FAIL: secret configuration was not redacted.\n' >&2
  exit 1
}
[[ "${config}" == *"AGENTTEAMS_WORKSPACE_DIR=${TEST_ROOT}/.runtime/agentteams/manager"* ]] || {
  printf 'FAIL: generated workspace is not fixed beneath the repository runtime root.\n' >&2
  exit 1
}

cp .env .env.valid
printf 'AGENTTEAMS_WORKSPACE_DIR=/tmp/unsafe\n' >>.env
if make config >unsupported.out 2>&1; then
  printf 'FAIL: unsupported deletion target was accepted from .env.\n' >&2
  exit 1
fi
grep -q 'Unsupported key' unsupported.out
mv .env.valid .env

printf 'AGENTTEAMS_PORT_GATEWAY=19090\n' >>.env
if make config >duplicate.out 2>&1; then
  printf 'FAIL: duplicate dotenv key was accepted.\n' >&2
  exit 1
fi
grep -q 'Duplicate key' duplicate.out
sed -i '$d' .env

rm -rf .runtime
mkdir outside-runtime
ln -s "${TEST_ROOT}/outside-runtime" .runtime
if make config >symlink.out 2>&1; then
  printf 'FAIL: symlinked runtime root was accepted.\n' >&2
  exit 1
fi
grep -q 'Refusing symlinked runtime target' symlink.out
rm .runtime

mkdir -p .runtime/agentteams/manager .runtime/agentteams/host-share fake-bin
cat >.runtime/agentteams/manager.env <<EOF
AGENTTEAMS_DATA_DIR=tiangong-agentteams-data
AGENTTEAMS_WORKSPACE_DIR=${TEST_ROOT}/.runtime/agentteams/manager
EOF
cat >fake-bin/docker <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  ps) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x fake-bin/docker
if PATH="${TEST_ROOT}/fake-bin:${PATH}" make uninstall >uninstall.out 2>&1; then
  printf 'FAIL: uninstall succeeded without target-specific confirmation.\n' >&2
  exit 1
fi
grep -q 'CONFIRM=delete-tiangong-agentteams-data' uninstall.out

python3 - <<'PY'
from pathlib import Path
path = Path('.runtime/agentteams/manager.env')
text = path.read_text().replace('/.runtime/agentteams/manager', '/unsafe-target')
path.write_text(text)
PY
if PATH="${TEST_ROOT}/fake-bin:${PATH}" make uninstall >tampered.out 2>&1; then
  printf 'FAIL: uninstall accepted tampered generated ownership metadata.\n' >&2
  exit 1
fi
grep -q 'Generated workspace mismatch' tampered.out

if ./scripts/agentteams.sh unknown >unknown.out 2>&1; then
  printf 'FAIL: unknown command returned success.\n' >&2
  exit 1
fi
grep -q 'Unknown command' unknown.out

cat >.runtime/agentteams/manager.env <<EOF
AGENTTEAMS_DATA_DIR=tiangong-agentteams-data
AGENTTEAMS_WORKSPACE_DIR=${TEST_ROOT}/.runtime/agentteams/manager
EOF
chmod 600 .runtime/agentteams/manager.env
cat >fake-bin/docker <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  ps) exit 0 ;;
  volume|network) exit 1 ;;
  inspect)
    if [[ "${2:-}" == "agentteams-manager" ]]; then
      printf 'AGENTTEAMS_MANAGER_MATRIX_TOKEN=test_manager_matrix_token_1234567890\n'
    fi
    ;;
  exec)
    if [[ "${RECOVERY_SCENARIO:-}" == "forged" ]]; then
      printf '%s\n' '{"phase":"Running","runtime":"copaw","welcomeSent":false,"matrixUserID":"@manager:matrix-local.agentteams.io:18080","roomID":"!foreign:other.example"}'
    else
      printf '%s\n' '{"phase":"Running","runtime":"copaw","welcomeSent":false,"matrixUserID":"@manager:matrix-local.agentteams.io:18080","roomID":"!authoritative:matrix-local.agentteams.io:18080"}'
    fi
    ;;
esac
EOF
cat >fake-bin/curl <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
url="${!#}"
case "${url}" in
  */joined_rooms)
    if [[ "${RECOVERY_SCENARIO:-}" == "joined" ]]; then
      printf '%s\n' '{"joined_rooms":["!authoritative:matrix-local.agentteams.io:18080"]}'
    else
      printf '%s\n' '{"joined_rooms":[]}'
    fi
    ;;
  *'/sync?'*) printf '%s\n' '{"rooms":{"invite":{"!authoritative:matrix-local.agentteams.io:18080":{}}}}' ;;
  */join) touch "${RECOVERY_MARKER}"; printf '%s\n' '{"room_id":"!authoritative:matrix-local.agentteams.io:18080"}' ;;
  *) exit 1 ;;
esac
EOF
chmod +x fake-bin/docker fake-bin/curl
marker_join="${TEST_ROOT}/manager-dm-joined"
RECOVERY_SCENARIO=invited RECOVERY_MARKER="${marker_join}" PATH="${TEST_ROOT}/fake-bin:${PATH}" \
  ./scripts/agentteams.sh recover-manager-readiness >recovery.out
[[ -e "${marker_join}" ]] || {
  printf 'FAIL: authoritative Manager DM invitation was not recovered.\n' >&2
  exit 1
}
! grep -q 'test_manager_matrix_token' recovery.out || {
  printf 'FAIL: Manager Matrix token appeared in recovery output.\n' >&2
  exit 1
}
rm -f "${marker_join}"
RECOVERY_SCENARIO=joined RECOVERY_MARKER="${marker_join}" PATH="${TEST_ROOT}/fake-bin:${PATH}" \
  ./scripts/agentteams.sh recover-manager-readiness >recovery-joined.out
[[ ! -e "${marker_join}" ]] || {
  printf 'FAIL: already-joined Manager DM caused another join.\n' >&2
  exit 1
}
if RECOVERY_SCENARIO=forged RECOVERY_MARKER="${marker_join}" PATH="${TEST_ROOT}/fake-bin:${PATH}" \
    ./scripts/agentteams.sh recover-manager-readiness >recovery-forged.out 2>&1; then
  printf 'FAIL: foreign Manager DM was accepted for recovery.\n' >&2
  exit 1
fi
grep -q 'authoritative admin-DM invitation was not observable' recovery-forged.out
[[ ! -e "${marker_join}" ]] || {
  printf 'FAIL: foreign Manager DM triggered a join.\n' >&2
  exit 1
}

printf 'AgentTeams bootstrap tests passed.\n'
