#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/peer-mention-smoke-team.yaml"
readonly WORKER_MANIFEST="${REPO_ROOT}/smoke-testing/fixtures/peer-mention-smoke-workers.yaml"
readonly RUNNER="${REPO_ROOT}/smoke-testing/support/run-peer-mention-smoke.sh"
readonly ROUNDTRIP="${REPO_ROOT}/smoke-testing/support/matrix-peer-roundtrip.sh"
readonly ROOM_MEMBERS="${REPO_ROOT}/smoke-testing/support/matrix-peer-room-members.sh"
readonly ALIASES="${REPO_ROOT}/smoke-testing/support/matrix-peer-aliases.sh"
readonly OTLP_RECEIVER="${REPO_ROOT}/smoke-testing/support/otlp-smoke-receiver.mjs"
readonly OTLP_ACTIVITY_QUERY="${REPO_ROOT}/smoke-testing/support/otlp-turn-activity.jq"
readonly ROOM_ID='!peer-room:matrix.test'
readonly ADMIN_ID='@admin:matrix.test'
readonly LEADER_ID='@tiangong-peer-smoke-leader:matrix.test'
readonly COORDINATOR_ID='@tiangong-peer-smoke-coordinator:matrix.test'
readonly ENGINEER_ID='@tiangong-peer-smoke-engineer:matrix.test'
readonly NONCE='11111111-2222-4333-8444-555555555555'

temporary_directory="$(mktemp -d)"
receiver_pid=''
persistence_receiver_pid=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "${receiver_pid}" "${persistence_receiver_pid}"; do
    if [[ -n "${pid}" ]]; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
  rm -rf -- "${temporary_directory}"
  exit "${status}"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_exact_line_count() {
  local expected="$1" line="$2" actual
  actual="$(grep -Fxc -- "${line}" "${MANIFEST}" || true)"
  [[ "${actual}" == "${expected}" ]] || \
    fail "expected ${expected} exact manifest line(s) '${line}', found ${actual}."
}

assert_pattern_count() {
  local expected="$1" pattern="$2" label="$3" actual
  actual="$(grep -Ec -- "${pattern}" "${MANIFEST}" || true)"
  [[ "${actual}" == "${expected}" ]] || \
    fail "expected ${expected} manifest ${label} line(s), found ${actual}."
}

assert_worker_exact_line_count() {
  local expected="$1" line="$2" actual
  actual="$(grep -Fxc -- "${line}" "${WORKER_MANIFEST}" || true)"
  [[ "${actual}" == "${expected}" ]] || \
    fail "expected ${expected} Worker manifest exact line(s) '${line}', found ${actual}."
}

assert_worker_pattern_count() {
  local expected="$1" pattern="$2" label="$3" actual
  actual="$(grep -Ec -- "${pattern}" "${WORKER_MANIFEST}" || true)"
  [[ "${actual}" == "${expected}" ]] || \
    fail "expected ${expected} Worker manifest ${label} line(s), found ${actual}."
}

expect_validation_failure() {
  local file="$1" label="$2"
  if "${ROUNDTRIP}" validate "${file}" "${ROOM_ID}" "${ADMIN_ID}" "${LEADER_ID}" \
      "${COORDINATOR_ID}" "${ENGINEER_ID}" "${NONCE}" >/dev/null 2>&1; then
    fail "event validator accepted ${label}."
  fi
}

for path in "${MANIFEST}" "${WORKER_MANIFEST}" "${RUNNER}" "${ROUNDTRIP}" "${ROOM_MEMBERS}" "${ALIASES}" \
  "${OTLP_RECEIVER}" "${OTLP_ACTIVITY_QUERY}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || fail "required peer smoke asset is missing or symlinked: ${path}"
done
[[ -x "${RUNNER}" && -x "${ROUNDTRIP}" && -x "${ROOM_MEMBERS}" && -x "${ALIASES}" ]] || \
  fail 'peer smoke support scripts must be executable.'
for script in "${RUNNER}" "${ROUNDTRIP}" "${ROOM_MEMBERS}" "${ALIASES}"; do
  bash -n "${script}"
