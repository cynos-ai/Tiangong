#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  printf 'Usage:\n' >&2
  printf '  %s validate EVENTS_JSON ROOM_ID ADMIN_ID LEADER_ID COORDINATOR_ID ENGINEER_ID NONCE\n' "$0" >&2
  printf '  %s run ROOM_ID LEADER_ID COORDINATOR_ID ENGINEER_ID NONCE\n' "$0" >&2
  exit 2
}

validate_id() {
  local value="$1" label="$2"
  [[ "${value}" =~ ^@[^:[:space:]]+:[^[:space:]]+$ ]] || {
    printf 'ERROR: invalid %s Matrix user ID.\n' "${label}" >&2
    return 1
  }
}

validate_events_json() {
  local events_json="$1" room_id="$2" admin_id="$3" leader_id="$4"
  local coordinator_id="$5" engineer_id="$6" nonce="$7"
  jq -er \
    --arg room "${room_id}" \
    --arg admin "${admin_id}" \
    --arg leader "${leader_id}" \
    --arg coordinator "${coordinator_id}" \
    --arg engineer "${engineer_id}" \
    --arg nonce "${nonce}" '
      def body: (.content.body // "");
      def mentions: (.content["m.mentions"].user_ids // []);
      def has($value): body | contains($value);
      def in_room: .room_id == $room and .type == "m.room.message";
      def one($events; $event_name):
        if ($events | length) == 1 then $events[0]
        else error($event_name + " event count was not exactly one") end;

      [.events[] | select(in_room)] as $messages
      | if any($messages[]; .sender == $leader) then
          error("stock Leader emitted a Team Room message")
        else . end
      | one([$messages[] | select(
          .sender == $admin and
          has("TG_PEER_START nonce=" + $nonce)
        )]; "start") as $start
      | if (($start.content["m.mentions"].user_ids // []) == [$coordinator]) and
           (($start | body | contains($engineer)) | not) and
           (($start | body | contains($leader)) | not)
        then . else error("start mention boundary is invalid") end
      | one([$messages[] | select(
          .sender == $coordinator and
          has("TG_PEER_PING nonce=" + $nonce)
        )]; "ping") as $ping
      | if (($ping | mentions | index($engineer)) != null) and
           (($ping | mentions | index($leader)) == null) and
           (($ping | body | contains($leader)) | not)
        then . else error("ping mention boundary is invalid") end
      | one([$messages[] | select(
          .sender == $engineer and
          has("TG_PEER_PONG nonce=" + $nonce)
        )]; "pong") as $pong
      | if (($pong | mentions | index($coordinator)) != null) and
           (($pong | mentions | index($leader)) == null) and
           (($pong | body | contains($leader)) | not)
        then . else error("pong mention boundary is invalid") end
      | one([$messages[] | select(
          .sender == $coordinator and
          has("TG_PEER_DONE nonce=" + $nonce) and
          ((has("TG_PEER_PING") or has("TG_PEER_PONG")) | not)
        )]; "done") as $done
      | if (($done | mentions | index($engineer)) == null) and
           (($done | mentions | index($leader)) == null) and
           (($done | body | contains($engineer)) | not) and
           (($done | body | contains($leader)) | not)
        then . else error("terminal mention boundary is invalid") end
      | [$start.event_id, $ping.event_id, $pong.event_id, $done.event_id] as $ids
      | if ($ids | all(type == "string" and length > 0)) and
           (($ids | unique | length) == 4)
        then . else error("event IDs are missing or not unique") end
      | [$messages | to_entries[]
          | select(.value.event_id == $start.event_id).key][0] as $start_index
      | [$messages | to_entries[]
          | select(.value.event_id == $ping.event_id).key][0] as $ping_index
      | [$messages | to_entries[]
          | select(.value.event_id == $pong.event_id).key][0] as $pong_index
      | [$messages | to_entries[]
          | select(.value.event_id == $done.event_id).key][0] as $done_index
      | if $start_index < $ping_index and $ping_index < $pong_index and $pong_index < $done_index
        then . else error("peer event order is invalid") end
      | if ([$messages[($done_index + 1):][]
          | select(.sender == $coordinator or .sender == $engineer or .sender == $leader)] | length) == 0
        then . else error("peer emitted a message after the terminal event") end
      | "peer_start_event=" + $start.event_id,
        "peer_ping_event=" + $ping.event_id,
        "peer_pong_event=" + $pong.event_id,
        "peer_done_event=" + $done.event_id,
        "stock_leader_message_count=0",
        "worker_peer_event_chain=pass"
    ' <<<"${events_json}"
}

terminal_event_count() {
  local events_json="$1" coordinator_id="$2" nonce="$3"
  jq -r --arg coordinator "${coordinator_id}" --arg nonce "${nonce}" '
    [.events[] | select(
      .sender == $coordinator and
      ((.content.body // "") | contains("TG_PEER_DONE nonce=" + $nonce)) and
      (
        (
          ((.content.body // "") | contains("TG_PEER_PING")) or
          ((.content.body // "") | contains("TG_PEER_PONG"))
        ) | not
      )
    )] | length
  ' <<<"${events_json}"
}

login_admin() {
  local login_body login_response
  login_body="$(jq -cn \
    --arg user "${ADMIN_USER}" \
    --arg password "${ADMIN_PASSWORD}" \
    '{type:"m.login.password",identifier:{type:"m.id.user",user:$user},password:$password}')"
  login_response="$(printf '%s' "${login_body}" | curl --fail --silent --show-error --max-time 30 \
    -H 'Content-Type: application/json' --data-binary @- \
    "${HOMESERVER}/_matrix/client/v3/login")"
  ACCESS_TOKEN="$(jq -r '.access_token // empty' <<<"${login_response}")"
  [[ -n "${ACCESS_TOKEN}" ]] || {
    printf 'ERROR: Matrix Admin login did not return an access token.\n' >&2
    return 1
  }
  login_body=''
  login_response=''
}

authed_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "${ACCESS_TOKEN}" | \
    curl --fail --silent --show-error --max-time 30 -K - "$@"
}

append_sync_events() {
  local current="$1" response="$2" room_id="$3" additions
  additions="$(jq -c --arg room "${room_id}" '[
    .rooms.join[$room].timeline.events[]?
    | select(.type == "m.room.message")
    | {
        room_id:$room,
        type,
        sender,
        event_id,
        content:{body:(.content.body // ""), "m.mentions":(.content["m.mentions"] // {})}
      }
  ]' <<<"${response}")"
  jq -cn --argjson old "${current}" --argjson new "${additions}" '
    reduce (($old.events + $new)[]) as $event
      ({events:[]};
       if any(.events[]; .event_id == $event.event_id) then .
       else .events += [$event] end)
  '
}

run_probe() {
  local room_id="$1" leader_id="$2" coordinator_id="$3" engineer_id="$4" nonce="$5"
  local admin_id engineer_localpart engineer_domain room_path initial_sync since
  local request_body send_response start_event_id events sync_response since_query
  local event_count leader_count done_count grace_remaining=0 validation

  for command in curl jq; do
    command -v "${command}" >/dev/null 2>&1 || {
      printf 'ERROR: missing required command: %s\n' "${command}" >&2
      return 1
    }
  done
  [[ -n "${HOMESERVER}" && -n "${MATRIX_DOMAIN}" && -n "${ADMIN_USER}" && \
     -n "${ADMIN_PASSWORD}" ]] || {
    printf 'ERROR: Matrix Admin environment is incomplete.\n' >&2
    return 1
  }
  validate_id "${leader_id}" leader
  validate_id "${coordinator_id}" coordinator
  validate_id "${engineer_id}" engineer
  [[ "${nonce}" =~ ^[0-9a-f-]{36}$ ]] || {
    printf 'ERROR: invalid probe nonce.\n' >&2
    return 2
  }

  admin_id="@${ADMIN_USER}:${MATRIX_DOMAIN}"
  validate_id "${admin_id}" admin
  engineer_localpart="${engineer_id#@}"
  engineer_localpart="${engineer_localpart%%:*}"
  engineer_domain="${engineer_id#*:}"
  [[ -n "${engineer_localpart}" && -n "${engineer_domain}" ]] || {
    printf 'ERROR: Engineer Matrix identity is incomplete.\n' >&2
    return 1
  }

  login_admin
  room_path="$(printf '%s' "${room_id}" | jq -sRr @uri)"
  authed_curl "${HOMESERVER}/_matrix/client/v3/rooms/${room_path}/joined_members" \
    | jq -e --arg admin "${admin_id}" '.joined[$admin] != null' >/dev/null || {
      printf 'ERROR: global Admin is not joined to the Team Room.\n' >&2
      return 1
    }

  initial_sync="$(authed_curl "${HOMESERVER}/_matrix/client/v3/sync?timeout=0")"
  since="$(jq -r '.next_batch // empty' <<<"${initial_sync}")"
  [[ -n "${since}" ]] || {
    printf 'ERROR: Matrix initial sync did not return a cursor.\n' >&2
    return 1
  }

  request_body="$(jq -cn \
    --arg coordinator "${coordinator_id}" \
    --arg localpart "${engineer_localpart}" \
    --arg domain "${engineer_domain}" \
    --arg nonce "${nonce}" '
      (
        "TG_PEER_START nonce=" + $nonce + ". Do not use tools. " +
        "Construct TARGET by concatenating @, localpart " + $localpart +
        ", :, and domain " + $domain + ". " +
        "Replace TARGET with that full MXID. Your first reply must be exactly: TARGET TG_PEER_PING nonce=" + $nonce +
        ". Reply exactly " + $coordinator + " TG_PEER_PONG nonce=" + $nonce + ". " +
        "After you later receive that PONG, reply exactly TG_PEER_DONE nonce=" + $nonce + ". " +
        "Never mention the platform Leader."
      ) as $instruction
      | {
          msgtype:"m.text",
          body:($coordinator + " " + $instruction),
          format:"org.matrix.custom.html",
          formatted_body:(
            "<a href=\"https://matrix.to/#/" + $coordinator + "\">" +
            $coordinator + "</a> " + $instruction
          ),
          "m.mentions":{user_ids:[$coordinator]}
        }
    ')"
  jq -e --arg coordinator "${coordinator_id}" --arg engineer "${engineer_id}" \
    --arg leader "${leader_id}" '
      .["m.mentions"].user_ids == [$coordinator] and
      (.body | contains($engineer) | not) and
      (.body | contains($leader) | not)
    ' <<<"${request_body}" >/dev/null || {
      printf 'ERROR: generated start event violates the mention boundary.\n' >&2
      return 1
    }

  send_response="$(authed_curl -X PUT -H 'Content-Type: application/json' \
    --data-binary "${request_body}" \
    "${HOMESERVER}/_matrix/client/v3/rooms/${room_path}/send/m.room.message/tiangong-peer-${nonce}")"
  start_event_id="$(jq -r '.event_id // empty' <<<"${send_response}")"
  [[ -n "${start_event_id}" ]] || {
    printf 'ERROR: Matrix did not return the start event ID.\n' >&2
    return 1
  }
  events="$(jq -cn \
    --arg room "${room_id}" \
    --arg sender "${admin_id}" \
    --arg event "${start_event_id}" \
    --argjson content "${request_body}" \
    '{events:[{room_id:$room,type:"m.room.message",sender:$sender,event_id:$event,content:$content}]}')"

  for _ in $(seq 1 36); do
    since_query="$(printf '%s' "${since}" | jq -sRr @uri)"
    sync_response="$(authed_curl \
      "${HOMESERVER}/_matrix/client/v3/sync?since=${since_query}&timeout=10000")"
    events="$(append_sync_events "${events}" "${sync_response}" "${room_id}")"
    since="$(jq -r '.next_batch // empty' <<<"${sync_response}")"
    [[ -n "${since}" ]] || {
      printf 'ERROR: Matrix sync lost its cursor.\n' >&2
      return 1
    }
    event_count="$(jq '.events | length' <<<"${events}")"
    ((event_count <= 64)) || {
      printf 'ERROR: peer probe exceeded its bounded event budget.\n' >&2
      return 1
    }
    leader_count="$(jq --arg leader "${leader_id}" \
      '[.events[] | select(.sender == $leader)] | length' <<<"${events}")"
    ((leader_count == 0)) || {
      printf 'ERROR: stock Leader emitted a Team Room message.\n' >&2
      return 1
    }
    done_count="$(terminal_event_count "${events}" "${coordinator_id}" "${nonce}")"
    if ((done_count > 0)); then
      if ((grace_remaining == 0)); then
        grace_remaining=2
      else
        grace_remaining=$((grace_remaining - 1))
        ((grace_remaining == 0)) && break
      fi
    fi
  done

  if ! validation="$(validate_events_json "${events}" "${room_id}" "${admin_id}" \
    "${leader_id}" "${coordinator_id}" "${engineer_id}" "${nonce}")"; then
    jq -r \
      --arg leader "${leader_id}" \
      --arg coordinator "${coordinator_id}" \
      --arg engineer "${engineer_id}" \
      --arg nonce "${nonce}" '
        "peer_observed_event_count=" + ((.events | length) | tostring),
        "peer_observed_coordinator_messages=" + ([.events[] | select(.sender == $coordinator)] | length | tostring),
        "peer_observed_engineer_messages=" + ([.events[] | select(.sender == $engineer)] | length | tostring),
        "peer_observed_leader_messages=" + ([.events[] | select(.sender == $leader)] | length | tostring),
        "peer_observed_ping_events=" + ([.events[] | select(.sender == $coordinator and (.content.body // "" | contains("TG_PEER_PING nonce=" + $nonce)))] | length | tostring),
        "peer_observed_pong_events=" + ([.events[] | select(.sender == $engineer and (.content.body // "" | contains("TG_PEER_PONG nonce=" + $nonce)))] | length | tostring),
        "peer_observed_done_events=" + ([.events[] | select(.sender == $coordinator and (.content.body // "" | contains("TG_PEER_DONE nonce=" + $nonce)))] | length | tostring),
        "peer_observed_event_ids=" + ([.events[].event_id] | join(","))
      ' <<<"${events}" >&2
    return 1
  fi
  printf '%s\n' "${validation}"
}

MODE="${1:-}"
case "${MODE}" in
  validate)
    (($# == 8)) || usage
    [[ -f "$2" && ! -L "$2" ]] || {
      printf 'ERROR: event fixture is missing or symlinked.\n' >&2
      exit 1
    }
    for index in 4 5 6 7; do validate_id "${!index}" fixture; done
    events_json="$(<"$2")"
    validate_events_json "${events_json}" "$3" "$4" "$5" "$6" "$7" "$8"
    [[ "$(terminal_event_count "${events_json}" "$6" "$8")" == 1 ]] || {
      printf 'ERROR: terminal event count was not exactly one.\n' >&2
      exit 1
    }
    ;;
  run)
    (($# == 6)) || usage
    readonly HOMESERVER="${AGENTTEAMS_MATRIX_URL%/}"
    readonly MATRIX_DOMAIN="${AGENTTEAMS_MATRIX_DOMAIN:-}"
    readonly ADMIN_USER="${AGENTTEAMS_ADMIN_USER:-}"
    ADMIN_PASSWORD="${AGENTTEAMS_ADMIN_PASSWORD:-}"
    ACCESS_TOKEN=''
    clear_sensitive() {
      local status=$?
      set +e
      if [[ -n "${ACCESS_TOKEN}" ]]; then
        authed_curl -X POST "${HOMESERVER}/_matrix/client/v3/logout" >/dev/null 2>&1 || true
      fi
      ACCESS_TOKEN=''
      ADMIN_PASSWORD=''
      exit "${status}"
    }
    trap clear_sensitive EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    run_probe "$2" "$3" "$4" "$5" "$6"
    ;;
  *) usage ;;
esac
