#!/usr/bin/env bash

set -Eeuo pipefail

if (($# < 2)); then
  printf 'Usage: %s <base-commit> <head-commit> [excluded-commit ...]\n' "$0" >&2
  exit 2
fi

readonly BASE="$1"
readonly HEAD="$2"
shift 2
readonly -a EXCLUDED=("$@")
git rev-parse --verify "${BASE}^{commit}" >/dev/null
git rev-parse --verify "${HEAD}^{commit}" >/dev/null
for excluded in "${EXCLUDED[@]}"; do
  git rev-parse --verify "${excluded}^{commit}" >/dev/null
done

failed=0
while IFS= read -r commit; do
  author="$(git show -s --format='%an <%ae>' "${commit}")"
  if ! git show -s --format='%B' "${commit}" | grep -Fqx "Signed-off-by: ${author}"; then
    printf 'ERROR: commit %s lacks an exact DCO trailer for %s\n' "${commit}" "${author}" >&2
    failed=1
  fi
done < <(git rev-list --reverse "${HEAD}" --not "${BASE}" "${EXCLUDED[@]}")

((failed == 0)) || exit 1
printf 'DCO check passed for %s..%s (excluding %s).\n' "${BASE}" "${HEAD}" "${EXCLUDED[*]:-none}"