done
node --check "${OTLP_RECEIVER}"
# These are literal source fragments; expansion would invalidate the contract check.
# shellcheck disable=SC2016
for required_runner_contract in \
  'coordinator_control_before="$(control_snapshot "${COORDINATOR_CONTAINER}")"' \
  'engineer_control_before="$(control_snapshot "${ENGINEER_CONTAINER}")"' \
  '[[ "${current}" != "${baseline}" ]]' \
  'control_snapshot' \
  'Control marker changed for %s' \
  '"${ENGINEER_ROOM_MEMBERS}" event-visible' \
  'openclaw channels status --json' \
  '.lastConnectedAt >= .lastStartAt' \
  '[[ "${policy_after}" == "${policy_before}" ]]' \
  '[[ "$(jq -r '\''.lastStartAt'\'' <<<"${status_after}")" ==' \
  'TIANGONG_OTEL_EXPORTER_ENDPOINT="${OTLP_ENDPOINT}" "${BUILD_WORKER_IMAGE}"' \
  '--user "$(id -u):$(id -g)"' \
  'Sanitized Coordinator start-event trace' \
  'Sanitized Coordinator turn activity facts' \
  'Sanitized turn activity facts for %s' \
  'Sanitized OTLP receiver status' \
  'Sanitized unmatched trace inventory' \
  'assert_trace_complete "${start_event_id}" coordinator_start peer.transport.start' \
  'assert_trace_complete "${ping_event_id}" engineer_ping peer.transport.ping' \
  'assert_trace_complete "${pong_event_id}" coordinator_pong peer.transport.pong' \
  '.name != "tiangong.openclaw.agent_turn" and .name != "gen_ai.chat"' \
  'rm -rf -- "${OTLP_DATA_DIRECTORY}"'; do
  grep -Fq -- "${required_runner_contract}" "${RUNNER}" || \
  fail "runner is missing a deterministic readiness or control contract: ${required_runner_contract}"
done
# These are literal source fragments; expansion would invalidate the contract check.
# shellcheck disable=SC2016
for required_roundtrip_contract in \
  '("TG_PEER_START nonce=" + $nonce) as $control' \
  'body:($coordinator + " " + $control)' \
  'for _ in $(seq 1 36); do' \
  'sync?since=${since_query}&timeout=10000'; do
  grep -Fq -- "${required_roundtrip_contract}" "${ROUNDTRIP}" || \
    fail "round-trip probe is missing a deterministic prompt or observer contract: ${required_roundtrip_contract}"
done
if grep -Eq 'Your first reply|Reply exactly|Do not add anything else' "${ROUNDTRIP}"; then
  fail 'round-trip probe must not depend on stochastic model wording.'
fi

progress_activity="$(jq -c -f "${OTLP_ACTIVITY_QUERY}" <<'JSON'
[
  {"name":"tiangong.lifecycle.checkpoint","phase":"openclaw.turn.start","outcome":null,"private":"secret"},
  {"name":"tiangong.lifecycle.checkpoint","phase":"model.request.ready","outcome":null},
  {"name":"tiangong.lifecycle.checkpoint","phase":"model.response.received","outcome":null},
  {"name":"tiangong.lifecycle.checkpoint","phase":"model.response.start","outcome":null},
  {"name":"tiangong.lifecycle.checkpoint","phase":"model.response.progress","outcome":null},
  {"name":"gen_ai.chat","phase":null,"outcome":"complete"}
]
JSON
)"
[[ "${progress_activity}" == '{"peerTransportStart":false,"peerTransportPing":false,"peerTransportPong":false,"openclawTurnStarted":true,"requestReady":true,"responseReceived":true,"responseStarted":true,"responseProgress":true,"retryObserved":false,"modelComplete":true,"modelTimedOut":false,"modelAborted":false}' ]] || \
  fail 'turn activity query did not classify real stream progress.'
[[ "${progress_activity}" != *secret* ]] || fail 'turn activity query leaked an unallowlisted input field.'
silent_activity="$(jq -c -f "${OTLP_ACTIVITY_QUERY}" <<'JSON'
[
  {"name":"tiangong.lifecycle.checkpoint","phase":"openclaw.turn.start","outcome":null},
  {"name":"tiangong.lifecycle.checkpoint","phase":"model.request.ready","outcome":null},
  {"name":"gen_ai.chat","phase":null,"outcome":"timeout"}
]
JSON
)"
[[ "${silent_activity}" == '{"peerTransportStart":false,"peerTransportPing":false,"peerTransportPong":false,"openclawTurnStarted":true,"requestReady":true,"responseReceived":false,"responseStarted":false,"responseProgress":false,"retryObserved":false,"modelComplete":false,"modelTimedOut":true,"modelAborted":false}' ]] || \
  fail 'turn activity query did not classify a silent provider timeout.'
