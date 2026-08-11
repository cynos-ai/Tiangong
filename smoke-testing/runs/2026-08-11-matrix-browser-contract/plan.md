# P0 Matrix browser contract probe

## Scope

- Level: focused P0 capability probe
- Public baseline: `origin/develop@49817d21a8c238cda123b5ddca3c43a0232eb256`
- Product code enabled by this run: none; all new files are test-only smoke support
- Related issue: `cynos-ai/Tiangong#65`
- Official channel under test: direct Matrix Client-Server API from a browser origin
- Provider/model: not used
- E2EE mode: the configured local AgentTeams Matrix stack has E2EE disabled; an explicitly encrypted room is created only to prove fail-closed unsupported behavior

## Contract

A browser served from a distinct local Web origin must be able to use the
standard Matrix API with a disposable Human identity without putting a Matrix
password or access token in HTML, URLs, logs, browser storage, or the bounded
report.

The browser must prove:

```text
login → whoami → join/list → sync/history
same transaction ID → one event ID/effect
Human event → reply relation + namespaced structured reference
Human sender identity preserved
media upload → authenticated media download
encrypted room detected → no plaintext/decryption shortcut
logout → old session rejected
```

The server-side probe owns exactly one generated user, two generated rooms, one
reset-password admin event, and one uploaded media reference. It redacts the
password event, deletes the media with the Tuwunel admin command, deletes the
rooms, deactivates the user, verifies password login denial, and logs out its
admin session. Cleanup failure keeps the run red.

## Boundary truth table

| Boundary | Required direct observation | Rejected shortcut |
|---|---|---|
| Browser identity | `/whoami` equals the generated disposable Human | admin or service identity reported as Human |
| Transaction replay | both PUTs return the same event ID and history contains one matching event | second event, matching prose only, or transport success only |
| Reply/reference | raw history preserves `m.in_reply_to` and `com.tiangong.p0.reference` fields | visible body mention or model assertion |
| Sender binding | both probe events have the generated Human sender | server/admin sender or unbound event |
| Media | browser receives an `mxc://` URI and downloads exact bytes with its token | upload response alone or unauthenticated media claim |
| Encrypted room | browser observes `m.room.encryption` and performs no unsupported plaintext/decryption action | treating ciphertext/empty history as ordinary messages |
| Session revocation | `/logout` followed by `/whoami` returns 401/403 | assuming logout succeeded from HTTP 200 alone |
| Cleanup | password event redacted, media 404/410, rooms absent, user login denied, admin session closed | broad deletion or name-based cleanup |

## Preconditions and commands

```text
make verify
make test-matrix-browser-smoke-contract
make matrix-browser-start
# open the printed URL in the supported browser session
make matrix-browser-status
make matrix-browser-stop
```

`matrix-browser-start` refuses to replace an existing fixed state directory and
binds only to loopback. The browser page is served with a restrictive CSP and
no persistent browser storage. The generated password is returned only once by
`/bootstrap`, held in a page-local variable, and never returned by `/status`.
`matrix-browser-stop` signals the server and refuses to remove local state if
the server did not complete its cleanup path.

## Required evidence

- deterministic contract test output;
- browser snapshot or screenshot as secondary UI evidence;
- browser request facts showing login, whoami, both joins, joined rooms, sync,
  transaction replay, history, relation, media upload/download, encryption
  state, logout, revoked whoami, and result submission;
- bounded server `/status` result with the generated IDs and cleanup facts;
- no password, access token, unrestricted event body, or credential-bearing URL.

The expected post-logout HTTP 401 may appear as a browser DevTools resource
error; it is the intended session-revocation observation, not a page runtime
error. The page's own bounded `consoleErrors` and `networkErrors` counters must
remain zero.

## Result — PASS

Execution date: 2026-08-11.

The deterministic contract passed before the real browser run. A real browser
run then returned `status=pass` and `phase=cleanup-passed` with:

```text
run_id=c21d3119-2948-4509-91c5-0c57f3bdce39
first_event_id=$ckEqYDKuFf3Sd6nAIYv1XGZGqLA80dzz6cpdoXARrMs
replay_event_id=$ckEqYDKuFf3Sd6nAIYv1XGZGqLA80dzz6cpdoXARrMs
relation_event_id=$7JVlJkQ0m9BpUjONNJa3Q73brfXSkrNEpi_Yh3F8740
media_api=media-v3
first_event_count=1
page_console_errors=0
page_network_errors=0
```

The bounded browser validator accepted all of these checks as true:

```text
login, whoami, joinedRooms, sync, history, txnReplay,
relation, namespacedReference, senderPreserved,
mediaUpload, mediaDownload, encryptedRoomBlocked,
logout, sessionRevoked, storageEmpty
```

Cleanup facts were all true and the error list was empty:

```text
passwordEventRedacted=true
mediaDeleted=true
mediaAbsent=true
roomsAbsent=true
userDeactivated=true
userLoginDenied=true
adminSessionClosed=true
errors=[]
```

The browser evidence included the exact Matrix request sequence and a full-page
screenshot. The screenshot is secondary evidence; the authoritative pass and
cleanup facts came from the browser report validator, Matrix response statuses,
and the server's exact cleanup post-checks.

## Limitations and next gate

This probe does not prove target Work admission, durable PostgreSQL handoff
outbox, sender-side Matrix acknowledgement, independent Leader receipt,
transactional reconciliation, or takeover races. Those remain P0.3 and later
runtime probes. P1 remains blocked until the complete P0 Gate is green.
