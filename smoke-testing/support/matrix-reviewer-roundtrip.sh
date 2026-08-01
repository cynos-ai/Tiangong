#!/usr/bin/env bash
set -Eeuo pipefail

if (($# != 4)); then
  printf 'Usage: %s basic|git-basic|recovery-start|recovery-extend|journey-read|journey-check ROOM_ID WORKER_USER_ID NONCE\n' "$0" >&2
  exit 2
fi

readonly ACTION="$1"
readonly ROOM_ID="$2"
readonly WORKER_USER_ID="$3"
readonly NONCE="$4"
readonly MANAGER_CONFIG="${HOME}/openclaw.json"
readonly BASIC_TARGET="reviewer-basic-${NONCE}"
readonly GIT_TARGET="reviewer-git-${NONCE}"
readonly RECOVERY_A="reviewer-recovery-a-${NONCE}"
readonly RECOVERY_B="reviewer-recovery-b-${NONCE}"

case "${ACTION}" in
  basic)
    prompt="Use the Reviewer tools, not prose alone. Call start_work exactly once with practiceId review, objective 'Review the explicit smoke directory snapshot', acceptanceCriteria containing exactly 'Confirm every resource in the final target scope contains its expected harmless smoke marker.', and targets containing exactly one directory_snapshot with path ${BASIC_TARGET}, includePrefixes exactly ['.'], and excludePrefixes exactly ['excluded']. From the start result use its runtime targetId. Call inspect_directory list exactly once for prefix '.', offset 0, limit 200; call inspect_directory search exactly once for prefix '.', query 'harmless-reviewer-basic', maxResults 10. Then call read exactly once for complete memberPath one.txt and exactly once for complete memberPath two.txt using that targetId. Then call check_completion exactly once. Its completionClaim must use criterion-1 as addressed, scope targetIds exactly [that targetId], outcome accept, a nonempty synopsis, no observations, exactly one STATIC_REVIEW_ONLY limitation with nonempty detail, and no nextActions."
    expected_state="done"
    expected_checkpoint="passed"
    expected_revision="1"
    expected_targets="1"
    ;;
  git-basic)
    prompt="Use the Reviewer tools, not prose alone. Call start_work exactly once with practiceId review, objective 'Review the pinned local Git smoke targets', acceptanceCriteria containing exactly 'Confirm every resource in the final target scope contains the expected harmless Git smoke change.', and targets in this exact order: first one commit target with repositoryPath ${GIT_TARGET}, ref refs/heads/head, pathPrefixes exactly ['src']; second one git_diff target with repositoryPath ${GIT_TARGET}, baseRef refs/heads/base, headRef refs/heads/head, pathPrefixes exactly ['src']. From the start result use both runtime targetIds. Call inspect_repository exactly once for the commit target with action list_commit, prefix 'src', offset 0, limit 200. Call read exactly once for complete commit memberPath src/one.txt and exactly once for complete commit memberPath src/two.txt. Call read exactly once for the complete git_diff target without memberPath. Then call check_completion exactly once. Its completionClaim must use criterion-1 as addressed, scope targetIds exactly [commit targetId, git_diff targetId] in that order, outcome accept, a nonempty synopsis, no observations, exactly one STATIC_REVIEW_ONLY limitation with nonempty detail, and no nextActions."
    expected_state="done"
    expected_checkpoint="passed"
    expected_revision="1"
    expected_targets="2"
    ;;
  recovery-start)
    prompt="Start a Reviewer run and leave it active for a later target extension. Call start_work exactly once with practiceId review, objective 'Review the explicit smoke directory snapshots as targets are appended', acceptanceCriteria containing exactly 'Confirm every resource in the final target scope contains its expected harmless smoke marker.', and targets containing exactly one directory_snapshot with path ${RECOVERY_A}, includePrefixes exactly ['.'], and excludePrefixes exactly ['excluded']. From the start result use its runtime targetId and call read exactly once for complete memberPath one.txt and exactly once for complete memberPath two.txt. Do not call extend_scope, inspect_directory, check_completion, or abandon_work in this turn."
    expected_state="active"
    expected_checkpoint="not-run"
    expected_revision="1"
    expected_targets="1"
    ;;
  recovery-extend)
    prompt="Continue the existing active Reviewer run. Call extend_scope exactly once with targets containing exactly one directory_snapshot with path ${RECOVERY_B}, includePrefixes exactly ['.'], and excludePrefixes exactly ['excluded']. Do not call read, inspect_directory, check_completion, start_work, or abandon_work in this turn; the Worker will restart before review continues."
    expected_state="active"
    expected_checkpoint="not-run"
    expected_revision="2"
    expected_targets="2"
    ;;
  journey-read)
    prompt="Recover the existing active Reviewer run from machine state. Use the second targetId in activeRun.scope.targets and call read exactly once for complete memberPath one.txt and exactly once for complete memberPath two.txt. Do not call start_work, extend_scope, inspect_directory, check_completion, or abandon_work in this turn."
    expected_state="active"
    expected_checkpoint="not-run"
    expected_revision="2"
    expected_targets="2"
    ;;
  journey-check)
    prompt="Complete the existing active Reviewer run. Call check_completion exactly once. Its completionClaim must use criterion-1 as addressed and scope targetIds exactly equal activeRun.scope.targets targetIds in their existing order, outcome accept, a nonempty synopsis, no observations, exactly one STATIC_REVIEW_ONLY limitation with nonempty detail, and no nextActions. Do not call start_work, extend_scope, read, inspect_directory, or abandon_work."
    expected_state="done"
    expected_checkpoint="passed"
    expected_revision="2"
    expected_targets="2"
    ;;
  *) exit 2 ;;