transport_activity="$(jq -c -f "${OTLP_ACTIVITY_QUERY}" <<'JSON'
[
  {"name":"tiangong.lifecycle.checkpoint","phase":"peer.transport.start","outcome":null},
  {"name":"tiangong.control.attempt","phase":null,"outcome":"complete"}
]
JSON
)"
[[ "${transport_activity}" == '{"peerTransportStart":true,"peerTransportPing":false,"peerTransportPong":false,"openclawTurnStarted":false,"requestReady":false,"responseReceived":false,"responseStarted":false,"responseProgress":false,"retryObserved":false,"modelComplete":false,"modelTimedOut":false,"modelAborted":false}' ]] || \
  fail 'turn activity query did not classify a deterministic peer transport control.'

assert_exact_line_count 1 'apiVersion: agentteams.io/v1beta1'
assert_exact_line_count 1 'kind: Team'
assert_exact_line_count 1 '  name: tiangong-peer-smoke'
assert_exact_line_count 1 '  peerMentions: true'
assert_exact_line_count 1 '    - name: tiangong-peer-smoke-leader'
assert_exact_line_count 1 '    - name: tiangong-peer-smoke-coordinator'
assert_exact_line_count 1 '    - name: tiangong-peer-smoke-engineer'

assert_worker_exact_line_count 3 'apiVersion: agentteams.io/v1beta1'
assert_worker_exact_line_count 3 'kind: Worker'
assert_worker_exact_line_count 1 '  name: tiangong-peer-smoke-leader'
assert_worker_exact_line_count 1 '  name: tiangong-peer-smoke-coordinator'
assert_worker_exact_line_count 1 '  name: tiangong-peer-smoke-engineer'
assert_worker_pattern_count 3 '^[[:space:]]+model: qwen3\.5-plus$' model
assert_worker_pattern_count 1 '^[[:space:]]+runtime: copaw$' stock_runtime
assert_worker_pattern_count 2 '^[[:space:]]+runtime: openclaw$' runtime
assert_worker_exact_line_count 1 '  image: higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-copaw-worker:v1.2.0'
assert_worker_pattern_count 2 '^[[:space:]]+image: tiangong-worker:dev$' image
assert_worker_pattern_count 3 '^[[:space:]]+state: Running$' state
assert_worker_pattern_count 2 '^[[:space:]]+groupAllowExtra:$' groupAllowExtra
assert_worker_pattern_count 2 '^[[:space:]]+dmAllowExtra:$' dmAllowExtra
assert_worker_exact_line_count 1 '      - tiangong-peer-smoke-engineer'
assert_worker_exact_line_count 1 '      - tiangong-peer-smoke-coordinator'
assert_worker_exact_line_count 4 '      - tiangong-peer-smoke-leader'
if grep -Eqi 'apiKey|accessToken|password|secret|token:' "${WORKER_MANIFEST}"; then
  fail 'peer Worker fixture appears to contain credential-bearing fields.'
fi
if grep -Eq '(^|[[:space:]])(package|skills|mcpServers):' "${MANIFEST}"; then
  fail 'peer transport fixture must not enable packages, Skills, or MCP servers.'
fi
if grep -Eqi 'apiKey|accessToken|password|secret|token:' "${MANIFEST}"; then
  fail 'peer transport fixture appears to contain credential-bearing fields.'
