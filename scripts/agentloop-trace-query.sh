#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

fail() { printf 'agentloop_trace_query=fail code=%s\n' "$1" >&2; exit 1; }

[[ -n "${TIANGONG_AGENTLOOP_QUERY_SECRET_FILE:-}" ]] || fail QUERY_SECRET_FILE_REQUIRED
command -v python3 >/dev/null 2>&1 || fail PYTHON3_REQUIRED

exec python3 "${SCRIPT_DIR}/agentloop_trace_query.py" "$@"