esac

for command in curl jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'ERROR: missing required command: %s\n' "${command}" >&2
    exit 1
  }
done
[[ -f "${MANAGER_CONFIG}" ]] || {
  printf 'ERROR: Manager Matrix configuration not found.\n' >&2
  exit 1
}

homeserver="$(jq -r '.channels.matrix.homeserver // empty' "${MANAGER_CONFIG}")"
access_token="$(jq -r '.channels.matrix.accessToken // empty' "${MANAGER_CONFIG}")"
trap 'access_token=""' EXIT
[[ -n "${homeserver}" && -n "${access_token}" ]] || exit 1
homeserver="${homeserver%/}"
room_path="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
worker_localpart="${WORKER_USER_ID%%:*}"

initial_sync="$(curl --fail --silent --show-error --max-time 30 \
  -H "Authorization: Bearer ${access_token}" \
  "${homeserver}/_matrix/client/v3/sync?timeout=0")"
since="$(jq -r '.next_batch // empty' <<<"${initial_sync}")"
[[ -n "${since}" ]] || exit 1

body="${worker_localpart} ${prompt}"
formatted_body="<a href=\"https://matrix.to/#/${WORKER_USER_ID}\">${worker_localpart}</a> ${prompt}"
request_body="$(jq -cn \
  --arg body "${body}" \
  --arg formatted_body "${formatted_body}" \
  --arg worker "${WORKER_USER_ID}" \
  '{msgtype:"m.text",body:$body,format:"org.matrix.custom.html",formatted_body:$formatted_body,"m.mentions":{user_ids:[$worker]}}')"
transaction_id="tiangong-reviewer-${ACTION}-${NONCE}"
transaction_path="$(printf '%s' "${transaction_id}" | jq -sRr @uri)"
request_url="${homeserver}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/${transaction_path}"
request_event="$(curl --fail --silent --show-error --max-time 30 \
  -X PUT -H "Authorization: Bearer ${access_token}" -H 'Content-Type: application/json' \
  --data-binary "${request_body}" "${request_url}" | jq -r '.event_id // empty')"
duplicate_event="$(curl --fail --silent --show-error --max-time 30 \
  -X PUT -H "Authorization: Bearer ${access_token}" -H 'Content-Type: application/json' \
  --data-binary "${request_body}" "${request_url}" | jq -r '.event_id // empty')"
[[ -n "${request_event}" && "${duplicate_event}" == "${request_event}" ]] || {
  printf 'ERROR: Matrix transaction replay was not idempotent.\n' >&2
  exit 1
}
printf 'request_event=%s\nduplicate_request_transaction=pass\n' "${request_event}"

# Reviewer Basic scenarios use several sequential tool calls; keep the Matrix wait bounded but
# above the fixed Harness turn window used by the local AgentTeams stack.
for _ in $(seq 1 60); do
  since_query="$(printf '%s' "${since}" | jq -sRr @uri)"
  sync_response="$(curl --fail --silent --show-error --max-time 20 \
    -H "Authorization: Bearer ${access_token}" \
    "${homeserver}/_matrix/client/v3/sync?since=${since_query}&timeout=10000")"
  response_event="$(jq -r \
    --arg room "${ROOM_ID}" \
    --arg worker "${WORKER_USER_ID}" \
    --arg state "state: ${expected_state}" \
    --arg checkpoint "checkpoint: ${expected_checkpoint}" \
    --arg scope "scope: revision ${expected_revision}, targets ${expected_targets}" '
      .rooms.join[$room].timeline.events[]?
      | select(.type == "m.room.message" and .sender == $worker)
      | select(.content.body | contains("\nTiangong machine status\n"))
      | select(.content.body | contains("assurance: worker-local"))
      | select(.content.body | contains($state))
      | select(.content.body | contains($checkpoint))
      | select(.content.body | contains($scope))
      | select(.content.body | contains("verification: static-review-only"))
      | .event_id' <<<"${sync_response}" | tail -n 1)"
  if [[ -n "${response_event}" ]]; then
    printf 'matrix_event=%s\n' "${response_event}"
    printf 'reviewer_%s_delivery=pass\n' "${ACTION}"
    printf 'reviewer_%s_status=pass\n' "${ACTION}"
    exit 0
  fi
  unexpected_status="$(jq -r \
    --arg room "${ROOM_ID}" \
    --arg worker "${WORKER_USER_ID}" '
      [.rooms.join[$room].timeline.events[]?
        | select(.type == "m.room.message" and .sender == $worker)
        | .content.body
        | select(contains("\nTiangong machine status\n"))
        | split("\n")
        | {
            state: (map(select(startswith("state: "))) | last // "state: unknown"),
            checkpoint: (map(select(startswith("checkpoint: "))) | last // "checkpoint: unknown"),
            scope: (map(select(startswith("scope: "))) | last // "scope: unknown")
          }] | last // empty
      | [.state, .checkpoint, .scope] | @tsv' <<<"${sync_response}")"
  if [[ -n "${unexpected_status}" ]]; then
    printf 'ERROR: Reviewer returned a non-matching machine status: %s\n' "${unexpected_status}" >&2
    exit 1
  fi
  since="$(jq -r '.next_batch // empty' <<<"${sync_response}")"
  [[ -n "${since}" ]] || exit 1
done

printf 'ERROR: timed out waiting for Reviewer %s machine status.\n' "${ACTION}" >&2
exit 1