fi
for identity in \
  tiangong-peer-smoke \
  tiangong-peer-smoke-leader \
  tiangong-peer-smoke-coordinator \
  tiangong-peer-smoke-engineer; do
  [[ "${identity}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || \
    fail "reserved identity is not DNS-safe: ${identity}"
done

positive="${temporary_directory}/positive.json"
jq -cn \
  --arg room "${ROOM_ID}" \
  --arg admin "${ADMIN_ID}" \
  --arg leader "${LEADER_ID}" \
  --arg coordinator "${COORDINATOR_ID}" \
  --arg engineer "${ENGINEER_ID}" \
  --arg nonce "${NONCE}" '
  {events:[
    {room_id:$room,type:"m.room.message",sender:$admin,event_id:"$start",
      content:{body:($coordinator + " TG_PEER_START nonce=" + $nonce),
        "m.mentions":{user_ids:[$coordinator]}}},
    {room_id:$room,type:"m.room.message",sender:$coordinator,event_id:"$ping",
      content:{body:($engineer + " TG_PEER_PING nonce=" + $nonce),
        "m.mentions":{user_ids:[$engineer]}}},
    {room_id:$room,type:"m.room.message",sender:$engineer,event_id:"$pong",
      content:{body:($coordinator + " TG_PEER_PONG nonce=" + $nonce),
        "m.mentions":{user_ids:[$coordinator]}}},
    {room_id:$room,type:"m.room.message",sender:$coordinator,event_id:"$done",
      content:{body:("TG_PEER_DONE nonce=" + $nonce),"m.mentions":{user_ids:[]}}}
  ]}
' >"${positive}"
validation_output="$("${ROUNDTRIP}" validate "${positive}" "${ROOM_ID}" "${ADMIN_ID}" \
  "${LEADER_ID}" "${COORDINATOR_ID}" "${ENGINEER_ID}" "${NONCE}")"
grep -Fqx 'worker_peer_event_chain=pass' <<<"${validation_output}" || \
  fail 'positive peer event chain did not pass.'
grep -Fqx 'stock_leader_message_count=0' <<<"${validation_output}" || \
  fail 'positive peer event chain did not prove Leader silence.'

jq '(.events[] | select(.event_id == "$ping").content["m.mentions"].user_ids) = []' \
  "${positive}" >"${temporary_directory}/missing-mention.json"
expect_validation_failure "${temporary_directory}/missing-mention.json" 'a ping without the Engineer mention'

jq '(.events[] | select(.event_id == "$ping").content.body) += " extra model prose"' \
  "${positive}" >"${temporary_directory}/extra-ping-prose.json"
expect_validation_failure "${temporary_directory}/extra-ping-prose.json" 'a ping containing non-protocol prose'

jq '(.events[] | select(.event_id == "$pong").sender) = "@unexpected:matrix.test"' \
  "${positive}" >"${temporary_directory}/wrong-sender.json"
expect_validation_failure "${temporary_directory}/wrong-sender.json" 'a pong from the wrong sender'

jq '(.events[] | select(.event_id == "$pong").content.body) |= sub("11111111-2222-4333-8444-555555555555"; "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")' \
  "${positive}" >"${temporary_directory}/wrong-nonce.json"
expect_validation_failure "${temporary_directory}/wrong-nonce.json" 'a pong with the wrong nonce'

jq --arg engineer "${ENGINEER_ID}" --arg nonce "${NONCE}" '
  (.events[] | select(.event_id == "$done").content.body) = ($engineer + " TG_PEER_DONE nonce=" + $nonce) |
  (.events[] | select(.event_id == "$done").content["m.mentions"].user_ids) = [$engineer]
' "${positive}" >"${temporary_directory}/terminal-rewake.json"
expect_validation_failure "${temporary_directory}/terminal-rewake.json" 'a terminal event that re-mentions Engineer'

jq --arg room "${ROOM_ID}" --arg engineer "${ENGINEER_ID}" '.events += [{
  room_id:$room,type:"m.room.message",sender:$engineer,event_id:"$after-terminal",
  content:{body:"unexpected after terminal", "m.mentions":{user_ids:[]}}
}]' "${positive}" >"${temporary_directory}/post-terminal-message.json"
expect_validation_failure "${temporary_directory}/post-terminal-message.json" 'a peer message after the terminal event'

jq --arg room "${ROOM_ID}" --arg leader "${LEADER_ID}" '.events += [{
  room_id:$room,type:"m.room.message",sender:$leader,event_id:"$leader-response",
  content:{body:"unexpected", "m.mentions":{user_ids:[]}}
}]' "${positive}" >"${temporary_directory}/leader-message.json"
expect_validation_failure "${temporary_directory}/leader-message.json" 'a stock Leader response'

observer_config="${temporary_directory}/openclaw.json"
jq -n '{channels:{matrix:{homeserver:"https://matrix.test",accessToken:("fixture" + "-token")}}}' \
  >"${observer_config}"
chmod 600 "${observer_config}"
mkdir "${temporary_directory}/bin"
cat >"${temporary_directory}/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_MATRIX_EVENT_MODE:-}" == visible ]]; then
  printf '%s\n' '{"chunk":[{"type":"m.room.message","sender":"@admin:matrix.test","content":{"body":"@tiangong-peer-smoke-coordinator:matrix.test TG_PEER_START nonce=11111111-2222-4333-8444-555555555555","m.mentions":{"user_ids":["@tiangong-peer-smoke-coordinator:matrix.test"]}}},{"type":"m.room.message","sender":"@tiangong-peer-smoke-coordinator:matrix.test","content":{"body":"@tiangong-peer-smoke-engineer:matrix.test TG_PEER_PING nonce=11111111-2222-4333-8444-555555555555","m.mentions":{"user_ids":["@tiangong-peer-smoke-engineer:matrix.test"]}}}]}'
