#!/bin/sh
set -eu

source_binding="${TIANGONG_LEADER_RUNTIME_BINDING_FILE:?binding file is required}"
runtime_dir=/tmp/tiangong-coordination
runtime_binding="${runtime_dir}/leader-binding.json"

mkdir -p "${runtime_dir}"
chmod 700 "${runtime_dir}"
cp "${source_binding}" "${runtime_binding}"
chmod 600 "${runtime_binding}"
chown node:node "${runtime_dir}" "${runtime_binding}"
export TIANGONG_LEADER_RUNTIME_BINDING_FILE="${runtime_binding}"

exec runuser -u node -- node /opt/tiangong/app/coordination/runtime-server.mjs
