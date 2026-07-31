#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
cd "${REPO_ROOT}"

repository_files() {
  {
    git ls-files
    git ls-files --others --exclude-standard
  } | sort -u
}

required=(
  LICENSE README.md AGENTS.md SECURITY.md CONTRIBUTING.md RELEASING.md
  GOVERNANCE.md DCO.md CODEOWNERS .gitignore .env.example Makefile
  docs/rules/implementation.md docs/rules/verification.md
  docs/rules/security-and-evidence.md docs/rules/worker-runtime.md
  scripts/agentteams.sh scripts/check-skills.mjs
)
for path in "${required[@]}"; do
  [[ -f "${path}" ]] || {
    printf 'ERROR: required file is missing: %s\n' "${path}" >&2
    exit 1
  }
done

failed=0
while IFS= read -r path; do
  case "/${path}" in
    */.runtime | */.runtime/*)
      printf 'ERROR: generated runtime state is tracked: %s\n' "${path}" >&2
      failed=1
      ;;
  esac

  base="${path##*/}"
  case "${base}" in
    .env.example) ;;
    .env | .env.*)
      printf 'ERROR: local environment file is tracked: %s\n' "${path}" >&2
      failed=1
      ;;
  esac
done < <(repository_files)

((failed == 0)) || exit 1

manifest_files=()
while IFS= read -r path; do
  base="${path##*/}"
  case "${base}" in
    package.json|package-lock.json|npm-shrinkwrap.json|pnpm-lock.yaml|yarn.lock|bun.lock|bun.lockb|pyproject.toml|poetry.lock|requirements.txt|uv.lock|go.mod|go.sum|Cargo.toml|Cargo.lock|Dockerfile|docker-compose.yml|docker-compose.yaml|compose.yml|compose.yaml)
      manifest_files+=("${path}")
      ;;
  esac
done < <(repository_files)

if ((${#manifest_files[@]} > 0)); then
  if grep -nE 'git@[^[:space:]]+|git\+ssh://|ssh://[^[:space:]]+' \
      "${manifest_files[@]}"; then
    printf 'ERROR: a prohibited private-package or SSH Git reference appears in a dependency manifest.\n' >&2
    exit 1
  fi
fi

[[ -x scripts/agentteams.sh ]] || {
  printf 'ERROR: scripts/agentteams.sh must be executable.\n' >&2
  exit 1
}

git diff --check
printf 'Repository policy checks passed.\n'