else
  printf '%s\n' '{"chunk":[]}'
fi
EOF
chmod 700 "${temporary_directory}/bin/curl"
PATH="${temporary_directory}/bin:${PATH}" FAKE_MATRIX_EVENT_MODE=visible \
  "${ROOM_MEMBERS}" event-visible "${observer_config}" "${ROOM_ID}" \
  "${COORDINATOR_ID}" "${ENGINEER_ID}" "${NONCE}" TG_PEER_PING >/dev/null || \
  fail 'Matrix target-account visibility helper rejected the exact peer ping.'
PATH="${temporary_directory}/bin:${PATH}" FAKE_MATRIX_EVENT_MODE=visible \
  "${ROOM_MEMBERS}" event-visible "${observer_config}" "${ROOM_ID}" \
  "${ADMIN_ID}" "${COORDINATOR_ID}" "${NONCE}" TG_PEER_START >/dev/null || \
  fail 'Matrix target-account visibility helper rejected the exact Admin start.'
if PATH="${temporary_directory}/bin:${PATH}" FAKE_MATRIX_EVENT_MODE=missing \
    "${ROOM_MEMBERS}" event-visible "${observer_config}" "${ROOM_ID}" \
    "${COORDINATOR_ID}" "${ENGINEER_ID}" "${NONCE}" TG_PEER_PING >/dev/null 2>&1; then
  fail 'Matrix target-account visibility helper accepted a missing peer ping.'
fi
if PATH="${temporary_directory}/bin:${PATH}" FAKE_MATRIX_EVENT_MODE=visible \
    "${ROOM_MEMBERS}" event-visible "${observer_config}" "${ROOM_ID}" \
    "${COORDINATOR_ID}" "${ENGINEER_ID}" "${NONCE}" UNSAFE_MARKER >/dev/null 2>&1; then
  fail 'Matrix target-account visibility helper accepted an unsafe marker.'
fi

if "${ALIASES}" unsafe-mode >/dev/null 2>&1; then
  fail 'Matrix alias helper accepted an unsafe mode.'
fi
if "${ROOM_MEMBERS}" unsafe-mode >/dev/null 2>&1; then
  fail 'Matrix room observer accepted an unsafe mode.'
fi

receiver_output="${temporary_directory}/spans.jsonl"
TIANGONG_OTLP_RECEIVER_PORT=14318 node "${OTLP_RECEIVER}" "${receiver_output}" \
  >"${temporary_directory}/receiver.log" 2>&1 &
receiver_pid=$!
for _ in $(seq 1 30); do
  curl --fail --silent --max-time 1 http://127.0.0.1:14318/health >/dev/null 2>&1 && break
  sleep 0.1
done
curl --fail --silent --max-time 1 http://127.0.0.1:14318/health >/dev/null || \
  fail 'OTLP smoke receiver did not become ready.'
valid_otlp="${temporary_directory}/valid-otlp.json"
jq -n '{resourceSpans:[{resource:{attributes:[
  {key:"service.name",value:{stringValue:"tiangong-worker"}},
  {key:"service.namespace",value:{stringValue:"tiangong"}}
]},scopeSpans:[{scope:{name:"io.cynos-ai.tiangong.worker",version:"0.0.0"},spans:[{
  traceId:"11111111111111111111111111111111",
  spanId:"2222222222222222",
  parentSpanId:null,
  name:"tiangong.lifecycle.checkpoint",
  events:[],links:[],status:{code:1},attributes:[
    {key:"tiangong.attempt.id",value:{stringValue:"333333333333333333333333"}},
    {key:"tiangong.turn.id",value:{stringValue:"444444444444444444444444"}},
    {key:"tiangong.session.id",value:{stringValue:"555555555555555555555555"}},
    {key:"tiangong.phase",value:{stringValue:"model.response.progress"}}
  ]
}]}]}]}' >"${valid_otlp}"
curl --fail --silent --max-time 2 -H 'Content-Type: application/json' \
  --data-binary @"${valid_otlp}" http://127.0.0.1:14318/v1/traces >/dev/null || \
  fail 'OTLP smoke receiver rejected an allowlisted span.'
