#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/normalize-agentteams-gateway-provider.sh"

[[ -f "${SCRIPT}" ]] || { printf 'gateway_provider_normalizer_contract=fail code=SCRIPT_MISSING\n' >&2; exit 1; }
grep -Fq 'rawConfigs.openaiCustomUrl' "${SCRIPT}" || { printf 'gateway_provider_normalizer_contract=fail code=PROVIDER_URL_REWRITE_MISSING\n' >&2; exit 1; }
grep -Fq '/v1/service-sources/${provider_id}' "${SCRIPT}" || { printf 'gateway_provider_normalizer_contract=fail code=SERVICE_SOURCE_REWRITE_MISSING\n' >&2; exit 1; }
grep -Fq 'SNAPSHOT_NOT_FOUND' "${SCRIPT}" || { printf 'gateway_provider_normalizer_contract=fail code=ROLLBACK_MISSING\n' >&2; exit 1; }
grep -Fq 'AGENTTEAMS_ADMIN_PASSWORD' "${SCRIPT}" || { printf 'gateway_provider_normalizer_contract=fail code=SCOPED_ADMIN_AUTH_MISSING\n' >&2; exit 1; }

if grep -Eq 'printf .*AGENTTEAMS_(ADMIN_PASSWORD|LLM_API_KEY|WORKER_GATEWAY_KEY)' "${SCRIPT}"; then
  printf 'gateway_provider_normalizer_contract=fail code=CREDENTIAL_PRINT\n' >&2
  exit 1
fi

printf 'gateway_provider_normalizer_contract=pass\n'