jq -e 'select(
  .name == "tiangong.lifecycle.checkpoint" and
  .attributes["tiangong.phase"] == "model.response.progress" and
  .attributes["tiangong.turn.id"] == "444444444444444444444444"
)' "${receiver_output}" >/dev/null || fail 'OTLP smoke receiver did not persist the sanitized span.'
jq '
  .resourceSpans[0].scopeSpans[0].spans[0].status = {code:2,message:"internal_error"} |
  (.resourceSpans[0].scopeSpans[0].spans[0].attributes) += [
    {key:"error.type",value:{stringValue:"internal_error"}},
    {key:"tiangong.operation.outcome",value:{stringValue:"error"}}
  ]
' "${valid_otlp}" >"${temporary_directory}/error-otlp.json"
curl --fail --silent --max-time 2 -H 'Content-Type: application/json' \
  --data-binary @"${temporary_directory}/error-otlp.json" \
  http://127.0.0.1:14318/v1/traces >/dev/null || \
  fail 'OTLP smoke receiver rejected a stable internal error span.'
jq '(.resourceSpans[0].scopeSpans[0].spans[0].attributes) += [
  {key:"untrusted.prompt",value:{stringValue:"sensitive"}}
]' "${valid_otlp}" >"${temporary_directory}/invalid-otlp.json"
invalid_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
  -H 'Content-Type: application/json' --data-binary @"${temporary_directory}/invalid-otlp.json" \
  http://127.0.0.1:14318/v1/traces)"
[[ "${invalid_status}" == 400 ]] || fail 'OTLP smoke receiver accepted a non-allowlisted attribute.'
malformed_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
  -H 'Content-Type: application/json' --data-binary '{' \
  http://127.0.0.1:14318/v1/traces)"
[[ "${malformed_status}" == 400 ]] || fail 'OTLP smoke receiver accepted malformed JSON.'
node --input-type=module - <<'NODE'
import { request } from "node:http";
await new Promise((resolve) => {
  const outgoing = request({
    host: "127.0.0.1",
    port: 14318,
    path: "/v1/traces",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "1024" },
  });
  outgoing.on("error", () => resolve());
  outgoing.write("{");
  setTimeout(() => {
    outgoing.destroy();
    resolve();
  }, 25);
});
NODE
body_failure_observed='false'
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 1 http://127.0.0.1:14318/health | jq -e '
      .rejectionReasons.body_failure == 1
    ' >/dev/null; then
    body_failure_observed='true'
    break
  fi
  sleep 0.1
done
[[ "${body_failure_observed}" == true ]] || fail 'OTLP smoke receiver did not classify an aborted body.'
curl --fail --silent --max-time 1 http://127.0.0.1:14318/health | jq -e '
  .status == "ready" and
  .acceptedRequests == 2 and
  .acceptedSpans == 2 and
  .rejectedRequests == 3 and
  .rejectionReasons == {attribute_not_allowlisted:1,body_failure:1,json_failure:1}
' >/dev/null || fail 'OTLP smoke receiver counters do not match accepted and rejected requests.'
kill "${receiver_pid}"
wait "${receiver_pid}" 2>/dev/null || true
receiver_pid=''

persistence_output="${temporary_directory}/persistence-output"
mkdir "${persistence_output}"
TIANGONG_OTLP_RECEIVER_PORT=14319 node "${OTLP_RECEIVER}" "${persistence_output}" \
  >"${temporary_directory}/persistence-receiver.log" 2>&1 &
persistence_receiver_pid=$!
for _ in $(seq 1 30); do
  curl --fail --silent --max-time 1 http://127.0.0.1:14319/health >/dev/null 2>&1 && break
  sleep 0.1
done
curl --fail --silent --max-time 1 http://127.0.0.1:14319/health >/dev/null || \
  fail 'OTLP persistence-failure receiver did not become ready.'
persistence_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
  -H 'Content-Type: application/json' --data-binary @"${valid_otlp}" \
  http://127.0.0.1:14319/v1/traces)"
[[ "${persistence_status}" == 400 ]] || fail 'OTLP smoke receiver accepted a persistence failure.'
curl --fail --silent --max-time 1 http://127.0.0.1:14319/health | jq -e '
  .status == "ready" and
  .acceptedRequests == 0 and
  .acceptedSpans == 0 and
  .rejectedRequests == 1 and
  .rejectionReasons == {persistence_failure:1}
' >/dev/null || fail 'OTLP smoke receiver did not classify a persistence failure.'
kill "${persistence_receiver_pid}"
wait "${persistence_receiver_pid}" 2>/dev/null || true
persistence_receiver_pid=''

printf 'Worker peer mention smoke contract tests passed.\n'
