# Plannotator Inbox on a phone: the wire contract

Date: 2026-10-08. Step C1 of the mobile plan. The records it follows: the owner's thirteen mobile decisions, the iPhone design of record (renders 1.1 to 9.2) and the build plan. Those design records are kept privately and are not in this repo; the behaviour a build needs is written here, and bare render numbers (1.3, 9.2) refer to that private record.

This document is the contract the iPhone app (and, by section 10, the Android app), the Inbox's device door, the LAN listener, the relay Worker and the surface bridge build against: P1, P2, S1, R1, R2 and M1 to M6. Names below are final. A later change edits this file first. A bare number such as 1.3 or 4.3 names a render of the iPhone record; "exchange 7.x" and the Exchange columns name section 7.

The posture, in one paragraph. The Inbox stays a loopback server. A phone pairs once and gets its own random bearer token. Three paths carry the same requests: the tailnet (`tailscale serve` in front of the loopback port), the same Wi-Fi (a TLS listener whose certificate the phone pins), and the relay (a Cloudflare Worker that holds only ciphertext under keys made at pairing). Every phone request goes through one door, `/api/inbox/device/*`, which maps an explicit allowlist onto the window's existing handlers. Nothing else answers a phone.

Two limits exist because pairing cannot work without them: an offer lives 10 minutes, and its six-digit code closes after 5 wrong tries. The relay's mailbox creation reuses the brake guides.show already has on its create route (section 4), with no number of its own. Apple's own ceilings apply where Apple sets them (a push body of 4096 bytes, four notification actions). There are no other limits.

## 1. The pairing offer and its QR payload

### Making an offer

`POST /api/inbox/pairing` is a window route with the window's guards (the Host allowlist, `isSameOriginOrNoOrigin`, the `serverSession` stale-tab check). Body `{ serverSession? }`. It answers `201` with the offer and the link the window draws as a QR code (`uqr`, already a dependency of `packages/server`):

| Field | Meaning |
|---|---|
| `offer.code` | Six decimal digits, uniform over `000000` to `999999`, shown beside the QR code for typing (1.2, 1.3) |
| `offer.expires_at` | ISO time, 10 minutes after the offer was made |
| `link` | The `plannotator://pair` link below |
| `computer.name` | The computer's name: macOS `scutil --get ComputerName`, else the first label of `os.hostname()` |
| `addresses.tailnet` | `host:port` of the tailnet publication, or null when "Reach from my tailnet" is off |
| `addresses.lan` | `ip:port` of the LAN listener, or null when "Reach from this Wi-Fi" is off |
| `addresses.fingerprint` | The LAN certificate's SHA-256 (section 3), or null with the LAN off |
| `reachable` | The code carries an address a phone can use (added 2026-10-12 for the window's Pair a phone flow, which shows a code only once a way is on; the phone never reads this answer) |

The window also reads, for Pair a phone (window routes, never on the door; the phone's exchanges are unchanged): `GET /api/inbox/pairing`, the last offer's state and what reached the door while it showed (`attempts`: which listener, and wrong code, digits over the Wi-Fi, an older code, after it closed, or redeemed; never the secret or the code), and `GET /api/inbox/pairing/checks`, what this computer can tell about the two ways before any is on.

An offer is single use. It closes when it is redeemed, when it expires, after 5 wrong codes, or when the window makes a new one: one offer is open at a time, so six digits always name one offer. The offer lives in the server's memory only; a restart closes it.

Pairing needs the phone to reach the computer once, over the same Wi-Fi or the tailnet; the relay does not carry a redemption in v1. With both addresses null the offer still answers (a simulator reaches the Inbox on `127.0.0.1`, `reachable: false`), and the window never shows such a code: Pair a phone starts at "How will your phone reach this computer?" and shows the code only once a way is switched on.

### The tailnet publication

"Reach from my tailnet" opens a second loopback listener that serves the door and nothing else (section 2, "Where the door answers") and publishes it with `tailscale serve --bg --https=8443 http://127.0.0.1:<door port>`: serve, never funnel. The window's port is never published. The HTTPS port is 8443, kept in `inbox.json` as `tailnet: { https_port: 8443, door_port }`, so the address a phone holds survives the local ports moving; the door listener takes `door_port` again when it is free, and the mapping is pointed at it at each start. When another serve mapping already holds 8443, the window says so and the switch stays off: the Inbox never overwrites a mapping it did not make. `buildServeArgs` gains this two-port form in P1.

The mapping is the Inbox's own when its proxy target is this run's door listener or the last run's (`door_port`); only that one is re-pointed or taken down. The mapping and the door listener are taken down when the switch goes off and at every clean stop (quit, the stop route, and a restart to update, which takes them down before it starts the new binary, so the two never race). The switch stays on in `inbox.json` and the next start publishes again. A mapping a crash left behind (kill -9) is re-pointed by the next start before anything else, or taken down when that start cannot publish; a terminal hangup (SIGHUP) of a foreground Inbox runs the clean stop while a mapping exists; and `uninstall --purge` takes a leftover down by `door_port`. A take-down that fails (Tailscale cannot answer) changes nothing: switching off then answers `409 tailnet_unavailable` with the manual command, and `door_port` stays in `inbox.json` for the next try. The window's own port never adds the tailnet name to its Host allowlist (added in the P1 follow-up).

The switch's window route (added in P1; the first draft named the switch but no route):

- `GET /api/inbox/tailnet`: `{ tailnet: { on, address, error } }`. `on` is the person's switch as `inbox.json` keeps it; `address` is the published `host:port`, null while the publication does not work; `error` says why, in the window's words (Tailscale stopped or signed out at start, for example).
- `POST /api/inbox/tailnet` (window guards) `{ serverSession?, on }`: `{ tailnet }`. Turning it on publishes at once: `409 tailnet_port_taken` when another mapping holds 8443, `409 tailnet_unavailable` when Tailscale cannot publish (not installed, not running, signed out), and the switch stays off. Turning it off takes the Inbox's own mapping down and clears `tailnet` from `inbox.json`.

How the phone finds a computer on the tailnet (1.3, "On your tailnet"): it does not discover one. Bonjour does not cross a tailnet and an iOS app cannot ask Tailscale for its peers, as the record's own caption for 1.3 says. The section lists the tailnet address of each computer this phone already knows (from a QR it scanned) and a row to type the `host:port` the Inbox prints; either way the person then types the six digits.

### The link

```
plannotator://pair?v=1&name=MacBook%20Pro&tailnet=macbook-pro.tail0000.ts.net%3A8443&lan=192.168.1.24%3A47321&fp=abab...ab&secret=AAAA...A&code=482913
```

| Parameter | Value | Present |
|---|---|---|
| `v` | `1` | always |
| `name` | `computer.name`, percent-encoded | always |
| `tailnet` | `host:port`, HTTPS | when the tailnet publication is on |
| `lan` | `ip:port`, HTTPS with the pinned certificate | when the LAN listener is on |
| `fp` | the LAN certificate's SHA-256, 64 lowercase hex | with `lan` |
| `secret` | the pairing secret: 32 random bytes, base64url without padding (43 characters) | always |
| `code` | the six digits | always |

The phone reads a link with an unknown `v` as "update the app". Both addresses are tried in order (LAN, then tailnet) for the redemption by the QR's secret; typed digits go to the tailnet or loopback only, never the LAN (section 3). The relay's address and mailbox arrive in the redemption's answer, not in the link.

## 2. The device token door

### The device record

`inbox/devices.jsonl`, on the store's line rules: append only, each line a full snapshot `{ v: 1, at, id, record }`, the last line per id is current, a torn last line is skipped, fields are only added. Devices are not store records: they carry no `seq` and never enter the event log, the event stream or the relay.

```ts
interface InboxDevice {
  id: string;              // `dev_<ULID>` (inboxId gains the "dev" prefix)
  name: string;            // as the phone sent it; checked like a thread name (checkInboxThreadName)
  platform: string;        // "ios"
  token_sha256: string;    // hex SHA-256 of the whole token string; the token itself is never stored
  created_at: string;
  last_seen_at: string;    // kept in memory on every request; a line is written when its UTC day changes
  revoked_at: string | null;
  carriage: boolean;       // the relay carries this phone's items and pushes; true at pairing, set by the phone's relay switch (9.2, section 4)
}
```

The token is `tok_` plus 32 random bytes as base64url (47 characters). It is returned once, by the redemption. A revoked record keeps its hash, so a revoked token answers `device_revoked`, not `device_token_invalid`.

Each device also has its pairing secret kept on the computer, in `inbox/device-secrets/<dev id>` (mode 0600, the directory 0700): the base64url secret, nothing else. The relay keys are derived from it (section 4). Revoking a device deletes the file.

### Redeeming an offer

`POST /api/inbox/device/pair`, the one door route without a token. Body: `{ secret, name, platform }` (the QR path) or `{ code, name, platform }` (typed digits, 1.3). Answers:

- `201 { device, token, secret, computer: { name }, addresses: { tailnet, lan, fingerprint }, relay }`. `secret` is the offer's pairing secret, returned on both paths, so a phone that paired by digits holds it too. `relay` is `{ url, mailbox_id }` once the Inbox has a mailbox, else null. When a mailbox exists the Inbox registers the new device at the relay before answering (section 4); if the relay cannot be reached it registers it when its socket next connects.
- `410 offer_expired` when no open offer matches: never made, used, expired, replaced, or closed by wrong codes.
- `400 code_not_accepted_here` on the LAN listener for a redemption by `code` without `secret`: over the Wi-Fi a phone pairs by the QR only (section 3). The window's port and the tailnet's listener take both. The offer is untouched: no wrong try is counted.
- `401 pairing_code_wrong { tries_left }` on a wrong code. The fifth wrong code closes the offer and answers `tries_left: 0`.
- `422 validation_error` with no `secret` or `code`, or a bad `name`.

The first redemption makes the mailbox when there is none yet (section 4).

### Listing and revoking

- `GET /api/inbox/devices` (window route): `{ devices: [device without token_sha256] }`, the devices not revoked, newest first.
- `POST /api/inbox/devices/:id/revoke` (window route, window guards) `{ serverSession? }`: `{ device }`. Deletes the device's secret file and its relay registration, and ends the device's open event streams. An unknown id is `404 device_not_found`.

Every `device` a route answers (7.2, 7.25, 7.36, 7.37) is the record without `token_sha256`, `carriage` included; 7.2 and 7.25 below leave `carriage` out of their examples for brevity.
- `POST /api/inbox/device/revoke` (door route, the phone's own token): revokes the calling device, for "Remove this source" (9.2), with the same effects as the window's revoke. `{ device }`. Revoking twice changes nothing.

### The door

Every phone request goes to `/api/inbox/device/*`. The door's checks, in order:

1. Any `Origin` header: `403 origin_not_allowed`. A browser is never a device.
2. `pair`: no token (above).
3. `Authorization: Bearer tok_...`. None: `401 device_token_missing`. No device with that hash: `401 device_token_invalid`. A revoked device: `401 device_revoked`.
4. The path is in the allowlist below, else `404 device_route_not_found`.
5. A POST in the allowlist carries `idempotency_key` in its body (section 6), else `422 validation_error`. The two exceptions are `pair` and `revoke`, which change nothing when repeated. The two raw-body routes, `uploads` and `markups` (added 2026-10-15), carry it in the query instead (`?idempotency_key=`), since their body is a file.
6. The request is handed to the window's own handler under the window's path. The door adds nothing to the route, the query or the body; the phone sends no `serverSession`, which the window's guard accepts (`checkServerSession`: absent passes). Of the phone's headers it passes on only `Last-Event-ID` (the event stream), `If-None-Match` (the image routes' cache validator, added 2026-10-14 with `messages/:id/image`), so a phone that cached an image gets the window's `304`, and on a GET `Range` and `If-Range` (a player's byte range, section 11). On the two raw-body routes it also passes on `Content-Type` and `Content-Length` and streams the body through with the query unchanged (key included); a `serverSession` the phone puts in that query is checked by the window like any other, so a wrong one is `409 session_mismatch`. The door bounds a raw body itself, because the window's handler runs in-process where the listener's request size bound does not apply: 100 MB for `uploads` (`413 upload_too_large`), 32 MB for `markups` (`413 markup_too_large`). A declared `Content-Length` past the bound is refused before a byte is read; a body without one (chunked) is counted as it streams and cut at the bound. Either answer carries `Connection: close`, and nothing is recorded under the key. After a replay or a refusal the door reads and drops what is left of the body only up to 1 MiB or 2 s, then answers with `Connection: close` (a client should not reuse that connection). The "referenced in that message's body" rule limits what an agent's message exposes, not what the person's own clients can read: a paired device, like the window, can send a reply that references any image-type file of 10 MB or less under a project root and then read it, so a device token is as powerful as the window (revoke a lost phone), and over the relay the phone gets the image bytes with only a content type, so the app must draw an SVG as an untrusted image.

Where the door answers. On the loopback listener, the door sits beside the window. The tailnet reaches a second loopback listener, open only while "Reach from my tailnet" is on, that serves the door and nothing else: any path outside `/api/inbox/device/` answers `404 device_route_not_found` there, whatever its Host. `tailscale serve` points at that listener, never at the window's port. On the LAN listener only the door exists (section 3).

Corrected in P1 (from the review of PR 1776): the first draft kept tailnet requests on the door by their Host header, on the assumption that "through `tailscale serve` the Host is the MagicDNS name". It is the client's own Host: `tailscale serve` passes it through (`r.Out.Host = r.In.Host`), so a tailnet peer sending `Host: localhost` passed the loopback allowlist and reached the window's routes (the pairing offer, `/mcp`, settings, restart). The separation now comes from the socket, as the LAN listener's does, and no Host is read for it.

The allowlist. Each row is the window's handler as it is today, with the request and answer the window uses (`docs/agent-guides/server-and-storage.md`, "Inbox Server"). Exchange numbers point at section 7.

| Door route | Window route | Request | Answer | Exchange |
|---|---|---|---|---|
| `GET health` | `GET /api/inbox/health` | | `{ ok, app, version, serverSession, pid, update, notify_reach?, event_streams?, peek? }` (`notify_reach` additive: whether an open Inbox tab on the computer can show a browser notification; `event_streams` additive: event streams open on the computer, a diagnostic the phone may ignore; `peek` additive, 2026-10-27: `true` when read_thread honours the peek mark the agent connections read the session's thread list with, which the phone may ignore); the cheapest read, the phone's reachability probe for 9.2 | 7.4 |
| `GET threads[?project=prj_...][&archived=include\|exclude]` | `GET /api/inbox/threads` | | the list model: `{ serverSession, version, cursor, update, notice, projects, project, sections, pins }` (`decisions_waiting` was removed with Decisions, 2026-10). Archived threads stay in the Quiet section unless the phone asks `archived=exclude` (added 2026-10-12, when the window moved them out of its list into Settings; the default keeps this exchange as it was, so a phone that draws the sections loses no thread). "Archived" means resolved and not come back: an agent's `reply_to` reply after the archive line brings the thread back into the sections while something there waits (as news, Waiting when it asks, Sent after the reply), with the additive row fields `agent_after_archive` and `back_from_archive`, in both modes; once handled it is archived again by itself. Its later messages are answerable without unarchiving (picks, reply, annotations, the lock-screen answer), its earlier ones stay closed, and the thread stays resolved. `pins` (additive, 2026-10-24, approval "inbox-pinned-threads"): the threads pinned to the computer's sidebar, as rows in pin order, whatever `project` or `archived` (an archived thread stays pinned), and each row's additive `pinned_at`. Read only: the door has no pin write in v1 (`threads/:id/pin` and `pins` answer `device_route_not_found`), and a pin makes no store line, so the event stream and the relay carry nothing for it; a phone sees another device's pin at its next list read. `waits` (additive, approval "inbox-row-badges"; absent when none, and from an older Inbox): on a row, what its Stopped / Holds up badge holds, `[{ message_id, key, position, prompt, stopped, holds_up }]` in thread order, at most 8, words capped; the door forwards it unchanged, and a phone may draw it or ignore it (the window draws it as a hover card; on a phone the thread shows the details) | 7.5 |
| `GET threads/archived[?project=prj_...&offset=n&limit=n]` | `GET /api/inbox/threads/archived` | | `{ serverSession, cursor, project, projects: [{ id, name, archived }], total, offset, limit, threads: [row] }`: the archived threads, newest archived first, a page at a time (`limit` 1 to 200, default 50). An explicit allowlist row (GET, read only), before `threads/:id`; added 2026-10-12, no exchange of its own | |
| `GET projects` | `GET /api/inbox/projects` | | `{ serverSession, cursor, projects: [{ id, key, name, root, created_at, threads, unread, listed, archived }] }` (`listed` and `archived`, additive: threads the window's list holds and the archived rest; the window hides a project with `listed` 0) | 7.6 |
| `GET threads/:id` | `GET /api/inbox/threads/:id` | | `{ serverSession, cursor, thread, row }` (`decisions` was removed with Decisions, 2026-10; `row`, the thread's list row, and `thread.archive_seq`, the archive line's seq or null, additive since 2026-10-12) | 7.7 |
| `POST threads/:id/seen` | same | `{ idempotency_key, through_seq? }` | `{ thread: row }`. `through_seq` (optional, added 2026-10-12 with seen on sight, design record "inbox-new-in-open-thread"; additive, the door forwards it unchanged): an integer, the seq (`thread.messages[].seq`) of the newest message the phone actually showed. The look then covers only the agent messages at or below it, so a message that landed after the phone read the thread stays new. Behind the recorded look (at or below it): no-op, nothing written, the look is never lowered; ahead of the thread's newest message: capped to the newest (the same as no `through_seq`). Absent or `null`: every agent message so far, as before. Anything but a whole number of 0 or more: `422 { "code": "validation_error", "field": "through_seq" }`, nothing written. An Inbox older than the field ignores it and marks everything | 7.8 |
| `POST threads/:id/read`, `POST threads/:id/unread` | same | `{ idempotency_key }` | `{ thread: row }`: Mark read (the row goes to Quiet, its waiting questions close unanswered; on a thread that came back from the archive it goes back to Archived at once, even while the person's earlier reply there waits on the agent) and its Undo (it reopens only the questions that Mark read closed; one an earlier Mark read closed stays closed); added after section 7, no exchange of its own. Row semantics since 2026-10-12, the wire unchanged: the Inbox's own notes to the agent (person messages carrying `set_aside` or `reopened`) are neither the person's reply nor a look, so a row's `sent`, `unseen`, `waiting_on_person` and `back_from_archive` read past them (and `waiting_on_person` is false while a Mark read stands), and the row gains the additive `last_agent_at` (the latest agent message's time; `last_at` and `last_author` still count the notes). The thread-state model (`adr/implementation/inbox-thread-state.md`) and its trace fixtures say the same | |
| `GET events[?cursor=n]` | `GET /api/inbox/events` | `Last-Event-ID` or `?cursor=` (a valid `Last-Event-ID` header wins over `?cursor=`) | SSE: `hello`, `record` per store line (`id:` = seq), `status`, a heartbeat every 15 s | 7.9 |
| `POST messages/:id/picks` | same | `{ idempotency_key, questions: [{ key, revision, answer or null }], unsent_only? }` (`unsent_only: true`, optional: refuse a pick on a question a reply already sent, see 7.10) | `{ message_id, questions, reply: null }`; `409 question_already_sent` with `unsent_only` | 7.10 |
| `POST messages/:id/reply` | same | `{ idempotency_key, words?, questions?, skip?, feedback?, annotation_ids?, uploads?, tags? }` (`questions: [{ message_id?, key, revision, answer? }]`: the picks; one on another message of the same thread and session names it with `message_id`, so one Send to one session is ONE reply. `skip: [key \| { message_id?, key }]`: the open questions the person chose to skip with "Skip them", and nothing else; see 7.11. `skip_unanswered` is ignored since approval "inbox-explicit-skip", 2026-10-21. `uploads`: `upl_` ids from 7.48, which become attachments on the reply, see 7.57; `tags`: the agent sessions the person tagged with `@`, see 7.60) | `{ message_id, questions, reply, replayed }`; `{ message_id, questions, reply: null, nothing_to_send: true }` when only skips were listed and none is still open | 7.11 |
| `POST messages/:id/resolve` | same | `{ idempotency_key, resolved? }` | `{ thread: summary }` | 7.12 |
| `POST messages/:id/ack` | same | `{ idempotency_key, ack? }` (`ack: false` takes it back) | `{ message, thread: row }`: 👍 Looks good (design record "inbox-acknowledge", 2026-10-15). Silent: nothing is sent, no session is woken, no push. The message gains `ack: { label, at, read_seq, made_read, settled_seq, settled_at, seen_at }` and the thread is marked read (Quiet until an agent writes again); the row gains the additive `ack: { label, at }` while that read holds (draw "👍 Looks good" in place of "Read"). `ack: false` removes it and undoes the Mark read when the 👍 made it (`made_read`); `threads/:id/unread` on that read withdraws the ack too. Only the thread's latest agent message, only while no question in the thread is open or picked and the person has not replied after it: `422 ack_not_allowed` (a person's message), `409 ack_stale` (a newer agent message), `409 ack_after_reply`, `409 question_open`, `409 thread_resolved`. An Inbox before it answers `404 device_route_not_found`. Added 2026-10-15. Amended 2026-10-16 (the owner: "send looks good through"): once the Undo window passes with the 👍 standing, the Inbox delivers it to the agent through a note, a person's message carrying `ack_of: <message id>` (body "The person marked your message 👍 Looks good (<message id>). No reply needed unless you have a question."), and the ack gains `note_id`; when the person replied or the agent wrote again inside the window, the ack settles with `not_sent: "replied" \| "wrote_again"` and no note. **A phone never displays a message with `ack_of`**: the thread route leaves it out, but the relay and the event stream send every store line, so a phone that builds threads from lines must drop it (it is one of the Inbox's own notes, like `set_aside` and `reopened`: not the person's reply, not a look). The window's thread adds `ack.delivered_at` (when it reached the agent) | 7.56 |
| `POST messages/:id/actions/:key` | same | `{ idempotency_key, outcome: "done" \| "cant" \| null, note? }` (`key` an `a-…` action item key; a note with Done is optional, the reason with Can't do it required; `null` is the Undo) | `{ questions }`: the message's questions and action items, the action item `picked` while its Undo window runs. `409 action_already_sent` (sent: no Undo), `409 action_closed`, `422 validation_error`. Added 2026-10-21 (approval "inbox-next-actions") | 7.63 |
| `POST messages/:id/to` | same | `{ idempotency_key, to: { host?, session } }` | `{ message, row }`: Send to another session, for a person message no session took yet. `409 already_delivered`, `409 thread_resolved`, `422 not_addressed`, `409 session_not_live` pass through. Added 2026-10-15 | 7.41 |
| `POST threads/:id/delete` | same | `{ idempotency_key }` | `{ ok, store }` | 7.13 |
| `GET threads/:id/attachments` | same | | `{ serverSession, attachments: [state], inline_images: [state], annotations }` (`inline_images` additive, 2026-10-15) | 7.14 |
| `GET attachments/:id/view[?version=sent]` | same | | `{ serverSession, attachment, version, text, html }`; also Share (the "..." menu of section 4 of the record), which writes `text` to a file named `attachment.name` | 7.15 |
| `GET html-assets/<token>/<path>` | `GET /api/html-assets/<token>/<path>` | | the asset's bytes, as annotate serves them | 7.16 |
| `GET messages/:id/image?path=<src as written>` | `GET /api/inbox/messages/:id/image` | `If-None-Match` (optional) | an image the message's body shows, its bytes with the window's headers exactly: `Content-Type` sniffed from the bytes (never the name), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, no-cache`, `ETag` (the SHA-256 of the bytes served), `X-Image-Width`/`-Height` when the header parses; `304` with the same headers when `If-None-Match` names the current ETag. The body is the whole message, so an image in a `:::question` block's context counts. Refused as the window refuses: `403 image_not_referenced` (not in that message's body), `403 image_hidden` (a dotenv-named file, or a hidden folder of the home folder or of `/` such as `~/.ssh`, outside the project and the folder sent from, as named or through a symlink; since 2026-10-16 an agent's images otherwise load from anywhere the user can read, and since 2026-10-29 other hidden folders such as a project's sibling `.ops/` too), `403 outside_project` (the person's own message, a reply posted from the phone included, names a file outside the project), `403 image_unreadable` (the system will not let Plannotator read it), `500 image_read_failed`, `404 message_not_found` / `image_missing`, `409 image_changed`, `413 image_too_large` (10 MB or 50 megapixels), `415 not_an_image`. Remote `http(s)` sources are not served. Cache by message id plus `path`, and revalidate with `If-None-Match` (the file lives on disk and can change). Added 2026-10-14 | 7.38 |
| `GET attachments/:id/video[?version=sent]` | same | `Range`, `If-Range` (headers; with `If-None-Match` and `Last-Event-ID`, the only ones of the phone's the door forwards) | a video's bytes by HTTP Range: `206` with `Content-Range`, `200`, or `416`; kind `video` only, else `415 attachment_not_video`. Added 2026-10-15 (section 11) | 11.3 |
| `GET attachments/:id/download[?version=sent]` | same | `Range`, `If-Range` | any kind's bytes; honors Range the same way since 2026-10-15 (section 11) | 11.4 |
| `POST annotations` | same | `{ idempotency_key, attachment_id, version, annotation }` | `{ annotation }` | 7.17 |
| `POST annotations/:id/remove` | same | `{ idempotency_key }` | `{ annotation }` | 7.18 |
| `GET messages/:id/guide` | same | | `{ message_id, guide, snapshot }` | 7.19 |
| `POST messages/:id/guide/reviewed` | same | `{ idempotency_key, reviewed: boolean[] }` | `{ message_id, reviewed }` | 7.20 |
| `POST messages/:id/guide/annotations` | same | `{ idempotency_key, annotation }` (the review app's line comment: `id`, `filePath` in the guide's patch, `side` `old`/`new`, `lineStart`/`lineEnd`, `text`); an edit is the same annotation id under a new key | `{ annotation: record }`. Removed through `annotations/:id/remove` (7.18). The window's refusals pass through: `422 validation_error` (a file not in the patch, a bad side, lines not in one hunk), `404 guide_not_found` / `message_not_found`, `409 annotation_closed`, `409 thread_resolved`. Added 2026-10-15 | 7.53 |
| `POST messages/:id/annotations` | same | `{ idempotency_key, annotation }` (Plannotator's text-selection annotation on an agent's message: `id`, `type` `"COMMENT"`, `originalText` the words selected, `text`); an edit is the same annotation id under a new key | `{ annotation: record }` with `message: { at }`. Removed through `annotations/:id/remove` (7.18). The window's refusals pass through: `422 annotation_not_allowed` (the person's own message), `422 validation_error`, `404 message_not_found`, `409 annotation_closed`, `409 thread_resolved`. Added 2026-10-19 | 7.59 |
| `GET threads/:id/sessions` | same | | `{ serverSession, home, project, sessions }` (`?asker=<session>` adds `asker: { session, live, connection }`, `connection` = `{ busy, idle_since, send_now }` while that session's connection polls, else null; each session carries `send_now`) | 7.23 |
| `POST messages/:id/send-now` | same | `{ idempotency_key }` | `{ message }` with `deliver_now_at`: Send now (2026-10-16). The session the person's reply or message goes to gets it at once, into its running turn when one runs. Offer it only while `asker.connection.send_now` and `busy` are true (draw "Undelivered N min · <agent> is working · goes in by itself in M min", below); `409 send_now_unavailable` when that session's connection does not poll now or cannot take it mid-turn, `409 already_delivered`, `422 not_addressed`. A second press writes nothing. An Inbox before it answers `404 device_route_not_found` | 7.58 |
| `POST threads/:id/message` | same | `{ idempotency_key, session, body }` | `{ message, replayed }` | 7.24 |
| `GET threads/:id/taggable` | same | | `{ serverSession, owner, sessions: [{ session, host, kind: "live" \| "mcp", name, project, started_at, last_at, busy, idle_since, taggable, owner, wrote_thread }] }`: who the person can tag with `@` in a reply (added 2026-10-20) | 7.60 |
| `GET threads/:id/draft` | same | | `{ serverSession, draft }`: the words typed in the thread's reply box on the computer and not sent (`{ v, thread_id, body, created_at, updated_at }`, or null). Read only: the door has no route that writes a reply draft. An Inbox before it answers `404 device_route_not_found` | 7.62 |
| `GET sessions[?session=ses_...]` | `GET /api/inbox/sessions` | | `{ serverSession, home, projects: [{ project: { id or null, name, root }, sessions: [{ session, host, started_at, last_seen_at, busy, idle_since, last_thread }] }], session? }`: every live session, any project (compose's To). A snapshot: a session may have ended by the time a relayed answer is read. Added 2026-10-15 | 7.39 |
| `POST messages` | `POST /api/inbox/messages` | `{ idempotency_key, to: { host?, session }, body, uploads?: [upl_...], thread_name?, thread_name_auto?, board_request? }` | `{ thread_id, message, project, replayed }`: a thread the person starts, addressed to one live session. `draft_id` (which deletes a shared draft) is refused by the door, `422 { "field": "draft_id" }`: drafts stay on the computer. The body key is also the store's own. `409 session_not_live` (nothing written), `503 project_unresolved` (not recorded, so the same call runs again), `422 validation_error`, `409 idempotency_key_reused` pass through. `thread_name` (optional, added 2026-10-16) is the thread's name, its chip, checked by the thread-name rules (`422 validation_error`) and refused with `409 thread_name_taken` (nothing written) while another open thread of the project has the name; an agent never replaces it. `thread_name_auto: true` (optional, added 2026-10-16) marks `thread_name` as compose's own suggestion: dropped instead of refused when not valid or taken, and replaced by the agent's first name. A name refused here (`409 thread_name_taken`, `422`) is stored by the door under the idempotency key like any 4xx, so a retry with another name, or none, must use a NEW idempotency key; the same key answers the stored refusal again. `board_request: true` (optional, added 2026-10-27, the compose Board chip) asks the agent to track the work on the Board: kept on the thread's root only while the person has the Board on (else ignored, never refused); the words stay as typed and the message carries `board_request: true`; the agent receives a Board request block after them. Added 2026-10-15 | 7.40 |
| `GET search?q=&project=&status=&from=&group=&offset=&limit=&current=` | `GET /api/inbox/search` | | the window's search answer: `{ serverSession, q, terms, took_ms, indexing, threads, totals, groups, recent, recent_searches? }`. `indexing: true` with no groups: ask again. Read only; the window's cross-site check passes because the door sends no `Origin` and forwards no fetch metadata. Added 2026-10-15 | 7.42 |
| `POST projects/:id/read`, `POST projects/:id/unread`, `POST projects/:id/resolve` | same | `{ idempotency_key }`; Undo of read `{ idempotency_key, threads: [ids] }`; Archive all `{ idempotency_key, resolved?: true }`, its Undo `{ idempotency_key, resolved: false, threads: { resolved: [ids], read: [ids] } }` | `{ project, batch?, threads, skipped?, error?, replayed }`: the project menu. The door's log (on disk) replays a batch's recorded answer, `threads` lists included, so a retry never runs a second batch; the window's own `batch_id` (in memory) may also be sent. An Undo that lands after the 10 s set-aside delay sends the agents the "Set aside" notes and then the "reopened" notes. Added 2026-10-15 | 7.43, 7.44, 7.45 |
| `GET skills` | `GET /api/inbox/skills` | | `{ skills: [{ name, root, description?, humanOnly, dir }] }`. Added 2026-10-15 | 7.46 |
| `GET skills/content?name=` | `GET /api/inbox/skills/content` | | `{ skill: { name, dir, path, content, truncated, humanOnly } }`, content capped at 20,000 characters; `404` for a name not discovered. Added 2026-10-15 | 7.47 |
| `POST uploads?name=<name>&idempotency_key=<key>` | `POST /api/inbox/uploads?name=` | the file's bytes, raw | `{ upload: { upload_id, name, size, kind, sha256, created_at, media_type?, width?, height? } }`; `413 upload_too_large` (100 MB), `422 upload_refused` (dotenv names, path separators). A retry with the key answers the same `upl_` id. Not carried by the relay (section 4). Added 2026-10-15 | 7.48 |
| `POST markups?idempotency_key=<key>` | `POST /api/inbox/markups` | a PNG, JPEG or WebP, raw, at most 32 MB | `{ path, name, url }` (the name is the bytes' SHA-256; read back with `GET markups/<name>`); `422` when the body is not one of those images; `413 markup_too_large` past 32 MB. Not carried by the relay (section 4). Added 2026-10-15 | 7.49 |
| `POST revoke` | (the door's own) | `{}` | `{ device }` | 7.25 |
| `POST pair` | (the door's own) | `{ secret or code, name, platform }` | see above | 7.2, 7.3 |

Door routes are written relative to `/api/inbox/device/`; window routes keep their full paths.

**Decisions removed (2026-10).** The owner removed Decisions from the Inbox (and from Workspaces): the routes `POST messages/:id/decision` (7.21) and `GET decisions` (7.22) are gone from the allowlist and answer `404 device_route_not_found`, 7.54 and 7.55 (retire, replace) will never be built, and these fields left the wire: the list model's `decisions_waiting`, the thread read's `decisions`, a Send's `decisions` and `decisions_refused`, and each question's `decision_on_answer`, `decision_id`, `decision_recording` and `decision_draft`. A `Decision:` line an older agent wrote in a question block is context now. A phone app drops the Decisions screen, the card's decision switch and any reader of those fields.

What the door never answers, by construction (none is in the allowlist, and the tailnet's listener serves nothing else): `/`, `/favicon.png`, `/mcp`, `/api/inbox/bridge/*`, `/api/inbox/control/*`, `/api/inbox/attachments/:id` (raw bytes; every attachment kind is text and `view` carries it), `/api/inbox/settings`, `/api/inbox/restart`, `/api/inbox/projects/:id/delete`, every Decisions route (removed: `/api/inbox/decisions`, `/api/inbox/decisions/:id/retire` and `replace`, `/api/inbox/messages/:id/decision`), `/api/inbox/drafts*` (shared drafts: exchanges 7.50 to 7.52 are held for them, not built), `/api/inbox/search/recent` (the phone keeps its own recent searches), `/api/inbox/open-in*` and `/api/inbox/attachments/:id/page`, `/api/inbox/pairing`, `/api/inbox/devices*`, `/api/inbox/tailnet`, `/api/inbox/lan`. The computer chores stay on the computer (decision 5). The bridge and control routes keep their own guards and refuse a device token like any other wrong token (`401 unauthorized`).

### Error codes

The door answers in the window's shape, `{ error, code, ...details }`, with these codes of its own; every code a window handler answers today passes through unchanged (`validation_error`, `thread_not_found`, `question_revision_conflict`, `session_not_live` and the rest of `ERROR_STATUS` in `packages/server/inbox.ts`).

| Status | Code | When |
|---|---|---|
| 401 | `device_token_missing` | no `Authorization: Bearer` |
| 401 | `device_token_invalid` | no device has that token |
| 401 | `device_revoked` | the device was removed; the phone shows its source as removed |
| 403 | `origin_not_allowed` | an `Origin` header on a door request |
| 404 | `device_route_not_found` | a door path outside the allowlist, and any path outside the door on the tailnet's door listener |
| 410 | `offer_expired` | redemption with no open offer matching |
| 401 | `pairing_code_wrong` | a wrong six-digit code, with `tries_left` |
| 409 | `idempotency_key_reused` | a key this device already used on another route (section 6) |
| 404 | `device_not_found` | the window's revoke names no device (window route) |
| 409 | `tailnet_port_taken` | the window's tailnet switch: another mapping holds 8443 (window route) |
| 409 | `tailnet_unavailable` | the window's tailnet switch: Tailscale cannot publish (window route) |
| 409 | `lan_unavailable` | the window's Wi-Fi switch: `openssl` cannot make the certificate (window route, section 3) |
| 400 | `code_not_accepted_here` | a redemption by six digits on the LAN listener: over the Wi-Fi a phone pairs by the QR only (section 3) |
| 413 | `upload_too_large`, `markup_too_large` | a raw body past its bound (100 MB, 32 MB), declared or counted as it streams; answered with `Connection: close`, not recorded under the key |
| 422 | `validation_error` with `field: "draft_id"` | `POST messages` naming a draft: drafts stay on the computer |
| 413 | `relay_upload_unavailable` | `uploads` or `markups` as an up command through the relay: files go over the Wi-Fi or the tailnet in v1 (section 4) |

## 3. The LAN listener

Off until "Reach from this Wi-Fi" is switched on in the window's Settings (P2).

- **What it serves:** the door, and only the door: the same door-only handler as the tailnet's listener (section 2). Anything outside `/api/inbox/device/` answers `404 device_route_not_found`, whatever its Host, Origin or encoding. It skips the Host allowlist: it serves only a bearer door that refuses any Origin, and a browser cannot present the token.
- **Where:** all interfaces (`0.0.0.0`), on a port chosen free the first time and kept in `inbox.json` as `lan: { port, on }`, so the address a phone holds, or a person wrote down, survives a restart and switching off and on again. Not the Wi-Fi interface's address alone (re-checked in the P2 follow-up): a socket bound to one IPv4 address stops answering when a new DHCP lease moves it, and keeping it right would need a watcher on address changes and a rebind, a layer this listener does not need; binding to the interface itself (`IP_BOUND_IF` on macOS, `SO_BINDTODEVICE` on Linux) would survive a new lease, but `Bun.serve` exposes neither. So it stays all interfaces: a new address is served at once, the Bonjour record keeps pointing at a live port, and every interface (loopback and a tailnet's included) reaches the same door-only handler over the same pinned TLS and nothing else.
- **The address in the link (`lan`):** `ip:port`, where the ip is the first IPv4 address of an interface that is up, not loopback, not link-local (169.254/16) and not Tailscale's (100.64/10), private ranges first. It is read when the offer is made, so it follows the computer to a new network. With no such address the listener keeps running, `lan` is null, and the window says the computer is not on a network.
- **TLS:** an ECDSA P-256 certificate, self-signed, subject `CN=Plannotator Inbox`, valid for 100 years (the phone reads no dates), made by `openssl` as child processes the first time the listener starts (`openssl ecparam -name prime256v1 -genkey -noout`, then `openssl req -new -x509 -days 36500 -subj "/CN=Plannotator Inbox"`, two steps, which macOS's LibreSSL 3.3 and OpenSSL 3 both accept) and kept in `inbox/tls/cert.pem` and `inbox/tls/key.pem` (files 0600, directory 0700; LibreSSL writes the files 0644, so they are made inside the 0700 directory and set to 0600 after). It is never rotated. Deleting `inbox/tls/` makes a new one, and every phone paired over the Wi-Fi pairs again. With `openssl` missing or failing, the switch answers `409 lan_unavailable` and stays off.
- **The fingerprint:** SHA-256 of the certificate's DER bytes, 64 lowercase hex. It rides the link as `fp` and the Bonjour record as `fp`.
- **What the phone checks:** the leaf certificate's SHA-256 equals the fingerprint it holds. Nothing else: no host name, no chain, no dates. The pin is the check.
- **Pairing over the Wi-Fi is by the QR only** (ruled 2026-10-08 after the review of PR 1780). The fingerprint reaches the phone from the computer's screen, never from the network. The reason: anyone on the Wi-Fi can publish a Bonjour record with the computer's name, their own port and their own `fp`. A phone that pinned a record's `fp` and sent typed digits there would hand the person's own correct code to that listener, which relays it to the real Inbox on the first try, gets the token and the pairing secret (the relay keys derive from it), and sits in the middle for good; the five-try limit does not help. So the LAN listener's `pair` takes the 32-byte `secret` only and refuses a `code` with `400 code_not_accepted_here`. Typed digits stay for the tailnet (`tailscale serve` and MagicDNS authenticate the host) and for loopback (the simulator).
- **Bonjour:** while the listener is on, the Inbox advertises `_plannotator-inbox._tcp` through a child process (`dns-sd -R` on macOS, `avahi-publish -s` on Linux; no dependency; where neither exists the listener still works at the address the QR carries and the window says phones will not list it) with the instance name `computer.name`, the listener's port, and TXT `v=1` and `fp=<fingerprint>`. The record's `fp` is an identity hint only, for a computer the phone already paired by QR: the phone matches a found record to a known computer by the `fp` it holds, so a new IP address is followed without pairing again. A record whose `fp` the phone does not know is never pinned; 1.3's "On this Wi-Fi" row for it reads "Scan the code on <name>'s screen" and leads to the QR scan, not to the six-digit sheet (the record's render of 1.3 draws the digits sheet after a Wi-Fi row; that sheet belongs to the tailnet's rows and the typed address). The publisher runs under `sh`, which ends it when its stdin closes: the Inbox closes it on a clean stop, and the kernel closes it when the Inbox dies without one (kill -9), so no record outlives the Inbox.
- **Off and stops:** switching off closes the listener, ends the publisher and keeps `lan: { port, on: false }` in `inbox.json`; the certificate and the port stay, so switching on again keeps every phone's pin and every address (a start reads `on` absent as on, as P2 wrote it). A listener that cannot open at start (the certificate gone and `openssl` failing) leaves the switch on: the window shows it on with the reason, and switching it off works. A clean stop (quit, the stop route, a restart to update, before the new run starts) closes the listener and the publisher and leaves the switch on; the next start opens the same port again with the same certificate.

The switch's window routes (added in P2; the first draft named the switch but no route), beside the tailnet's:

- `GET /api/inbox/lan`: `{ lan: { on, address, fingerprint, bonjour, error } }`. `on` is the person's switch as `inbox.json` keeps it; `address` is the link's `ip:port`, null while the listener is closed or the computer has no network address; `fingerprint` is the certificate's SHA-256 while the listener runs; `bonjour` is true while the record is published (false where neither `dns-sd` nor `avahi-publish` exists: phones do not list the computer nearby, and the QR, which still carries the LAN address and `fp`, pairs them as before); `error` says why the listener is not working, in the window's words.
- `POST /api/inbox/lan` (window guards) `{ serverSession?, on }`: `{ lan }`. Turning it on makes the certificate if there is none, opens the listener and publishes the record at once; `409 lan_unavailable` when the certificate cannot be made, and the switch stays off. Turning it off closes both and keeps the port in `inbox.json` with `on: false`; it works whether or not the listener is open.

## 4. The relay

A Cloudflare Worker in `apps/relay/` with one Durable Object per mailbox, on the model of `apps/guides-show/worker`: it holds what it cannot read. The origin is `https://relay.plannotator.ai` (recommended; not yet deployed); `PLANNOTATOR_RELAY_URL` points the Inbox at `wrangler dev` in a proof.

Built in two steps (R1, 2026-10-08). R1 built the mailbox, its devices, the APNs token, push, the phone's relay switch and the Inbox's socket with its `hello` and `carriage` frames. R2 built the down items, the phone's fetch and ack, the commands up, `inbox_online`, and the socket's `item`, `command` and `applied` frames (written in by R2: the up key, the result item as the only file shape, the drain order, the two door routes the relay does not carry, and envelopes kept in parts).

### Keys

All made on the computer and the phone at pairing; none ever reaches the relay.

- **The pairing secret** `S`: the offer's 32 bytes, held by the phone (Keychain, this device only, shared with the notification extension's group) and by the computer (`inbox/device-secrets/<dev id>`).
- **The device key** `K = HKDF-SHA256(ikm = S, salt = UTF-8 bytes of the device id, info = "plannotator-inbox relay key v1", length = 32)`: the AES-256-GCM key of every envelope the Inbox sends this phone: the down items and the push.
- **The up key** `U = HKDF-SHA256(ikm = S, salt = UTF-8 bytes of the device id, info = "plannotator-inbox relay up v1", length = 32)`: the AES-256-GCM key of every command this phone sends up (written in by R2). With one key for both directions, a relay could hand a down envelope back to the Inbox as a command, and only the plaintext shapes would refuse it; with a key per direction, the Inbox's up key does not open it. A separate key is the smaller change: the envelope layout, `K` and the push stay as R1 built them, and no associated data has to be agreed byte for byte on both sides.
- **The relay secret** `R = HKDF-SHA256(ikm = S, salt = UTF-8 bytes of the device id, info = "plannotator-inbox relay auth v1", length = 32)`, base64url: the phone's bearer at the relay. The relay stores only `SHA-256(R)` as hex.
- **The mailbox secret** `M`: 32 random bytes, base64url, made by the Inbox with the mailbox and kept in `inbox/relay.json` (0600) as `{ v: 1, url, mailbox_id, secret }`. The Inbox's bearer at the relay. The relay stores only `SHA-256(M)` as hex.

Both hashes are taken over the bearer as sent, the base64url string's UTF-8 bytes, which is what the relay hashes when a request arrives (written in by R1). Web Crypto (`deriveBits` with `HKDF`; `deriveRelayKeys` in `packages/core/crypto.ts`) and CryptoKit (`HKDF<SHA256>.deriveKey`) both compute these. R1 commits test vectors made from all-zero inputs in `packages/core/fixtures/inbox-relay-vectors.json`: the pairing secret, the device id, `K`, `R`, `SHA-256(R)`, and three envelopes with their plaintexts; R2 adds `U` (`derived.up_key`) and one command envelope under it (`up_envelopes`). TypeScript checks them in `packages/core/crypto.test.ts`; the app's tests (M5) check the same file in Swift, and the device proof has each side open the other's envelopes.

### The envelope

Exactly the format `packages/core/crypto.ts` writes: `base64url(IV || ciphertext || tag)`, a fresh random 12-byte IV per envelope, AES-256-GCM with a 16-byte tag, no additional data, base64url without padding. The plaintext is UTF-8 JSON. R1 adds `encryptWithKey(plaintext, key)` and `decryptWithKey(envelope, key)` to `packages/core/crypto.ts` beside the existing pair, with the same byte layout.

### What the relay stores and deletes

- **Per mailbox:** `secret_sha256`.
- **Per device:** `secret_sha256`, `carriage` (the phone's relay switch), the APNs token and its environment (plain: Apple needs it), `cursor` (the highest store seq the Inbox has posted for it, a number), the next item number `n`, the down items `{ n, cursor, ciphertext }`, the up commands `{ id, ciphertext }` in the order they arrived. An envelope is kept in parts of at most 1,000,000 characters, one row each, and joined when read: a SQLite-backed Durable Object refuses a row above 2 MB, and the relay sets no item size of its own (written in by R2). Items and commands are bounded only by the platform's own request and WebSocket message limits.
- **Never:** a key, a secret, a subject, a body. Logs carry ids and status codes only.
- **Deleted:** a down item when the phone acknowledges it (by item number, or by store cursor when it read those lines directly); every down item when the phone turns carriage off; an up command when the Inbox reports it applied; a device and everything it holds when the Inbox removes it (a revoke); an APNs token when Apple answers 410. There is no time sweep.

### Routes

Every route answers JSON. Errors are `{ error, code }`: `400 bad_request`, `401 unauthorized` (a bearer whose SHA-256 does not match), `404 mailbox_not_found`, `404 device_not_found`, `404 not_found` (a path the relay does not serve), `429 too_many_requests` with `Retry-After` from the creation brake, and on a push `502 apns_failed` when Apple cannot be reached or refuses for another reason than 410, with `apns_status` and `apns_reason` (Apple's `reason`, or null) beside `error` and `code` (written in by R1: the first draft named no answer for Apple's other refusals). `POST /v1/mailboxes` goes through the same Cloudflare rate limiting rule guides.show puts on `POST /api/g` (the `[[ratelimits]]` block of `apps/guides-show/wrangler.toml`, keyed on `CF-Connecting-IP`, failing open where it cannot resolve); the relay adds no number of its own. Nothing else is braked: `POST .../push` has no rate limit, because a push needs the phone's push token, which only the app and the relay hold (R3 briefly added a per-mailbox push brake; the owner removed it). "Inbox bearer" is `Authorization: Bearer <M>`; "device bearer" is `Authorization: Bearer <R>` of the device in the path.

| Route | Who | Request | Answer | Exchange |
|---|---|---|---|---|
| `POST /v1/mailboxes` | the Inbox, at its first pairing | `{ secret_sha256 }` | `201 { mailbox_id }`; `mbx_` plus 16 random bytes as base64url | 7.26 |
| `PUT /v1/mailboxes/:mbx/devices/:dev` | Inbox bearer | `{ secret_sha256, cursor }`: `SHA-256(R)` and the store cursor at pairing (the phone read everything before it directly) | `200 { device_id }`; repeating it with the same hash is a no-op; another hash starts the device over (carriage on, the given cursor, no APNs token) | 7.27 |
| `DELETE /v1/mailboxes/:mbx/devices/:dev` | Inbox bearer | | `204`; the device's revoke on the computer | 7.28 |
| `PUT /v1/mailboxes/:mbx/devices/:dev/carriage` | device bearer | `{ on: false }`, or `{ on: true, cursor }` with the store cursor the phone holds | `204`; the device stays registered either way, and the Inbox's socket gets a `carriage` frame | 7.35 |
| `PUT /v1/mailboxes/:mbx/devices/:dev/apns` | device bearer | `{ token, environment: "sandbox" or "production" }`; `token: null` removes it | `204` | 7.29 |
| `POST /v1/mailboxes/:mbx/push` | Inbox bearer | `{ device_id, collapse_id, ciphertext }` | `202 { sent: true }`, or `200 { sent: false, reason: "no_push_token", "apns_gone" or "no_apns_key" }` (`no_push_token`: the device holds no push token, renamed from `no_apns_token` by R3; `no_apns_key`: the relay holds no APNs key yet, written in by R1), or `502 apns_failed`; to a device holding an FCM token, section 10's answers | 7.30 |
| `GET /v1/mailboxes/:mbx/socket` | Inbox bearer, WebSocket upgrade | frames below | | 7.31 |
| `GET /v1/mailboxes/:mbx/devices/:dev/items?after=n` | device bearer | | `{ items: [{ n, ciphertext }], inbox_online }`, every held item after `n` in order | 7.32 |
| `POST /v1/mailboxes/:mbx/devices/:dev/ack` | device bearer | `{ through: n }`, or `{ cursor }` when the phone read the store directly up to that seq | `204`; deletes items up to `n`, or record items whose cursor is at or below `cursor` | 7.33 |
| `POST /v1/mailboxes/:mbx/devices/:dev/commands` | device bearer | `{ id, ciphertext }` | `202 { queued: true, inbox_online }`; an `id` it already holds answers `200 { queued: false, inbox_online }`; a command whose frame to the Inbox would pass Cloudflare's 32 MiB WebSocket message limit answers `413 { error, code: "command_too_large", limit_bytes }` and is not held (it could never be handed over, and would close the Inbox's socket at every `hello`) | 7.34 |

`inbox_online` says whether the Inbox's socket is connected now: the phone's "Sent. Waiting for your computer".

### The Inbox's socket

The Inbox holds one outbound WebSocket to its mailbox while the mailbox has a device, and reconnects when it drops (1 s after, doubling to 60 s, back to 1 s at each `hello`). A new socket replaces an older one, which the relay closes with code 4000. Frames are JSON text.

Relay to Inbox:

- `{ "type": "hello", "devices": [{ "device_id", "cursor", "carriage": boolean, "apns": boolean }] }` on connect. The Inbox writes each listed device's `carriage` into its device record, removes any listed device it revoked, and registers only the non-revoked devices with `carriage: true` that the relay does not list. A device whose phone turned carriage off stays listed, so a reconnect never registers it again.
- `{ "type": "command", "device_id", "id", "ciphertext" }`: each held up command. Right after `hello`, every held command in the order it arrived; afterwards each new one as the phone posts it. A command stays held until the Inbox reports it applied, so one handed to a socket that was already dead goes out again after the next `hello`.
- `{ "type": "carriage", "device_id", "on", "cursor" }`: the phone flipped its relay switch (9.2). The Inbox writes `carriage` into the device record. Off: it sends that device no items and no pushes. On: it resumes items after `cursor`.

Inbox to relay:

- `{ "type": "item", "device_id", "cursor", "ciphertext" }`: one down item, sent only to a device with carriage on. `cursor` is the record's store seq, or null for a result; the relay keeps the highest so the Inbox resumes from `hello`. The relay drops an item for a device it does not hold or whose carriage is off.
- `{ "type": "applied", "device_id", "id" }`: the command was applied (or refused); the relay deletes it.

The drain order (written in by R2). The Inbox handles the socket's frames one at a time, in the order they arrive. On `hello` it settles the devices as above, then sends each listed device with carriage on every store line after the `cursor` `hello` gave, in seq order; a device it registers while the socket is open is carried from the cursor it registered with. Then come the held commands, each applied in turn: opened with the device's up key, applied through the door, answered with a result item, then reported `applied`. Store lines written meanwhile, the command's own writes among them, go down as they are written, so a result can follow the records it caused. A command no key here opens (a revoked device, a forged or reflected envelope) is reported `applied` with no result item. `inbox_online` is the socket as the relay last saw it: a computer that went to sleep without closing it reads as online until the connection times out, and its commands wait at the relay all the same.

### What goes down and up

Down item plaintexts:

- `{ "v": 1, "type": "record", "after", "seq", "kind", "id", "<kind>": record }`: one store line, exactly the `record` event of the event stream (`eventPayload` in `packages/server/inbox.ts`) with `v`, `type` and `after` added. Kinds are added over time and an app skips a kind it does not know: since the Board's step 1 (approval "inbox-board") that includes `card` (`{ "card": InboxCardWire }`), which no thread or list reads. After a device's `cursor`, every line goes down, in seq order. `after` is the seq the device's previous item on this socket reached (the cursor the relay held, for the first after a `hello` or a `carriage` frame): a phone whose last seen seq is lower than an item's `after` knows an item was delayed or dropped and reads the list again (written in by R2 after the review). A line whose `item` frame would pass Cloudflare's 32 MiB WebSocket message limit goes down as the placeholder `{ "v": 1, "type": "record", "after", "seq", "kind", "id", "too_large": true }`, and the cursor moves past it; the phone reads that record over the Wi-Fi or the tailnet, or shows that it is too large to show here (M6 draws the words). Written in by R2 after the review: the store caps nothing, and one line over the limit closed the socket at every resend, held every later line and every command behind the reconnect loop. A phone reading over the Wi-Fi or the tailnet acknowledges by store cursor (`ack { cursor }`), so its queue holds only what it missed.
- `{ "v": 1, "type": "result", "id", "status", "content_type", "body_b64" }`: the door's answer to an up command, its status, its `Content-Type` and its body bytes exactly, as base64 (standard alphabet, padded). It goes only to a device with carriage on. `id` is the id sealed inside the command, never the relay's plaintext frame `id`, and the Inbox refuses a command whose sealed `id` is not its frame's (written in by R2 after its review: otherwise the relay could file one command's authentic result under another command's id, a GET's 200 under a Send it dropped). A result whose `item` frame would pass Cloudflare's WebSocket message limit (32 MiB, the platform's own) is replaced by `status: 413`, `content_type: application/json; charset=utf-8` and the body `{ "error", "code": "result_too_large", "limit_bytes": 33554432 }`, and the command is reported applied (written in by R2 after its review: one frame over the limit closed the socket, the command was handed over again at every `hello`, and every command behind it waited forever). The phone opens such a file over the Wi-Fi or the tailnet.

Files have no item of their own (written in by R2): a file is the result of a GET. An attachment is `GET attachments/:id/view` (the current version) or `GET attachments/:id/view?version=sent` (the version the agent sent), whose result carries 7.15's JSON with `text` and `html`; an HTML asset is `GET html-assets/<token>/<path>`, whose result carries the asset's bytes and type as 7.16 answers them; a message's image is `GET messages/:id/image?path=...` (7.38), its bytes and sniffed type. A result frame carries the body base64 twice (`body_b64`, then the sealed envelope as base64url), about 16/9 of the body, so the route's 10 MB image cap (`MAX_REVIEW_IMAGE_PREVIEW_BYTES`) is a frame of about 17.8 MiB, inside the 32 MiB limit: every image the route serves fits one result (`inbox-relay-bounds.test.ts`, and the relay proof fetches one at the cap). A command carries no headers, so there is no `If-None-Match` through the relay: the result is always the bytes. A result is one envelope whatever its size (kept in parts at the relay, above).

Files do not go up either (written in 2026-10-15 with 7.48 and 7.49). A command's `body` is JSON, so a file would ride base64 inside the sealed envelope, about 16/9 of its size, and Cloudflare's 32 MiB message would cap a relayed upload near 18 MiB, under the window's 100 MB. In v1 the Inbox answers an up command for `uploads` or `markups` with `413 { "code": "relay_upload_unavailable" }` without running the window's route, beside `pair` and `events` as the door routes the relay does not carry. The phone uploads over the Wi-Fi or the tailnet (as section 11.5 does for video) and may then send the message naming the `upl_` id through the relay. Every other row added 2026-10-15 (7.39 to 7.47, 7.53) is an ordinary command: a GET with a fresh random `id`, a POST with its `idempotency_key` as `id`.

Up command plaintext: `{ "v": 1, "id", "method", "path", "body" }`, sealed under the up key `U`, where `path` is a door path (`/api/inbox/device/...`, with its query string when the route takes one, `?version=sent` or `?project=prj_...`) and `body` is the JSON body the phone would have sent directly (a POST only). The Inbox applies it in-process through the door as that device (never as a loopback HTTP call), so the allowlist, the revocation check and the idempotency rule are the same on every path: every POST goes through the door's idempotency log per device and key, so a command the relay hands over again, or replays later, answers the stored result and writes nothing. A GET through the relay (the list after a long absence, an attachment's view, an HTML asset) is a command whose `id` is a fresh random id; a POST's `id` is its `idempotency_key` (section 6). Two door routes are not carried, and answer a result of `404 device_route_not_found`: `pair` (pairing through the relay is not in v1) and `events` (the down items are the relay's event stream; an endless answer cannot be one result).

### Push

The Inbox posts one push per paired device with carriage on, after an agent's message lands with a question or a guided review (`send_message` or `submit_guide`, where `packages/inbox/notify.ts` would raise a browser notification for the question). One message is one push however many questions it carries.

The push plaintext, encrypted under the device key:

```json
{
  "v": 1,
  "type": "push",
  "thread_id": "msg_01K70000000000000000000010",
  "message_id": "msg_01K70000000000000000000010",
  "subject": "Run the retry tests against the Stripe test clock?",
  "project": "billing-svc",
  "agent": "Claude Code",
  "question": {
    "key": "q-1a2b3c4d",
    "revision": 0,
    "prompt": "Run the retry tests against the Stripe test clock?",
    "context": "They take about four minutes against the test key.",
    "choices": [
      { "label": "Yes", "recommended": true },
      { "label": "No", "recommended": false }
    ]
  }
}
```

- `type` is always `"push"` (written in by R2 after the review): pushes and down items are sealed under the same key `K`, so the phone opens an APNs `e` only when its `type` is `"push"`, and a down item only when its `type` is `"record"` or `"result"`; a relay cannot pass one off as the other.
- `agent` is `inboxAgentName(author)`, `project` the project's name.
- `question` is present only when the message has exactly one question, it is single-choice, and it has at most four choices (Apple shows at most four actions). Otherwise it is null, and the notification opens the thread (render 7.2).
- `collapse_id` is `HMAC-SHA256(C, UTF-8 bytes of the thread id)` as 64 lowercase hex, where `C = HKDF-SHA256(ikm = S, salt = UTF-8 bytes of the device id, info = "plannotator-inbox relay collapse v1", length = 32)` (written in by R2 after the delta review of R1: a MAC under the envelope key `K` would use one key for two jobs; `C` is the Inbox's alone, the phone never computes it, so it has no vector), so a thread's newer push replaces its older one and the relay never learns the thread (written in by R1 after the review; the first draft sent the thread id). The phone reads the thread from the decrypted `thread_id`, never from the collapse id. The relay refuses a collapse id that is not 1 to 64 printable ASCII bytes, Apple's ceiling, with `400 bad_request`.
- Apple's payload ceiling is 4096 bytes. When the APNs body would pass it, the Inbox sets `question.context` to null, then `question` to null, then sends `{ v, type, thread_id, message_id }` alone.

What the relay sends to APNs, with `apns-push-type: alert`, `apns-priority: 10`, `apns-topic: ai.plannotator.app` and `apns-collapse-id: <collapse_id>`:

```json
{ "aps": { "alert": { "title": "Plannotator", "body": "New in your Inbox" }, "mutable-content": 1, "sound": "default" }, "e": "<envelope>" }
```

The relay signs Apple's provider token (ES256) with the APNs key it holds as Worker secrets (`APNS_KEY`, the .p8 text, `APNS_KEY_ID`, `APNS_TEAM_ID`) and reuses it for 50 minutes. It sends over HTTP/2 on a `connect()` TLS socket (`apps/relay/src/apns-h2.ts`), never `fetch`: a Worker's `fetch` reaches origins over HTTP/1.1 in workerd, which APNs refuses (the mobile spike, item 6). The host follows the token's environment: `api.sandbox.push.apple.com` or `api.push.apple.com`. A 410 deletes the token. Without `APNS_KEY` the relay answers `no_apns_key` and logs it once.

The cleartext alert shows only if the notification service extension cannot run. The extension decrypts `e` with the device key and sets the title to `subject` and the body to `<agent> in <project>`, followed by `: <context>` when the question carries one (render 7.1). With a question it registers a category for that notification whose actions are the choices, recommended first, identifiers `choice.0` to `choice.3`, each `authenticationRequired` (render 7.2). A tapped choice is one Send (section 6, exchange 7.11).

Written in by M5 (2026-10-08): `choice.<n>` names the choice by its index in the summary's `choices`, whatever order the actions are drawn in, so the app reads the label from the summary it stored on the notification. A push no paired device key opens reads "Plannotator" and "Question from an agent". Every notification's category, with or without actions, carries the hidden-preview placeholder "Question from an agent", so with previews hidden the lock screen shows no subject and no agent text. The lock-screen answer goes to the computer directly; when that gets no answer it goes up as a command through the relay (exchange 7.34, sealed under `U`) with the same key, and when the relay says the Inbox is not online the phone says "“Yes” sent. Waiting for your computer.". A refusal on the direct path is reported in a notification of its own ("“Yes” was not sent." and the reason); a Send neither path takes reads "“Yes” may not have been sent", since the direct one may have landed before its connection died. A refusal of a Send carried by the relay comes back as a result item, which the phone reads from M6 on; until then it is not reported. The key is one per message and choice, so a different choice later is a new Send. A push opens only when its sealed `type` is `"push"`, so R1's push vector, sealed before `type` existed, is refused by the app's open, and the app's tests read it as a summary only.

Written in by M6 (2026-10-08; behaviour only, no shape changed): the phone tries its paths in 9.2's order on every return to the front, pull to refresh and push: the Wi-Fi listener (from the QR's `lan` and `fp` only, never from the network), then the tailnet, each asked for `health` with a 3 s wait, then the relay while its switch is on. On the relay it reads `items?after=n`, applies each record whose seq it has not seen to the threads it keeps (records are full snapshots in the thread's shape), reads the list and the open threads as GET commands while `inbox_online` is true (never while it is false, so GETs do not pile up at the relay), and acks through `n` after applying. A command reads back its own result for about 15 s (reads at 0.25 s doubling to 4 s); with no result, or with the Inbox offline, the command is held and a Send shows "Sent. Waiting for your computer" until its reply's `idempotency_key` appears in the thread or its result arrives, on any path: back on the Wi-Fi or the tailnet the phone reads the relay once for the results of its held Sends (a refusal never shows in the thread), and with its relay switch off it posts each held Send again directly with the same key, which the door answers from its log. Only Sends are kept as held: a held pick, resolve or delete that the computer refuses shows as the next read of the thread shows it, without words of its own. A `seen` does not wait for its result. The lock-screen answer asks the Wi-Fi and the tailnet at once (3 s), then sends with a 5 s wait directly or to the relay, so it fits the background time an action gets. A `too_large` record draws its words only through the thread's read through the relay answering 413 `result_too_large` (the placeholder names a message the phone does not hold); while the computer is asleep such a message is absent. Reading directly, the phone acks by store cursor once each time it connects (not after every read: a mailbox answers its requests one at a time, and a push would wait behind them). The relay switch is the phone's: on from pairing as R1 registers it (the fallback by default, pick 5 of the iPhone record); 9.2's switch turns carriage off and on again (7.35, with the phone's cursor). Allowing notifications registers the APNs token and changes nothing about carriage (ruled 2026-10-08 on PR 1801).

## 5. The surface bridge

`packages/core/inbox-surface-bridge.ts` exports the message types and `INBOX_SURFACE_BRIDGE_VERSION = 1`. The surface is S1's single-file build, loaded by the app's `WKWebView` from the app scheme `plannotator-surface://app/surface.html`. It has no network access; the shell fetches every byte through the door and hands it over.

- **Shell to surface:** `window.plannotatorSurface.receive(message)`, called by the shell.
- **Surface to shell:** `window.webkit.messageHandlers.plannotatorSurface.postMessage(message)`. The shell takes messages from the main frame only, so an agent's HTML, drawn in its sandboxed frame, cannot reach the bridge.
- **Every message** is `{ v: 1, type, ... }`. A surface given another `v` answers `error` with `code: "bridge_version"`.
- **The asset scheme:** `plannotator-asset://inbox/api/html-assets/<token>/<path>` is served by the shell from the door's `GET html-assets/<token>/<path>` (directly, or as a relay command). Before it opens an HTML attachment, the shell rewrites the page's `<base href>` from the window's root-relative `/api/html-assets/<token>/` to `plannotator-asset://inbox/api/html-assets/<token>/`. The page's root-relative asset paths then resolve on that scheme too, and the token never reaches web content. Every answer on the asset scheme carries the surface's own policy as its `Content-Security-Policy` (no network; scripts, styles, images, fonts, media and frames from the asset scheme, `data:` and `blob:` only), so a page the agent's page embeds from its folder is as offline as the page itself, which inherits the surface's policy; and the app's web view blocks every `http`, `https`, `ws` and `wss` load with a content rule list (if the list cannot be compiled, the surface is not loaded and files do not open) (M2, from the review of PR 1785: a nested page loaded through the scheme had no policy and could send an image beacon). WebRTC is outside both: no current engine enforces CSP's `webrtc` directive (Chromium and WebKit report `webrtc 'block'` as unrecognized and still send STUN), and the content rule list never sees STUN over UDP or TURN over TCP, so the shell's document-start script, which deletes the RTC constructors and `navigator.mediaDevices`, is the only defence. It runs in every frame, sandboxed `srcdoc` frames with an opaque origin and the frames nested inside them included; the shell's proofs show zero STUN packets from an attached page and from a frame nested inside it (the Android review, 2026-10-11).

Annotations are Plannotator's `Annotation` (`packages/ui/types.ts`) inside the Inbox's `InboxAnnotationRecord` (`packages/core/inbox-attachments.ts`), and attachments are `InboxAttachmentState`, as the door answers them.

### Shell to surface

| Type | Fields | When |
|---|---|---|
| `open_attachment` | `attachment: InboxAttachmentState`, `version` (`"current"` or the sent sha256), `text`, `html` (string with the rewritten base, or null), `annotations: InboxAnnotationRecord[]` (this file and version, waiting for a Send), `focus` (an annotation id to scroll to, or null) | the person opens a file (3.6, 4.1 to 4.4) |
| `open_guide` | `message_id`, `guide: InboxGuideRef`, `snapshot`, `reviewed: boolean[] or null` | a guided review opens on its sections (6.1) |
| `open_section` | `section` (an index, or null for the sections) | the shell's back button in 6.2 (S1, see below) |
| `set_wrap` | `wrap: boolean` | the wrap button in 6.2's bar: a guide's diffs wrapped (the default) or one code line per row, scrolled sideways (M4, see below) |
| `set_mode` | `mode: "annotate" or "interact"` | the switch of 4.3 |
| `step_pin` | `direction: "parent" or "child"` | Parent or Child in 4.3 |
| `set_appearance` | `theme: "light" or "dark"`, `text_scale` (the Dynamic Type size as a multiple of the default, from `UIFontMetrics`) | at open and on every change |
| `commit_annotation` | `annotation: InboxAnnotationRecord` | the door saved it; the surface draws it as saved |
| `remove_annotation` | `id` | removed, or a draft cancelled (4.4 Cancel) |
| `comment_selection` | | Comment in the edit menu of a markdown or text file (4.1): the selection becomes a draft now, answered by `selection` (both fields null with nothing selected) (M2, see below) |
| `export_feedback` | `id`, `annotations: InboxAnnotationRecord[]` (the ones riding the Send), `attachments: InboxAttachmentState[]` (7.14), `texts: [{ attachment_id, version, text }]` (each annotated version's text from `view`), `project_root` | Send carries annotations (3.6): the surface answers `feedback` (M2, see below) |

### Surface to shell

| Type | Fields | When |
|---|---|---|
| `ready` | `bridge: 1`, `build` | the bundle loaded; the shell sends nothing before it |
| `selection` | `quote` (string or null), `draft` (`Annotation` or null) | a text selection settled or cleared; on a touch screen, a markdown selection is answered to `comment_selection` instead; Comment in the edit menu uses `draft` (4.1, 4.2) |
| `pin` | `target: { label, selector }`, `draft: Annotation` | an HTML pin landed, or Parent or Child moved it (4.3) |
| `draft` | `target: { kind: "block" or "node" or "edge", label }`, `draft: Annotation` | a tap on a block (pinpoint) or a diagram part: open the composer now (4.4) |
| `annotation` | `id` | a saved mark was tapped: the shell shows it with Edit and Remove (4.3) |
| `reviewed` | `message_id`, `reviewed: boolean[]` | a section's Reviewed tick (6.1, 6.2) |
| `section` | `message_id`, `section` (an index, or null for the sections), `sections` (how many pages) | the guide moved, by Continue, Previous or Next; the shell titles 6.2 "02 of 04" and swaps its close button for back (S1, see below) |
| `link` | `href` | a link tapped in the surface's own rendered markdown (an `http(s)` or `mailto` href); the shell opens it in the system browser. Never from an agent's HTML page (see below) |
| `feedback` | `id` (the request's), `text` | the annotations as Plannotator's feedback text, for the reply's `feedback` field (7.11) (M2, see below) |
| `error` | `code`, `message` | the surface could not draw what it was given |

**Links in an agent's HTML page are not a bridge message (S1 review, 2026-10-08).** The `link` message's only source is the main frame's own rendered markdown, whose taps the surface sees itself. A link in an agent's page is a navigation the shell decides: the page's script can forge any message the viewer's frame sends, and a tap inside that frame never reaches the main frame (proved in WebKit), so the surface cannot tell a real tap from a forged one. In M2 the shell takes it in `WKNavigationDelegate.decidePolicyFor` with `navigationType == .linkActivated` on the agent's frame, a real-tap signal the page cannot forge, cancels the in-frame load and opens the URL in `SFSafariViewController`. Built in M2, and corrected from the paragraph above: the shell never sees that frame navigate. The surface's CSP (`frame-src plannotator-asset: about: data: blob:`) refuses the load before WebKit asks the shell, so the frame stays where it is. Instead, ui's `HtmlViewer` `hostNavigates` has the frame's bridge, on a person's tap (`isTrusted`) on a link in Interact, call `window.open(href, '_blank', 'noopener')` (the sandbox is `allow-scripts allow-modals allow-popups`). WebKit hands that window to the shell's `WKUIDelegate.createWebViewWith`, which makes no web view: it opens the URL only within 1.2 s of the person's touch on the web view (the touch window below), and only when its scheme is `https` (Safari View Controller) or `mailto` (the mail sheet). A link in the surface's own markdown arrives as the main frame's `link` message and passes the same scheme rule. Any other scheme, `http:` and `plannotator:` included, opens nothing, and the app's own URL handler never sees a URL from content (row 5120). `decidePolicyFor` cancels every navigation away from the surface except the page's own `about:srcdoc` frame and frames its page embeds from its folder on `plannotator-asset:`; a script moving the agent's frame is refused by the CSP, or cancelled there.

**Pins and selections from an agent's HTML page are page-reported (S1 follow-up, 2026-10-08).** For the same reason, the surface cannot tell a pin or a text selection the person made in an agent's page from one the page's script forged (the viewer's bridge runs in the page's own realm): a forged one reaches the shell as an ordinary `pin` or `selection`, with a label the page chose. The surface cannot drop them without dropping every pin (4.3). In M2 the shell takes a `pin`, `selection` or `draft` from an HTML attachment only within about a second of its own touch on the web view (a gesture recognizer that observes touches without cancelling them); markdown and diagrams are drawn in the main frame from the surface's own events, so their drafts need no such check. Links in the surface's own markdown go out only for a real tap (`isTrusted`).

`comment_selection` was added by M2 (2026-10-08). On the iPhone the surface painted a markdown selection as a pending highlight the moment it settled, which replaced the system selection and closed its edit menu before the person could reach Comment (seen in the simulator: the word was marked and no menu stayed). On a touch screen the selection now stays the system's until Comment, which asks for the draft (ui's `ViewerHandle.takeSelection`).

`export_feedback` and `feedback` were added by M2 (2026-10-08). A Send that carries annotations sends them as Plannotator's feedback text (`feedback` in 7.11, with `annotation_ids`), which the window builds with Plannotator's parser so line numbers name the lines the person read (`attachmentFeedback` in `packages/inbox/attachments.ts`). The phone has that parser only inside the surface, so it asks there instead of writing a second one in Swift; the text is byte for byte the window's.

`set_wrap` was added by M4 (2026-10-08). 6.2 draws a wrap button in the shell's bar ("the wrap button in the bar turns wrapping off for a sideways read"), and the bar is the shell's, so the shell tells the surface. The surface sets Plannotator's `diffOverflow` setting (`wrap` or `scroll`), which its read-only diff renderer already follows. The shell sends it with every `open_guide`, so a guide always opens in the shell's state.

`open_section` and `section` were added by S1 (2026-10-08): 6.1 and 6.2 put the guide's title and its close or back button in the shell's bar, and Continue, Previous, Reviewed and Next in the document, so each side has to tell the other where the guide is. A `selection` with both fields null follows only a selection draft; a pin or a part whose draft closes sends nothing. A `pin`'s `label` is the element's name as Plannotator's pinpoint names it ("Button", a heading's words), and `selector` is the draft's `htmlAnchor.selector`. A `draft`'s `label` is the quote's first words for a block and "Pick a host (node E)" for a diagram part; `kind` is `block` for a whole-diagram comment too. The surface is `apps/hook/dist/surface.html`, bundled into the app by a build phase that runs `build:surface`; its CSP is `default-src 'none'` with `connect-src 'none'`, and lets an HTML page's own folder load from `plannotator-asset:` (script, style, image, font, media, frame and `base-uri`), since the page's frame inherits the policy.

A draft is an `Annotation` with an empty `text`. The shell fills the person's words into `text`, saves `{ attachment_id, version, annotation }` through the door (7.17), and answers with `commit_annotation`. Edit (4.3) is the same save with the same annotation id and a new key. HTML-asset tokens live in the Inbox's memory, so after the Inbox restarts an asset answers 404; the shell then fetches `view` again.

## 6. Idempotency

Every command a phone sends carries one key: `idempotency_key` in the request body, the field the window's Send and New message already take. The phone mints a random UUID per intent (one pick tap, one Send, one tick) and keeps it until it has a definite answer (any 2xx or 4xx), across retries, path changes and app restarts.

| Command | Door route | Key |
|---|---|---|
| Pick | `POST messages/:id/picks` | body `idempotency_key` |
| Send | `POST messages/:id/reply` | body `idempotency_key` (also the store's own key) |
| Seen | `POST threads/:id/seen` | body `idempotency_key` (beside the optional `through_seq`) |
| Mark read, Undo | `POST threads/:id/read`, `POST threads/:id/unread` | body `idempotency_key` |
| Resolve | `POST messages/:id/resolve` | body `idempotency_key` |
| Delete | `POST threads/:id/delete` | body `idempotency_key` |
| Annotation save, remove | `POST annotations`, `POST annotations/:id/remove` | body `idempotency_key` |
| Tick | `POST messages/:id/guide/reviewed` | body `idempotency_key` |
| New message | `POST threads/:id/message` | body `idempotency_key` (also the store's own key) |
| Compose | `POST messages` | body `idempotency_key` (also the store's own key) |
| Send to another session | `POST messages/:id/to` | body `idempotency_key` (the door's log only) |
| Project menu, its Undo | `POST projects/:id/read`, `unread`, `resolve` | body `idempotency_key` (the door's log; the window's in-memory `batch_id` is optional) |
| Guided-review comment | `POST messages/:id/guide/annotations` | body `idempotency_key` (an edit is the same annotation id under a new key) |
| Comment on a message's text | `POST messages/:id/annotations` | body `idempotency_key` (an edit is the same annotation id under a new key) |
| Upload | `POST uploads?name=` | query `idempotency_key` (the body is the file) |
| Drawing | `POST markups` | query `idempotency_key` (the body is the image; its name is its SHA-256, so a replay writes nothing new anyway) |

- **The door** keeps `inbox/device-commands.jsonl`, one line per applied command: `{ v: 1, at, device_id, key, method, path, status, body }`, with the answer's status and JSON body. It is read at start. A key seen before for that device on the same method and path answers the recorded status and body, adds `Idempotent-Replayed: true`, and writes nothing. Only the method and the door path are compared, never the query or the body: a raw route's replay answers the first file's upload or drawing whatever bytes or `name` came with it. That header is the replay signal: a replayed Send answers its recorded body, whose `replayed` field reads as it did the first time. The log keeps every answer body, reply bodies included, for as long as the store lives. The same key on another route is `409 idempotency_key_reused`. A 5xx is not recorded, so a retry runs again.
- **The relay path** carries the key as the up command's `id`. The relay holds one command per `id`, and the Inbox applies it through the door, so a command posted twice, or re-sent after the Inbox applied it but before the relay heard, writes once.
- **The lock-screen answer** is one Send with the pick inside it (7.11): `{ idempotency_key, questions: [{ key, revision, answer: { v: 1, key, kind: "single", prompt, selected: [label] } }] }`. It tries the direct path first, then the relay, with the same key.

## 7. The exchanges

P1 replays 7.1 to 7.25, 7.36, 7.37 and 7.53 against a compiled binary, and 7.39 to 7.49 against an Inbox in process (the raw upload over the tailnet's door listener too, and the relay's refusal through `asDevice`); P2 replays 7.2 over the LAN; R1 and R2 replay 7.26 to 7.35 against `wrangler dev`. Fixture values are placeholders, never secrets: `AAAA...` stands for a 32-byte value, `tok_exampleaaaa...` for a token, repeated hex for a hash.

```sh
INBOX=https://macbook-pro.tail0000.ts.net:8443   # or http://127.0.0.1:<port> in a proof
TOKEN=tok_exampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RELAY=https://relay.plannotator.ai              # or http://127.0.0.1:8787 under wrangler dev
```

### 7.1 Make an offer (window route)

```sh
curl -sS -X POST http://127.0.0.1:52817/api/inbox/pairing -H 'Content-Type: application/json' -d '{}'
```

```json
{
  "offer": { "code": "482913", "expires_at": "2026-10-08T10:12:00.000Z" },
  "link": "plannotator://pair?v=1&name=MacBook%20Pro&tailnet=macbook-pro.tail0000.ts.net%3A8443&secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code=482913",
  "computer": { "name": "MacBook Pro" },
  "addresses": { "tailnet": "macbook-pro.tail0000.ts.net:8443", "lan": null, "fingerprint": null }
}
```

### 7.2 Redeem by the QR secret

```sh
curl -sS -X POST "$INBOX/api/inbox/device/pair" -H 'Content-Type: application/json' \
  -d '{"secret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"iPhone","platform":"ios"}'
```

`201`:

```json
{
  "device": { "id": "dev_01K70000000000000000000001", "name": "iPhone", "platform": "ios", "created_at": "2026-10-08T10:03:12.000Z", "last_seen_at": "2026-10-08T10:03:12.000Z", "revoked_at": null },
  "token": "tok_exampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "secret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "computer": { "name": "MacBook Pro" },
  "addresses": { "tailnet": "macbook-pro.tail0000.ts.net:8443", "lan": null, "fingerprint": null },
  "relay": { "url": "https://relay.plannotator.ai", "mailbox_id": "mbx_AAAAAAAAAAAAAAAAAAAAAA" }
}
```

The same request again: `410 { "error": "This pairing code is no longer open. Make a new one on your computer.", "code": "offer_expired" }`.

### 7.3 Redeem by six digits, one wrong first

```sh
curl -sS -X POST "$INBOX/api/inbox/device/pair" -H 'Content-Type: application/json' \
  -d '{"code":"482914","name":"iPhone","platform":"ios"}'
```

`401 { "error": "That code is not the one on your computer.", "code": "pairing_code_wrong", "tries_left": 4 }`. With `"code":"482913"` the answer is 7.2's. `$INBOX` here is the tailnet or loopback: on the LAN listener any `code` answers `400 { "error": "Over the Wi-Fi, pair by scanning the QR code on your computer's screen.", "code": "code_not_accepted_here" }` and the offer stays open.

### 7.4 Health

```sh
curl -sS "$INBOX/api/inbox/device/health" -H "Authorization: Bearer $TOKEN"
```

```json
{ "ok": true, "app": "plannotator-inbox", "version": "0.28.8", "serverSession": "00000000000000000000000000000001", "pid": 4242, "update": null }
```

Without the header: `401 { "error": "This request needs the phone's token.", "code": "device_token_missing" }`. With an Origin: `403 { "error": "Browser requests are not accepted here.", "code": "origin_not_allowed" }`. A revoked token: `401 { "error": "This phone was removed from the Inbox. Pair it again.", "code": "device_revoked" }`.

### 7.5 The list

```sh
curl -sS "$INBOX/api/inbox/device/threads" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "serverSession": "00000000000000000000000000000001",
  "version": "0.28.8",
  "cursor": 1288,
  "update": null,
  "notice": null,
  "projects": [
    { "id": "prj_01K70000000000000000000002", "key": "billing-svc-aaaaaa", "name": "billing-svc", "root": "/Users/me/code/billing-svc", "created_at": "2026-10-07T09:00:00.000Z", "threads": 1, "unread": 1 }
  ],
  "project": null,
  "sections": [
    { "id": "stopped", "label": "Stopped on you", "threads": [] },
    { "id": "holding", "label": "Holding up work", "threads": [] },
    { "id": "waiting", "label": "Waiting on you", "threads": [
      {
        "thread_id": "msg_01K70000000000000000000010",
        "project_id": "prj_01K70000000000000000000002",
        "subject": "Run the retry tests against the Stripe test clock?",
        "author": { "kind": "agent", "host": "claude-code", "session": "ses_01K70000000000000000000003", "name": null },
        "created_at": "2026-10-08T10:42:00.000Z",
        "last_at": "2026-10-08T10:42:00.000Z",
        "last_author": "agent",
        "message_count": 1,
        "resolved_at": null,
        "questions": { "open": 1, "picked": 0, "stopped": false, "holds_up": [], "prompt": "Run the retry tests against the Stripe test clock?" },
        "waiting_on_person": true,
        "project": { "id": "prj_01K70000000000000000000002", "name": "billing-svc" },
        "thread_name": null,
        "section": "waiting",
        "unread": true,
        "answered_not_sent": false,
        "waiting_since": "2026-10-08T10:42:00.000Z",
        "unseen": 1,
        "sent": null,
        "guide": false
      }
    ] },
    { "id": "sent", "label": "Sent", "threads": [] },
    { "id": "new", "label": "New since you looked", "threads": [] },
    { "id": "quiet", "label": "Quiet", "threads": [] }
  ]
}
```

### 7.6 Projects

```sh
curl -sS "$INBOX/api/inbox/device/projects" -H "Authorization: Bearer $TOKEN"
```

```json
{ "serverSession": "00000000000000000000000000000001", "cursor": 1288, "projects": [ { "id": "prj_01K70000000000000000000002", "key": "billing-svc-aaaaaa", "name": "billing-svc", "root": "/Users/me/code/billing-svc", "created_at": "2026-10-07T09:00:00.000Z", "threads": 1, "unread": 1 } ] }
```

### 7.7 A thread

```sh
curl -sS "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "serverSession": "00000000000000000000000000000001",
  "cursor": 1288,
  "thread": {
    "thread_id": "msg_01K70000000000000000000010",
    "project": { "id": "prj_01K70000000000000000000002", "key": "billing-svc-aaaaaa", "name": "billing-svc", "root": "/Users/me/code/billing-svc", "created_at": "2026-10-07T09:00:00.000Z" },
    "subject": "Run the retry tests against the Stripe test clock?",
    "thread_name": null,
    "resolved_at": null,
    "messages": [
      {
        "id": "msg_01K70000000000000000000010",
        "project_id": "prj_01K70000000000000000000002",
        "thread_id": "msg_01K70000000000000000000010",
        "reply_to": null,
        "author": { "kind": "agent", "host": "claude-code", "session": "ses_01K70000000000000000000003", "name": null },
        "subject": "Run the retry tests against the Stripe test clock?",
        "body": "The retry worker is ready.\n\n:::question\nRun the retry tests against the Stripe test clock?\nThey take about four minutes against the test key.\n- Yes\n- No\nRecommended: Yes\n:::",
        "created_at": "2026-10-08T10:42:00.000Z",
        "resolved_at": null,
        "idempotency_key": null,
        "thread_name": null,
        "attachments": [],
        "questions": [
          {
            "key": "q-1a2b3c4d", "position": 0, "kind": "single",
            "prompt": "Run the retry tests against the Stripe test clock?",
            "context": "They take about four minutes against the test key.",
            "choices": [
              { "label": "Yes", "description": null, "recommended": true, "settled": false },
              { "label": "No", "description": null, "recommended": false, "settled": false }
            ],
            "recommendation": "Yes", "suggested_text": null,
            "stopped": null, "holds_up": [], "asked_by_agent_id": null, "orphaned": false,
            "state": "open", "answer": null, "revision": 0, "sent_revision": 0,
            "picked_by": null, "picked_at": null, "sent_reply_id": null,
            "message_id": "msg_01K70000000000000000000010"
          }
        ]
      }
    ]
  }
}
```

### 7.8 Seen

```sh
curl -sS -X POST "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/seen" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000001"}'
```

`{ "thread": <the row of 7.5, now "unseen": 0> }`. Without the key: `422 { "error": "idempotency_key: required on a phone's command.", "code": "validation_error", "field": "idempotency_key" }`.

Seen on sight (added 2026-10-12, design record "inbox-new-in-open-thread"; the window does it, and the phone apps are asked to do the same): a phone records the look when the thread opens with `through_seq` set to the newest message seq in the thread it read, so a message landing between the read and the look stays new. An agent message that arrives while the thread is open counts as seen once its first lines (the sender row and about 96 pt of the body, or all of it if shorter) have been on screen for 1 s while the app is active and the thread is frontmost (no file, sheet or dialog over it); the phone then sends `seen` again with `through_seq` = that message's seq (only when every arrival before it was seen too, so the look never passes a message the person was not shown):

```sh
curl -sS -X POST "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/seen" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000002","through_seq":214}'
```

The thread-state traces show the rule (`hand-18-look-capped-by-through`, the `seen` event's `through`).

### 7.9 The event stream

```sh
curl -sSN "$INBOX/api/inbox/device/events?cursor=1288" -H "Authorization: Bearer $TOKEN"
```

```
retry: 2000
event: hello
data: {"serverSession":"00000000000000000000000000000001","cursor":1288}

id: 1289
event: record
data: {"seq":1289,"kind":"question","id":"msg_01K70000000000000000000010/q-1a2b3c4d","question":{"key":"q-1a2b3c4d","state":"picked","revision":1,"...":"the question wire of 7.7"}}

: ping
```

### 7.10 A pick

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000010/picks" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000002","questions":[{"key":"q-1a2b3c4d","revision":0,"answer":{"v":1,"key":"q-1a2b3c4d","kind":"single","prompt":"Run the retry tests against the Stripe test clock?","selected":["Yes"]}}]}'
```

`{ "message_id": "msg_01K70000000000000000000010", "questions": [<7.7's question with "state": "picked", "revision": 1, "answer": {...}, "picked_by": { "id": "person", "name": null }, "picked_at": "2026-10-08T10:50:00.000Z">], "reply": null }`. The same request again answers the same body with `Idempotent-Replayed: true` and writes nothing. A new key with `"revision": 0`: `409 question_revision_conflict`.

`unsent_only` (optional, boolean; added 2026-10-24 with the window's decision mode, approval "inbox-decision-mode"): `true` refuses a pick (or a cleared pick) on a question a reply already sent with `409 question_already_sent` (`{ "error": "The answer to q-1a2b3c4d was already sent.", "code": "question_already_sent", "key": "q-1a2b3c4d" }`), and nothing is written; a value that is not a boolean is `422 validation_error` (`"field": "unsent_only"`). Without it a sent question takes a pick again, as the thread-state model has it (`adr/implementation/inbox-thread-state.md`). Send it when the phone saves a pick that may race its own Send (a pick read at the revision the Send took would otherwise reopen an answer the agent already has). The door forwards the body unchanged, so an Inbox before it ignores the field and answers as above. A refusal is a 4xx, so the door keeps it under the idempotency key: a retry with a new answer needs a new key.

### 7.11 Send

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000010/reply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000003","words":"Go ahead.","questions":[{"key":"q-1a2b3c4d","revision":1}]}'
```

```json
{
  "message_id": "msg_01K70000000000000000000010",
  "questions": [ { "key": "q-1a2b3c4d", "state": "sent", "revision": 1, "sent_revision": 1, "sent_reply_id": "msg_01K70000000000000000000011", "...": "the rest of the question wire" } ],
  "reply": {
    "id": "msg_01K70000000000000000000011",
    "project_id": "prj_01K70000000000000000000002",
    "thread_id": "msg_01K70000000000000000000010",
    "reply_to": "msg_01K70000000000000000000010",
    "author": { "kind": "person" },
    "subject": null,
    "body": "Answered 1 question.\n\nGo ahead.\n\n...the answers section...",
    "created_at": "2026-10-08T10:52:00.000Z",
    "resolved_at": null,
    "idempotency_key": "00000000-0000-4000-8000-000000000003"
  },
  "replayed": false
}
```

**When a Send skips (approval "inbox-explicit-skip", 2026-10-21; replaces the rule of "inbox-words-only-reply", #1903).** A question is skipped only when the person presses a Skip: on its card (a pick whose answer is a skip), or "Skip them" on the skip line for one Send. Sending an answer never skips anything else, and the server ignores `skip_unanswered` from any client (an iPhone app that still sends it skips nothing). The app must draw and send it as the window does (`packages/inbox/components/Thread.tsx`, `packages/inbox/sendTargets.ts`):

- The skip line reads "N questions stay open · Skip them", always, whatever the Send carries. A tap on Skip them remembers exactly the questions it counted (as `<message id>/<key>`) and turns the line to "↷ N questions will be skipped · Keep open" for that one Send; Keep open forgets them. A question that lands after the tap is not in the set, so it is never skipped. The choice resets when the Send goes or the thread changes.
- One Send to one agent session is ONE reply (`sendTargetsOf`): the app groups the picks waiting, and the questions chosen with Skip them that are still open, by the session of the message they are on (`author.host` + `author.session`; a message with no session is a reply of its own). Each group is one `POST messages/:id/reply` to the latest of that session's messages it touches; every pick or skip on another message names it with `message_id` (`questions: [{ message_id, key, revision }]`, `skip: [{ message_id, key }]`; on the reply's own message `message_id` may be left out). The words, annotations and pasted files ride the reply of the session that wrote the latest agent message; when that session has nothing else to send, a last reply to the latest agent message carries them alone. A message with nothing in it gets no reply. One idempotency key per (Send, session), kept for a retry.
- The server checks each `message_id`: the same thread and the same agent session as the reply's message (else `422 validation_error`, nothing written), and each question's `revision` as for one message (a stale one refuses the whole reply, `409 question_revision_conflict`, nothing written). A `skip` key that is not a question of that message is refused (`404 question_not_found`); a listed question that is no longer open (answered, picked, closed, replaced) is left alone, so a race never refuses a Send, and a Send of only such skips answers `200 { reply: null, nothing_to_send: true }`.
- What the agent gets: the first line counts every answer and skip of the reply ("Answered 1 question."); then the person's words; then, when the session still has questions open in the thread, "You have N other questions open in this thread. They stay open; the person will answer them in the Inbox. Don't re-ask them." (a reply with no answer and no skip keeps "No questions answered yet; all N are still open. …"); then "Answers to your questions", with a `### Your message <id>` heading per message when the answers are on several messages, or on another message than the one replied to.
- `packages/server/inbox-devices.test.ts` (7.11) proves the door: the old flag ignored, Skip them across two messages as one reply and its replay, answers on two messages as one reply. The window's Sends are proved in `packages/inbox/wordsOnlyTwoAsks.test.tsx` and `packages/inbox/markRead.test.tsx`.

The lock-screen answer (render 7.2) is the same route with the pick inside: `"questions":[{"key":"q-1a2b3c4d","revision":0,"answer":{"v":1,"key":"q-1a2b3c4d","kind":"single","prompt":"Run the retry tests against the Stripe test clock?","selected":["Yes"]}}]` and no `words`.

### 7.12 Resolve

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000010/resolve" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000004","resolved":true}'
```

`{ "thread": <the thread summary, "resolved_at": "2026-10-08T10:53:00.000Z"> }`.

### 7.13 Delete a thread

```sh
curl -sS -X POST "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/delete" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000005"}'
```

`{ "ok": true, "store": { "dir": "/Users/me/.plannotator/inbox", "bytes": 18234, "projects": [ { "id": "prj_01K70000000000000000000002", "name": "billing-svc", "root": "/Users/me/code/billing-svc", "bytes": 18234, "threads": [] } ] } }`.

### 7.14 A thread's attachments

```sh
curl -sS "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/attachments" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "serverSession": "00000000000000000000000000000001",
  "attachments": [
    {
      "id": "att_01K70000000000000000000020",
      "path": "/Users/me/code/billing-svc/plans/retry-plan.md",
      "named_path": null,
      "name": "retry-plan.md",
      "kind": "markdown",
      "sent_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "size": 1840,
      "sent_at": "2026-10-08T10:42:00.000Z",
      "sent_mtime": "2026-10-08T10:41:30.000Z",
      "message_id": "msg_01K70000000000000000000010",
      "current": { "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "size": 1902, "mtime": "2026-10-08T11:05:00.000Z" },
      "changed_since_sent": true,
      "unavailable": null
    }
  ],
  "inline_images": [],
  "annotations": []
}
```

`inline_images` (additive, 2026-10-15): the images the thread's messages show, captured as files of the thread (approval "inbox-image-viewer"): the same state shape as an attachment, plus `ref` (the src exactly as the body wrote it) and, for a message sent before images were captured, `captured: "on_open"` and `captured_at` (the copy was taken the first time the thread was read). They are reached by id through the same routes as attachments (`attachments/:id/image`, `download`, annotations), and the message record carries them as `inline_images` too. They are never in `attachments`, so an app that does not know the field draws nothing extra. An app that sends with `export_feedback` (section 5) should pass these states in its `attachments` list too, so comments the person left on them in the window ride the Send; an older app's feedback text leaves them out.

### 7.15 An attachment's view

```sh
curl -sS "$INBOX/api/inbox/device/attachments/att_01K70000000000000000000021/view" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "serverSession": "00000000000000000000000000000001",
  "attachment": { "id": "att_01K70000000000000000000021", "name": "ticket-page.html", "kind": "html", "...": "the state of 7.14" },
  "version": "current",
  "text": "<!doctype html><html>...</html>",
  "html": "<!doctype html><html><head><base href=\"/api/html-assets/0000000000000001/\">...</head>...</html>"
}
```

The shell rewrites that base to `plannotator-asset://inbox/api/html-assets/0000000000000001/` before `open_attachment` (section 5).

### 7.16 An HTML asset

```sh
curl -sS "$INBOX/api/inbox/device/html-assets/0000000000000001/images/sun.png" -H "Authorization: Bearer $TOKEN" -o sun.png
```

`200`, the image's bytes and type, as annotate's asset route answers.

### 7.17 Save an annotation

```sh
curl -sS -X POST "$INBOX/api/inbox/device/annotations" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000006","attachment_id":"att_01K70000000000000000000020","version":"current","annotation":{"id":"ann-1","blockId":"block-7","startOffset":46,"endOffset":88,"type":"COMMENT","text":"Does Stripe say how long a key stays in flight?","originalText":"at most three times, 2, 4 and 8 seconds apart","createdA":1791460320000}}'
```

```json
{
  "annotation": {
    "id": "ann-1",
    "project_id": "prj_01K70000000000000000000002",
    "thread_id": "msg_01K70000000000000000000010",
    "message_id": "msg_01K70000000000000000000010",
    "attachment_id": "att_01K70000000000000000000020",
    "path": "/Users/me/code/billing-svc/plans/retry-plan.md",
    "version": "current",
    "annotation": { "id": "ann-1", "blockId": "block-7", "startOffset": 46, "endOffset": 88, "type": "COMMENT", "text": "Does Stripe say how long a key stays in flight?", "originalText": "at most three times, 2, 4 and 8 seconds apart", "createdA": 1791460320000 },
    "created_at": "2026-10-08T10:52:00.000Z",
    "updated_at": "2026-10-08T10:52:00.000Z",
    "removed_at": null,
    "sent_reply_id": null
  }
}
```

### 7.18 Remove an annotation

```sh
curl -sS -X POST "$INBOX/api/inbox/device/annotations/ann-1/remove" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000007"}'
```

`{ "annotation": <7.17's record with "removed_at": "2026-10-08T10:54:00.000Z"> }`.

### 7.19 A guided review

```sh
curl -sS "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000040/guide" -H "Authorization: Bearer $TOKEN"
```

`{ "message_id": "msg_01K70000000000000000000040", "guide": { "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "input_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "bytes": 5120, "title": "Token refresh", "sections": 1, "files": 2, "additions": 2, "deletions": 2 }, "snapshot": { "kind": "plannotator-guided-review", "...": "the stored snapshot" } }`. A message with none: `404 guide_not_found`.

### 7.20 A reviewed tick

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000040/guide/reviewed" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000008","reviewed":[true]}'
```

`{ "message_id": "msg_01K70000000000000000000040", "reviewed": [true] }`.

### 7.21, 7.22 (removed)

The decision switch and a project's decisions: removed with Decisions (2026-10). Both answer `404 device_route_not_found`.

### 7.23 Live sessions for New message

```sh
curl -sS "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/sessions" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "serverSession": "00000000000000000000000000000001",
  "home": "/Users/me",
  "project": { "id": "prj_01K70000000000000000000002", "key": "billing-svc-aaaaaa", "name": "billing-svc", "root": "/Users/me/code/billing-svc", "created_at": "2026-10-07T09:00:00.000Z" },
  "sessions": [
    { "session": "ses_01K70000000000000000000003", "host": "claude-code", "started_at": "2026-10-08T09:30:00.000Z", "last_seen_at": "2026-10-08T10:55:01.000Z", "busy": false, "idle_since": "2026-10-08T10:43:00.000Z", "wrote_thread": true }
  ]
}
```

### 7.24 New message

```sh
curl -sS -X POST "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/message" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000010","session":"ses_01K70000000000000000000003","body":"Also run them against the EU account."}'
```

`{ "message": { "id": "msg_01K70000000000000000000012", "reply_to": null, "author": { "kind": "person" }, "body": "Also run them against the EU account.", "to": { "host": "claude-code", "session": "ses_01K70000000000000000000003" }, "idempotency_key": "00000000-0000-4000-8000-000000000010", "...": "the rest of the message" }, "replayed": false }`. No live session: `409 session_not_live`, nothing written.

### 7.25 The phone removes itself

```sh
curl -sS -X POST "$INBOX/api/inbox/device/revoke" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

`{ "device": { "id": "dev_01K70000000000000000000001", "name": "iPhone", "platform": "ios", "created_at": "2026-10-08T10:03:12.000Z", "last_seen_at": "2026-10-08T10:56:00.000Z", "revoked_at": "2026-10-08T10:56:00.000Z" } }`. Every later request with that token: `401 device_revoked`. A path outside the allowlist, for example `GET $INBOX/api/inbox/device/settings`: `404 { "error": "Not a phone route.", "code": "device_route_not_found" }`.

### 7.26 Create a mailbox

```sh
curl -sS -X POST "$RELAY/v1/mailboxes" -H 'Content-Type: application/json' \
  -d '{"secret_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
```

`201 { "mailbox_id": "mbx_AAAAAAAAAAAAAAAAAAAAAA" }`. Past the reused creation brake: `429 { "error": "too many requests", "code": "too_many_requests" }` with `Retry-After: 60`.

### 7.27 Register a device

```sh
curl -sS -X PUT "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001" \
  -H 'Authorization: Bearer BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' -H 'Content-Type: application/json' \
  -d '{"secret_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cursor":1288}'
```

`200 { "device_id": "dev_01K70000000000000000000001" }`. A wrong mailbox bearer: `401 { "error": "unauthorized", "code": "unauthorized" }`.

### 7.28 Remove a device

```sh
curl -sS -X DELETE "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001" \
  -H 'Authorization: Bearer BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
```

`204`, sent by the Inbox when the device is revoked on the computer (7.25, 7.37). The device's queue, commands and APNs token are gone. With a device bearer: `401 unauthorized`.

### 7.29 Register the APNs token

```sh
curl -sS -X PUT "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001/apns" \
  -H 'Authorization: Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' -H 'Content-Type: application/json' \
  -d '{"token":"0000000000000000000000000000000000000000000000000000000000000000","environment":"sandbox"}'
```

`204`.

### 7.30 Post a push

```sh
curl -sS -X POST "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/push" \
  -H 'Authorization: Bearer BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' -H 'Content-Type: application/json' \
  -d '{"device_id":"dev_01K70000000000000000000001","collapse_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ciphertext":"AAAAAAAAAAAAAAAAexampleciphertextexample"}'
```

`202 { "sent": true }`. With no push token registered: `200 { "sent": false, "reason": "no_push_token" }`. On a relay without the APNs key: `200 { "sent": false, "reason": "no_apns_key" }`. Apple refusing the provider token: `502 { "error": "APNs answered 403 InvalidProviderToken.", "code": "apns_failed", "apns_status": 403, "apns_reason": "InvalidProviderToken" }`.

### 7.31 The Inbox's socket

```sh
websocat -H 'Authorization: Bearer BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' \
  "wss://relay.plannotator.ai/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/socket"
```

```
< {"type":"hello","devices":[{"device_id":"dev_01K70000000000000000000001","cursor":1288,"carriage":true,"apns":true}]}
> {"type":"item","device_id":"dev_01K70000000000000000000001","cursor":1289,"ciphertext":"AAAAAAAAAAAAAAAAexampleciphertextexample"}
< {"type":"command","device_id":"dev_01K70000000000000000000001","id":"00000000-0000-4000-8000-000000000003","ciphertext":"AAAAAAAAAAAAAAAAexamplecommandexample"}
> {"type":"item","device_id":"dev_01K70000000000000000000001","cursor":null,"ciphertext":"AAAAAAAAAAAAAAAAexampleresultexample"}
> {"type":"applied","device_id":"dev_01K70000000000000000000001","id":"00000000-0000-4000-8000-000000000003"}
```

The command's plaintext, under the up key `U`, is `{"v":1,"id":"00000000-0000-4000-8000-000000000003","method":"POST","path":"/api/inbox/device/messages/msg_01K70000000000000000000010/reply","body":{"idempotency_key":"00000000-0000-4000-8000-000000000003","words":"Go ahead.","questions":[{"key":"q-1a2b3c4d","revision":1}]}}`; the result item's plaintext is `{"v":1,"type":"result","id":"00000000-0000-4000-8000-000000000003","status":200,"content_type":"application/json; charset=utf-8","body_b64":"<7.11's answer as base64>"}`.

### 7.32 The phone fetches after a cursor

```sh
curl -sS "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001/items?after=12" \
  -H 'Authorization: Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
```

`{ "items": [ { "n": 13, "ciphertext": "AAAAAAAAAAAAAAAAexampleciphertextexample" }, { "n": 14, "ciphertext": "AAAAAAAAAAAAAAAAexampleresultexample" } ], "inbox_online": true }`.

### 7.33 The phone acknowledges

```sh
curl -sS -X POST "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001/ack" \
  -H 'Authorization: Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' -H 'Content-Type: application/json' -d '{"through":14}'
```

`204`. Items 13 and 14 are deleted. A phone that read the store directly up to seq 1301 sends `-d '{"cursor":1301}'` instead, and every record item at or below 1301 is deleted.

### 7.34 The phone sends a command up

```sh
curl -sS -X POST "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001/commands" \
  -H 'Authorization: Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' -H 'Content-Type: application/json' \
  -d '{"id":"00000000-0000-4000-8000-000000000003","ciphertext":"AAAAAAAAAAAAAAAAexamplecommandexample"}'
```

`202 { "queued": true, "inbox_online": false }`. The same `id` again: `200 { "queued": false, "inbox_online": false }`.

### 7.35 The phone's relay switch

```sh
curl -sS -X PUT "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001/carriage" \
  -H 'Authorization: Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' -H 'Content-Type: application/json' -d '{"on":false}'
```

`204`. The device's held items are deleted, and the Inbox's socket receives `{"type":"carriage","device_id":"dev_01K70000000000000000000001","on":false,"cursor":null}`. Back on, with the store cursor the phone holds: `-d '{"on":true,"cursor":1301}'`, and the socket receives `{"type":"carriage","device_id":"dev_01K70000000000000000000001","on":true,"cursor":1301}`.

### 7.36 The window lists devices

```sh
curl -sS http://127.0.0.1:52817/api/inbox/devices
```

`{ "devices": [ { "id": "dev_01K70000000000000000000001", "name": "iPhone", "platform": "ios", "created_at": "2026-10-08T10:03:12.000Z", "last_seen_at": "2026-10-08T10:55:01.000Z", "revoked_at": null, "carriage": true } ] }`.

### 7.37 The window removes a device

```sh
curl -sS -X POST http://127.0.0.1:52817/api/inbox/devices/dev_01K70000000000000000000001/revoke -H 'Content-Type: application/json' -d '{}'
```

`{ "device": { "id": "dev_01K70000000000000000000001", "name": "iPhone", "platform": "ios", "created_at": "2026-10-08T10:03:12.000Z", "last_seen_at": "2026-10-08T10:55:01.000Z", "revoked_at": "2026-10-08T11:00:00.000Z", "carriage": true } }`. The Inbox then sends 7.28 to the relay. The phone's next request answers `401 device_revoked`.

### 7.38 An image a message shows

The message body (an agent's question, its context written as markdown):

```markdown
:::question
Keep the new header?
It moves search into the header:
![mock](shots/header-mock.png)
- Keep it
- Go back
:::
```

```sh
curl -sS "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000031/image?path=shots%2Fheader-mock.png" -H "Authorization: Bearer $TOKEN" -D - -o header-mock.png
```

`200` with the bytes, `Content-Type: image/png` (sniffed), `ETag: "<sha256 of the bytes>"`, `Cache-Control: private, no-cache` and the guard headers of the door table. `path` is the source exactly as the body writes it (percent-encoded in the query). Again with `-H 'If-None-Match: "<that sha256>"'`: `304`, no body, the same headers, while the file is unchanged; a changed file answers `200` with a new ETag. A path the body does not reference: `403 { "code": "image_not_referenced" }`.

### 7.39 Every live session (compose)

Added 2026-10-15 with 7.40 to 7.49 and 7.53, the phone parity rows. Each mirrors a window route as it is in 0.28.21 and adds nothing to it.

```sh
curl -sS "$INBOX/api/inbox/device/sessions?session=ses_01K70000000000000000000003" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "serverSession": "00000000000000000000000000000001",
  "home": "/Users/me",
  "projects": [
    {
      "project": { "id": "prj_01K70000000000000000000002", "name": "billing-svc", "root": "/Users/me/code/billing-svc" },
      "sessions": [
        { "session": "ses_01K70000000000000000000003", "host": "claude-code", "started_at": "2026-10-15T09:30:00.000Z", "last_seen_at": "2026-10-15T10:55:01.000Z", "busy": false, "idle_since": "2026-10-15T10:43:00.000Z", "last_thread": { "id": "msg_01K70000000000000000000010", "subject": "Retry worker", "at": "2026-10-15T10:42:00.000Z" } }
      ]
    }
  ],
  "session": { "session": "ses_01K70000000000000000000003", "live": true }
}
```

A folder the Inbox has not seen yet has `project.id: null`. `session` is present only with `?session=`.

### 7.40 Start a thread (compose)

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000040","to":{"host":"claude-code","session":"ses_01K70000000000000000000003"},"body":"Add a retry budget to the webhook worker.","uploads":["upl_01K70000000000000000000048"]}'
```

`{ "thread_id": "msg_01K70000000000000000000040", "message": { "id": "msg_01K70000000000000000000040", "started_by_person": true, "reply_to": null, "to": { "host": "claude-code", "session": "ses_01K70000000000000000000003" }, "attachments": [{ "name": "notes.txt", "...": "an ordinary attachment" }], "...": "the rest of the message" }, "project": { "id": "prj_01K70000000000000000000002", "name": "billing-svc", "root": "/Users/me/code/billing-svc" }, "replayed": false }`. The same key again: the recorded answer with `Idempotent-Replayed: true`. No live session: `409 session_not_live`, nothing written; the phone keeps the words. Through the relay this is applied only when the computer is online, so `session_not_live` is the likely answer after a long wait. With `"board_request": true` (the Board chip; only while the Board is on) the message carries `"board_request": true` and its words are as typed.

### 7.41 Send to another session

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000040/to" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000041","to":{"host":"pi","session":"ses_01K70000000000000000000004"}}'
```

`{ "message": { "id": "msg_01K70000000000000000000040", "to": { "host": "pi", "session": "ses_01K70000000000000000000004" }, "...": "" }, "row": { "...": "the thread's list row" } }`. Once a session took it: `409 already_delivered`; an agent's message: `422 not_addressed`; a session not live: `409 session_not_live`.

### 7.42 Search

```sh
curl -sS "$INBOX/api/inbox/device/search?q=retry%20budget&status=waiting" -H "Authorization: Bearer $TOKEN"
```

The window's answer unchanged (`docs/agent-guides/inbox-notifications-and-agents.md`, "Search"): `{ "serverSession": "…", "q": "retry budget", "terms": ["retry", "budget"], "took_ms": 4, "indexing": false, "threads": 412, "totals": { "threads": 1, "messages": 2, "files": 0, "projects": 0 }, "groups": { "threads": [ { "type": "thread", "id": "msg_01K70000000000000000000040", "...": "" } ], "...": "" }, "recent": null }`. The first search after a start may answer `indexing: true` with `groups: null`: ask again a moment later. A bad parameter: `422`.

### 7.43 Mark a project read

```sh
curl -sS -X POST "$INBOX/api/inbox/device/projects/prj_01K70000000000000000000002/read" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000043"}'
```

`{ "project": { "id": "prj_01K70000000000000000000002", "...": "" }, "batch": { "read": ["msg_01K70000000000000000000010", "msg_01K70000000000000000000020"] }, "threads": [ { "...": "each row" } ], "replayed": false }`. A write that failed partway is still `200`, with `error: { code: "batch_incomplete" }` and the threads that did change. The same key again replays this answer and runs nothing.

### 7.44 Undo it

```sh
curl -sS -X POST "$INBOX/api/inbox/device/projects/prj_01K70000000000000000000002/unread" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000044","threads":["msg_01K70000000000000000000010","msg_01K70000000000000000000020"]}'
```

`{ "project": { "...": "" }, "threads": [ { "...": "" } ], "skipped": [] }`.

### 7.45 Archive a project, and its Undo

```sh
curl -sS -X POST "$INBOX/api/inbox/device/projects/prj_01K70000000000000000000002/resolve" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000045"}'
```

`{ "project": { "...": "" }, "batch": { "resolved": ["msg_01K70000000000000000000010"], "read": [] }, "threads": [ { "...": "" } ], "replayed": false }`. Undo: `{ "idempotency_key": "…046", "resolved": false, "threads": { "resolved": ["msg_01K70000000000000000000010"], "read": [] } }` answers `{ project, threads, skipped }`.

### 7.46 The skill catalog

```sh
curl -sS "$INBOX/api/inbox/device/skills" -H "Authorization: Bearer $TOKEN"
```

`{ "skills": [ { "name": "readback", "root": "claude", "description": "State the request back.", "humanOnly": true, "dir": "/Users/me/.claude/skills/readback" } ] }`.

### 7.47 One skill's SKILL.md

```sh
curl -sS "$INBOX/api/inbox/device/skills/content?name=readback" -H "Authorization: Bearer $TOKEN"
```

`{ "skill": { "name": "readback", "dir": "/Users/me/.claude/skills/readback", "path": "/Users/me/.claude/skills/readback/SKILL.md", "content": "---\nname: readback\n…", "truncated": false, "humanOnly": true } }`. A name not discovered: `404`.

### 7.48 Upload a file

```sh
curl -sS -X POST "$INBOX/api/inbox/device/uploads?name=notes.txt&idempotency_key=00000000-0000-4000-8000-000000000048" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/plain' --data-binary @notes.txt
```

`{ "upload": { "upload_id": "upl_01K70000000000000000000048", "name": "notes.txt", "size": 19, "kind": "text", "sha256": "aaaa…", "created_at": "2026-10-15T11:00:00.000Z" } }`. The same key again: the same `upl_` id and `Idempotent-Replayed: true`; of the bytes sent again the door reads and drops at most 1 MiB or 2 s, then answers with `Connection: close`. No key: `422 { "field": "idempotency_key" }`. `.env`: `422 upload_refused`. Over 100 MB, declared or counted as it streams: `413 upload_too_large` with `Connection: close`, nothing recorded under the key. An upload no message names is forgotten after a day. Through the relay: `413 relay_upload_unavailable`.

### 7.49 Upload a drawing

```sh
curl -sS -X POST "$INBOX/api/inbox/device/markups?idempotency_key=00000000-0000-4000-8000-000000000049" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: image/png' --data-binary @drawing.png
```

`{ "path": "/Users/me/.plannotator/inbox/markups/aaaa….png", "name": "aaaa….png", "url": "/api/inbox/markups/aaaa….png" }`. Read back with `GET markups/<name>`; name it in an annotation's `images` as the window does. Not an image: `422`. Past 32 MB (declared, or counted as it streams): `413 markup_too_large` with `Connection: close`. Through the relay: `413 relay_upload_unavailable`.

### 7.53 A comment on a guided review's diff

7.50 to 7.52 (shared drafts) are held and not built; 7.54, 7.55 (decision retire and replace) will not be built (Decisions were removed, 2026-10). 7.56 is 👍 Looks good, 7.57 a reply carrying files, 7.58 Send now, 7.59 a comment on the text of an agent's message, 7.60 tagging agents in a reply, 7.61 Re-ask, 7.62 a thread's unsent work and its reply draft (below).

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000020/guide/annotations" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000053","annotation":{"id":"ann-guide-1","type":"comment","scope":"line","filePath":"src/auth.ts","lineStart":1,"lineEnd":1,"side":"new","text":"Refresh before it expires.","createdAt":1760526000000}}'
```

`{ "annotation": { "id": "ann-guide-1", "message_id": "msg_01K70000000000000000000020", "attachment_id": "", "path": "src/auth.ts", "version": "<the guide snapshot's sha256>", "guide": { "title": "Token refresh", "file": "src/auth.ts", "side": "new", "line_start": 1, "line_end": 1 }, "sent_reply_id": null, "...": "" } }`. Rides the next Send like the window's (`annotation_ids` on 7.11, the feedback text built as the window builds it). Remove with 7.18. A file not in the patch or lines outside one hunk: `422 validation_error`; no guide on the message: `404 guide_not_found`; removed or sent: `409 annotation_closed`.

### 7.56 👍 Looks good, and its Undo

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000020/ack" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000056"}'
```

`{ "message": { "id": "msg_01K70000000000000000000020", "ack": { "label": "Looks good", "at": "2026-10-15T11:00:00.000Z", "read_seq": 41, "made_read": true, "settled_seq": null, "settled_at": null, "seen_at": null }, "...": "" }, "thread": { "section": "quiet", "read_at": "2026-10-15T11:00:00.000Z", "ack": { "label": "Looks good", "at": "2026-10-15T11:00:00.000Z" }, "...": "" } }`. Undo: `{ "idempotency_key": "…057", "ack": false }` answers the same shape with `ack: null`. Ten seconds after it stands, the Inbox writes `settled_seq` (agents see it from then on: `read_thread` carries `ack: { label, at }`, and `wait_for_reply` answers `{ status: "acknowledged" }`), and once an agent reads it, `seen_at` (the window draws "<agent> saw it"). Nothing is pushed for it, ever.

### 7.57 A reply carrying files

The window's reply box takes pasted images (2026-10-16); the door carries the same field. Upload each file first (7.48), then name the ids on the Send:

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000020/reply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000057","words":"This is what I see.","questions":[],"uploads":["upl_01K70000000000000000000057"]}'
```

7.11's answer, with `reply.attachments` holding each file as an ordinary attachment record (the same as 7.40's thread). The agent reads them as `Attached: <name> (<path>)` lines under the words, on its wake and from `wait_for_reply`. A Send of files alone (no words, no answers) is a reply, read as a words-only one. Replaying the key answers the reply it wrote and copies nothing; an id that is gone: `404 upload_not_found`, nothing written. On a Send that answers several sessions, name the files on the reply that carries the words (the last), as the window does.

### 7.58 Send now

The line under the person's last reply says where it is (the window's `deliveryLine`, `packages/inbox/deliveryLine.ts`): for a reply to a message with `wakes`, or a message with `to`, read `GET threads/:id/sessions?asker=<that session>`; `asker.connection.busy` true reads "Undelivered N min · <agent> is working · goes in by itself in M min" (below), false reads "Sending to <agent>…", null (the connection does not say) or no `connection` reads "Queued for <agent>; it gets this as its next turn", `connection: null` reads "Queued for <agent>; it gets this when its session is back"; `deliver_now_at` on the message reads "Sending to <agent> now…"; a reply to a message without `wakes` reads "Saved for <agent>. It sees it when it next reads this thread". Offer Send now only while `connection.busy` and `connection.send_now` are true:

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000058/send-now" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000058"}'
```

`{ "message": { "id": "msg_01K70000000000000000000058", "deliver_now_at": "2026-10-16T17:06:00.000Z", "...": "" } }`. The session's connection then puts it into the running turn (Claude Code: a user row; Pi and OpenCode 2: a steer) and records the delivery as usual ("Delivered to <agent>, <time>").

Undelivered replies go in by themselves (approval "inbox-busy-agent-reply", 2026-10-21; additive). A reply, message or Re-ask note that waits on a busy session whose connection says `send_now` goes into the running turn by itself after 5 minutes (`INBOX_AUTO_SEND_AFTER_MS`): the Inbox writes `deliver_now_at` with `deliver_now_by: "auto"` and `wait_started_at` (a press through this route writes `"person"`; on a tag, the tag's own fields), so it needs no window and no phone. The wait is the Inbox's clock, never the message's `created_at`: `asker.connection.waits[<message id>]` = `{ since, auto_since }`, where `since` is the first time the Inbox saw that session busy while the message waited (the "Undelivered N min" number) and `auto_since` the first time it also saw the session able to take it mid-turn (null until then). A message moved to another session (7.41) starts again there, and the move clears `deliver_now_at`, `deliver_now_by` and `wait_started_at`; a session that goes away, or an Inbox restart, starts its clocks again. The phone draws it as the window does: while `asker.connection.busy` is true and `waits` holds the message, the line reads "Undelivered N min · <agent> is working · goes in by itself in M min" (whole minutes from `since`; "Undelivered" under one minute; the countdown is `auto_since` + `asker.connection.auto_send_after_ms`, shown only while `connection.send_now` is true, `auto_since` is set and the message has no `deliver_now_by`; absent `auto_send_after_ms` or `waits`, an older Inbox, no countdown and no minutes: "Queued · <agent> is working; it gets this when its turn ends") with Send now, or, while `send_now` is false, "… · it gets this when its turn ends" and that it cannot go in sooner. `connection: null` (the session stopped polling) reads "Queued for <agent>; it gets this when its session is back" even when `deliver_now_at` is set: never "Sending … now". After: `delivery` with `deliver_now_by: "auto"` reads "Delivered to <agent>, <time> · went into its turn by itself after N min" (N whole minutes from `wait_started_at` to `deliver_now_at`) when `delivery.into_turn` is true or absent, and "Delivered to <agent>, <time> · went in when its turn ended" when `delivery.into_turn` is false (the session's own Ask question held the turn). The list row's `delivery` carries the same: `waiting_since`, `steerable`, `auto_send_at`, `auto_after_min`, `turn_ended`. The note carrying a 👍 never goes in by itself (owner's decision 2026-10-21, "a thumbs-up isn't worth interrupting a turn"): it waits for the turn to end; its line and the row's `delivery` (kind `ack`) say how long it waited, with no countdown (`auto_send_at` null) and no Send now.

### 7.59 A comment on the text of an agent's message

Added 2026-10-19 (approval "inbox-message-comments"). The window lets the person select words in an agent's message and comment on them, as on an attached file; the door carries the same route. The annotation is Plannotator's text-selection annotation: `type` `"COMMENT"` (a 👍 is a comment with `isQuickLabel: true` and `text: "👍 Looks good"`), `originalText` the exact words selected (1 to 20,000 characters), `text` the comment.

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000020/annotations" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000059","annotation":{"id":"ann-message-1","blockId":"block-1","startOffset":0,"endOffset":0,"type":"COMMENT","originalText":"two, four and eight seconds","text":"Cap the total wait too.","createdA":1760526000000}}'
```

`{ "annotation": { "id": "ann-message-1", "message_id": "msg_01K70000000000000000000020", "attachment_id": "", "path": "msg_01K70000000000000000000020", "version": "current", "message": { "at": "<the message's created_at>" }, "sent_reply_id": null, "...": "" } }`. It is listed with the thread's other annotations (7.14's `annotations`), rides the next Send like the window's (`annotation_ids` on 7.11, the feedback text built as the window builds it: the surface's `export_feedback` writes it under "Feedback on your message from <time> (<message id>)", the time in the phone's own time zone from `message.at`, so pass these records to it as they are). Remove with 7.18. An edit is the same annotation id under a new key. The person's own message: `422 annotation_not_allowed`; not a comment, or an id used on a file, a guide or another message: `422 validation_error`; no such message: `404 message_not_found`; a message an archive closed: `409 thread_resolved`; removed or sent: `409 annotation_closed`. The app draws message bodies natively, so it decides how to offer the selection; the window offers it on an agent's message only, never inside a question card.

### 7.60 Tagging agents in a reply

Added 2026-10-20 (approval "inbox-tag-agents", Lines variant). The person may tag other agent sessions with `@` in a reply; ONE reply goes to its owner (the session it goes to anyway) and to every tagged session, and each records its own delivery. Who can be tagged:

```sh
curl -sS "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/taggable" -H "Authorization: Bearer $TOKEN"
```

`{ "owner": { "host": "claude-code", "session": "…" }, "sessions": [{ "session": "pi-0193", "host": "pi", "kind": "live", "taggable": true, "owner": false, "project": { "name": "infra", "…": "" }, "…": "" }, { "session": "ses_docs_codex", "host": "codex", "kind": "mcp", "name": "Codex", "…": "" }] }`. A `kind: "live"` session is woken by its connection; `kind: "mcp"` reads the Inbox only (it sees the tag the next time it reads the thread; say so). `taggable: false` is a live session on an older Plannotator: offer "Update Plannotator to tag this session", never the tag. The reply carries the tags additively (forwarded unchanged):

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000010/reply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000060","words":"Queue it. @Pi raise the timeout.","tags":[{"host":"pi","session":"pi-0193","label":"Pi"}]}'
```

`reply.tags`: `[{ host, session, label?, name?, wakes, delivery?, deliver_now_at?, read_at? }]`, never the owner. Draw one line per recipient under the reply (the owner first, as 7.58 says, then each tag): `delivery` reads "Delivered to <label>, <time>"; a tag with `wakes` and no delivery reads like 7.58 from `GET threads/:id/sessions?recipients=<session>,<session>` (`recipients: { <session>: connection or null }`), and Send now for that one session is 7.58 with `{ idempotency_key, session }`; a tag without `wakes` reads "Saved for <label>. It sees it the next time it reads this thread", or "<label> read this thread, <time>" once `read_at` is set. The list row's `sent.recipients` (`[{ host, session, name?, owner, wakes, delivered_at }]`) and `participants` (`[{ host, session, name? }]`) are additive. Refusals, nothing written: a live session on an older Plannotator `409 tag_needs_update`; a session known under another host than the tag names `409 tag_host_mismatch`; a session that is neither live nor a known MCP agent `409 session_not_live`; a malformed list `422 validation_error`. Replaying the key answers the reply it wrote, its tags as they were.

### 7.61 Re-ask

Added 2026-10-20 (approval "inbox-reask"). The person asks the agent that asked to ask its questions still open in the thread again, together in one new message, with fresh context. Name the latest message of that session that has an open question:

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000020/reask" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000061"}'
```

`{ "message_id": "msg_01K70000000000000000000020", "questions": [ … ], "reply": { "id": "msg_…", "author": { "kind": "person" }, "reask": ["msg_…/q-…", "…"], "body": "Please ask your 3 open questions …", "...": "" }, "replayed": false }`. The note (`reply.reask`, the ids it asked about) is the person's reply: it is delivered like one (7.58's lines and Send now apply), and while it is the thread's last message the row is in Sent (`reask_pending: true` on the row). Every question of that session that is open goes in the list; one the person picked and has not sent goes with the note as an answer (its state becomes `sent`). The old questions stay open until the agent's new message replaces them (their `state` becomes `superseded`); draw the note as one line ("You asked <agent> to ask the N open questions again, together in one message. They stay open here until it does."), its body behind a disclosure. Questions from several sessions: one Re-ask per session, each to that session's own message. The session that asked has ended: `{ idempotency_key, to: { host, session } }` names a live session of the project (as 7.11's `to`); not live `409 session_not_live`, nothing written. Nothing left open for that session: `409 nothing_to_reask`; a person's message: `422 validation_error`; a message an archive closed: `409 thread_resolved`. Replaying the key answers the note it wrote.

### 7.62 The unsent work in a thread, and its reply draft (read only)

A list row carries `unsent` (additive, approval "inbox-reply-drafts"): `{ reply_at, picks, comments }`, or null. `reply_at` is when the words typed in the thread's reply box on the computer were last saved (null when none); `picks` the picks saved and not sent; `comments` the comments waiting for a Send. Draw it in the row's count slot as "Draft · Your reply" (or "Draft · 2 picks", "Draft · Your reply, 1 comment"; "Draft" in the accent colour, the rest muted). A thread holding any of it is never in Quiet unless archived: the Inbox places it in New since you looked, not bold when only the person's own words or comments put it there. A Re-ask that waits (7.61) keeps its row in Sent as before; the row still carries `unsent`. `GET threads/:id/draft` reads the draft's words, so the phone can show them:

```sh
curl -sS "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/draft" -H "Authorization: Bearer $TOKEN"
```

`{ "serverSession": "…", "draft": { "v": 1, "thread_id": "msg_01K70000000000000000000010", "body": "Cards, but keep the totals column", "created_at": "…", "updated_at": "…" } }`. The door writes no reply draft in v1: the phone composes its own reply, and a Send from the phone leaves the computer's draft alone (the window's own Send clears it). The door forwards a reply's `clear_draft` unchanged, so the phone must not send it for words it did not prefill from this draft: `clear_draft` names the draft's `updated_at`; the draft goes while it is still that draft or holds exactly the reply's `words` (trimmed), so a stale value or `''` clears only a draft of the words just sent, and a newer, different draft stays. Only a reply carrying that draft's own words may name it. A later row can add writes with the window's compare-and-set (`base` = the `updated_at` read; `409 draft_conflict` with the newer draft).

### 7.63 An action item's Done, Can't do it, and its Undo

Added 2026-10-21 (approval "inbox-next-actions", direction "In the thread"). An agent may write an Inbox-only `:::action` block: something the person must go and do outside the conversation (approve a deploy, sign in, touch a security key, merge a pull request the agent cannot merge). Additive on the wire:

- The message's `questions` list carries each action item after its questions, with `kind: "action"`, a key `a-` + 8 hex (`-2`, `-3` for repeats), `position` counted among the message's action items only (draw "Action item 1 of 2"; the agent reads A1, A2), `prompt` what to do, `context` the why, `stopped` and `holds_up` as for a question, `choices: []`, `answer: null`, and two additive fields: `action: { where, where_url, run, watching }` (`where_url` is http(s) only: the card's Open button; `run` a command to copy; `watching` what the agent watches, drawn as "<agent> is watching: …") and `action_result: { outcome: "done" | "cant", note, at, by: "person" | "agent", message_id? } | null`.
- **Read `kind` fail-closed.** A kind other than `single`, `multi` or `text` is never answerable: an app that does not know `action` must not offer picks, Other, a note or Skip on it (draw it read-only, or as the Action item card below). The door refuses an action item's key in a pick, a Send's answers or `skip` (`422 validation_error`), and refuses a question's key on this route (the route matches `a-…` keys only: `404 device_route_not_found`).
- States, as for a question: `open`; `picked` while the person's Done is inside its 10 s Undo window (offer Undo; nothing has gone to the agent); `sent` once the person's reply carrying it was written (`sent_reply_id`); `closed` when the agent saw it done itself (`action_result.by: "agent"`), a Mark read set it aside (`set_aside_at`), or the archive closed it; `superseded` as for a question. The card's words: "You marked it done, 3:12 PM. Goes to <agent> in a few seconds." (picked), "… Sent to <agent>." (sent, done), "You can't do it: “<reason>” Sent to <agent>." (sent, cant), "<agent> saw it done, 3:14 PM." (agent), "Set aside when you marked the thread read. <agent> was told not to wait." (set aside).
- The list: an action item counts like an open question for every rule (Stopped on you by its `Stopped:` line, Holding up work, Waiting on you), for the push and the sound. The row's `questions` summary gains `actions` (how many of `open` are action items): the count reads "1 action item", or "1 question, 1 action item". An action item inside its Undo window is not counted in `picked`.

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000020/actions/a-4f2c19e0" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000063","outcome":"done","note":"Approved."}'
```

`{ "questions": [ { "key": "a-4f2c19e0", "kind": "action", "state": "picked", "action_result": { "outcome": "done", "note": "Approved.", "at": "…", "by": "person" }, "...": "" } ] }`. The same key again answers the recorded result (`Idempotent-Replayed: true`). Undo inside the window: the same route with `"outcome": null` under a new key. Once the window passes, the Inbox writes the person's reply (`action_report` names the action items it reports; its body starts "Did 1 action item." and carries "## Action items you asked for") and delivers it like any reply; the phone's thread sees it as a new person message and the action item as `sent`.

Re-ask (7.61) includes the session's open action items with its open questions (owner, #2059): the note's `reask` ids may name `a-…` keys. An action item the person marked inside its Undo window is not open and is left out.

The agent may mark its own action item done (send_message's `done`): the action item then reads `closed` with `action_result.by: "agent"`, and nothing is sent to the person (no push).

## 8. What this contract leaves out

The Workspaces app's side (it has its own contract, and decides how to draw a message's images), the iPad, pairing through the relay, deleting a mailbox, a retention sweep at the relay, rates beyond the reused creation brake, raw attachment bytes on the door, device attestation, request signing, re-authentication, and any Settings, restart or storage route on the phone.

## 9. Rulings written in (2026-10-08)

The eight questions the first draft left open were ruled on 2026-10-08; each is now part of the sections above.

1. Pairing through the relay is not in v1. With neither path on, "Pair a phone" offers the Wi-Fi switch (section 1).
2. The QR link carries no `mailbox`; the redemption's answer carries the relay (section 1).
3. The phone's relay switch is `PUT .../devices/:dev/carriage`. Its state lives in the device record, and a reconnect registers only devices with carriage on (sections 2 and 4).
4. Pushes go out for questions and guided reviews only (section 4, Push).
5. The relay has no time sweep. A phone reading directly acknowledges by store cursor (section 4).
6. Mailbox creation reuses guides.show's per-IP brake, with no new number (section 4, Routes).
7. The certificate and the Bonjour record come from `openssl` and `dns-sd` (`avahi-publish` on Linux) as child processes, with no dependency (section 3).
8. The tailnet HTTPS port is 8443, kept in `inbox.json`. A mapping held by something else is reported, never overwritten (section 1).

## 10. The Android addendum (C2, 2026-10-10)

The Android app (`ai.plannotator.app`, the same name as the iPhone bundle; Android 13, API 33, and later) builds against sections 1 to 7 unchanged: the same door, routes, errors, idempotency keys, envelopes, vectors and bridge messages. This section names only what differs. Android's own ceilings apply where Android sets them (an FCM data payload of 4096 bytes, three notification actions); there are no other limits.

### The platform

The redemption body (section 2, exchanges 7.2 and 7.3) carries `platform: "android"`, and the device record keeps it: `platform` is `"ios"` or `"android"`. The window's device list reads it; nothing else branches on it. The relay never reads it: it routes a push by whichever token the device holds.

### Push through FCM

- **The token route:** `PUT /v1/mailboxes/:mbx/devices/:dev/fcm`, device bearer, `{ token }`; `token: null` removes it; `204`. A device holds at most one push token: registering an FCM token clears any APNs token and the reverse. The relay keeps the FCM token plain, as it keeps the APNs token (Google needs it), and deletes it with the device (7.28).
- **`hello`** lists `"fcm": boolean` beside `"apns"` for each device.
- **`POST .../push`** is unchanged on the Inbox's side: the relay sends to whichever token the device holds. Its answers gain `200 { sent: false, reason: "no_fcm_key" }` (the relay holds no FCM service account), `200 { sent: false, reason: "fcm_gone" }`, and `502 fcm_failed` with `fcm_status` and `fcm_reason` (FCM's `errorCode`, or null). With neither token the relay answers `no_push_token` (a relay before R3 answered `no_apns_token`; the Inbox only logs the reason, so it reads both alike). FCM's `UNREGISTERED` is the only refusal that deletes the token; every other refusal, a 5xx included, is `502 fcm_failed` and keeps it. A token exchange Google refuses, or a host that cannot be reached, is `502 fcm_failed` with no `fcm_status`, as `apns_failed` is for a transport failure.
- **What the relay sends:** FCM HTTP v1, `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send`, with an OAuth token the relay mints from the service account it holds as a Worker secret and reuses for 50 minutes. The secret is `FCM_SERVICE_ACCOUNT`, the service account's JSON key file whole; its `project_id` is `<project>`. The OAuth token is a JWT (`RS256`, `kid` the key file's `private_key_id`, `iss` its `client_email`, `scope` `https://www.googleapis.com/auth/firebase.messaging`, `aud` `https://oauth2.googleapis.com/token`, an hour from `iat` to `exp`) signed with WebCrypto and exchanged at `https://oauth2.googleapis.com/token` for an access token (written in by R3). Plain `fetch`: FCM accepts HTTP/1.1, so the `connect()` path APNs needs is not used. The body is data only, so the app draws every notification itself from the decrypted summary:

  ```json
  { "message": { "token": "<fcm token>", "data": { "e": "<envelope>" }, "android": { "priority": "high", "collapse_key": "<collapse_id>" } } }
  ```

- **The summary and its sizes:** the push plaintext, `type: "push"`, the `collapse_id` and the size ladder are section 4's, byte for byte. The ladder stays measured against the APNs body: `{"e":"<envelope>"}` is smaller than the APNs body around the same envelope, so an envelope that fits Apple's 4096 bytes fits FCM's, and the last rung (`{ v, type, thread_id, message_id }`) is the push's form of the `too_large` placeholder: the phone reads the rest by `thread_id`. R3 tests that the two measures agree. `collapse_key` only replaces messages FCM still holds for an offline phone (FCM keeps four keys per device); on screen a thread's newer notification replaces its older one because the app posts it with the thread id as its tag.
- **Refresh and `UNREGISTERED`:** the app registers its token when the person allows notifications, again from `FirebaseMessagingService.onNewToken`, and at each start when `getToken()` differs from the token it last registered. Turning notifications off sends `token: null`. FCM's `UNREGISTERED` (404) deletes the token and answers `fcm_gone`, as Apple's 410 does; the app registers again on its next token. Allowing notifications changes nothing about carriage, as on iOS.

### The notification on Android

The messaging service, in the app's own process, opens `e` with the device key and posts on one "Questions" channel at high importance, with section 4's words: the title `subject`, the body `<agent> in <project>`, then `: <context>`. Every data push posts a notification, a push no key opens included ("Plannotator", "Question from an agent"): Android lowers the priority of an app whose high-priority messages show nothing. The lock screen shows the public version, "Question from an agent", so it never shows a subject or an agent's text with previews hidden.

Actions: a summary `question` with up to three choices gets one action per choice, recommended first, named `choice.<n>` by the index in `choices`, each with `setAuthenticationRequired(true)` (the Android form of `authenticationRequired`). A question with four choices gets one "Answer" action that opens the thread. That is the default; the owner's ruling on the four-choice layout is pending (a custom four-button layout is the alternative), and a ruling for it edits this paragraph. A tapped choice is one Send by a `BroadcastReceiver` under `goAsync()`, with section 4's paths, waits (3 s, then 5 s), key and outcome words.

### The surface bridge on Android

- **The origin:** the shell serves `surface.html` and every asset from `shouldInterceptRequest` on `https://appassets.androidplatform.net`, the virtual origin AndroidX's `WebViewAssetLoader` reserves, never fetched: the surface at `/surface/surface.html`, assets at `/inbox/api/html-assets/<token>/<path>`, and the `<base href>` rewrite of section 5 points there. Not a custom scheme: Android's web view gives a custom scheme no standard origin, so relative and base URLs resolve unreliably, and `addWebMessageListener`'s origin rules match only `http` and `https`; the one alternative, the `*` rule, would also hand the bridge to the agent's opaque-origin frame. With this origin the rule names one origin and that frame matches nothing.
- **The channel:** `WebViewCompat.addWebMessageListener(webView, "plannotatorShell", setOf("https://appassets.androidplatform.net"), listener)` injects `window.plannotatorShell`; S2's `postToShell` posts `JSON.stringify(message)` there when `window.webkit` is absent (the object takes strings). The shell takes a message only when the listener's `isMainFrame` is true, so a page embedded on the same origin cannot reach it. Shell to surface stays `window.plannotatorSurface.receive(message)`, called with `evaluateJavascript` and the message as a JSON literal. No web message listener (`WebViewFeature.WEB_MESSAGE_LISTENER` unsupported): the surface does not load.
- **No network, by two means:** every response the shell serves carries the surface's policy as its `Content-Security-Policy`, with `https://appassets.androidplatform.net` where iOS says `plannotator-asset:`. The build carries both: `surface.html`'s meta tag lists `https://appassets.androidplatform.net` beside `plannotator-asset:` in each directive that names the asset origin, so one file serves both platforms (S2; on iOS the content rule list blocks every https load, and on Android nothing serves `plannotator-asset:`); and the web view runs with `setBlockNetworkLoads(true)` while `shouldInterceptRequest` answers every http and https request off the virtual origin with a refusal, never `null` (which would load it). WebSockets do not pass through `shouldInterceptRequest`, so ws and wss rest on `connect-src 'none'` and the blocked network loads; the device spike proves a socket from the surface and from an agent's page fails. WebRTC is covered by neither: no current engine enforces CSP's `webrtc` directive (Chromium and WebKit both ignore `webrtc 'block'`), and STUN over UDP and TURN over TCP pass neither `setBlockNetworkLoads` nor `shouldInterceptRequest`, so the shell's document-start script, which deletes the RTC constructors and `navigator.mediaDevices` in every frame (sandboxed `srcdoc` frames with an opaque origin and the frames nested inside them included), is the only defence; the shell's proofs show zero STUN packets from an attached page and from a frame nested inside it.
- **Links and the touch window:** `window.open` reaches `WebChromeClient.onCreateWindow`, which makes no web view and opens the URL only within 1.2 s of the shell's touch (a touch listener that observes without consuming), only for `https` (a Custom Tab) or `mailto` (the mail app). `shouldOverrideUrlLoading` cancels every navigation away from the surface, as `decidePolicyFor` does. `pin`, `selection` and `draft` from an HTML attachment follow the same touch window. Comment comes through the selection's `ActionMode` menu, and `set_appearance.text_scale` is `Configuration.fontScale`.

### Platform notes on sections 1 to 7

- The Keychain (this device only, a group shared with the extension) is the Android Keystore: a non-exportable AES key sealing the token, the pairing secret and the source's cookies in app-private storage, excluded from backup and device transfer. No shared group: the messaging service runs in the app's process. Readable after the first unlock, so a push opens on a locked phone.
- The notification service extension is the `FirebaseMessagingService`; `SFSafariViewController` is Custom Tabs; the mail sheet is a `mailto` intent; the content rule list is the interception above.
- Section 1's tailnet rule holds: the app cannot ask the Tailscale app for its peers. The Wi-Fi pin is a trust manager on the Wi-Fi client only, comparing the leaf certificate's DER SHA-256; Android's own pinning hashes a public key for a domain and does not fit.
- The Workspaces side serves assetlinks.json for the App Link return and sends FCM for its own source.

### 10.1 Register the FCM token

```sh
curl -sS -X PUT "$RELAY/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/dev_01K70000000000000000000001/fcm" \
  -H 'Authorization: Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' -H 'Content-Type: application/json' \
  -d '{"token":"fcm-token-example"}'
```

`204`. Exchange 7.30 to this device then answers `202 { "sent": true }`; after FCM answers `UNREGISTERED`, `200 { "sent": false, "reason": "fcm_gone" }`.

## 11. Video (2026-10-15)

Design record "inbox-video" (approved by the owner 2026-10-15, not in this repo): an agent attaches a film; the person watches it in the Inbox on the Mac and on the phone, and comments at moments. Everything here is additive.

Before this, a film was an attachment of kind `file`, and the app opened it with the door's `GET attachments/:id/download`, which sent the whole file with no Range, so the app downloaded all of it before it played (AVPlayer from a local file). That fallback stays valid. What follows is the upgrade to streaming playback.

### 11.1 The kind `video`

- `InboxAttachmentState.kind` gets the value `"video"`. The Inbox decides it from the bytes: MP4/MOV with a video `ftyp` brand (an image or audio major brand such as `avif`, `heic`, `M4A ` keeps it out), or WebM by its EBML DocType `webm` (Matroska stays `file`).
- New optional fields on the state:
  - `media_type`: `"video/mp4" | "video/quicktime" | "video/webm"`
  - `duration_ms`: integer, MP4/MOV only (from `moov/mvhd`)
  - `width`, `height`: pixels of the first video track, MP4/MOV only (from its `tkhd`)
- An older app reads an unknown kind as `file` (`readInboxAttachmentKind`) and shows Download; `/download` works unchanged for it.
- An older Inbox sends `file` for the same film. The app plays it through `/download` with Range when the answer carries `Accept-Ranges: bytes` (an Inbox from 2026-10-15 on); otherwise it downloads the whole file first.
- Display rule for a time: `m:ss`, and `h:mm:ss` from one hour.

### 11.2 Range, the same on `video` and `download`

- Every answer carries `Accept-Ranges: bytes` and an `ETag`.
- One range (`Range: bytes=a-b`, `bytes=a-` or `bytes=-n`): `206 Partial Content` with `Content-Range: bytes a-b/size`. An end past the file is its last byte.
- **A `206` may cover less than the range asked for.** No answer carries more than 8 MiB: an open-ended range (`bytes=a-`) or one longer than 8 MiB is answered from its start for 8 MiB, and `Content-Range` says where it ended (RFC 9110 allows this). The client asks again from there. That is what players do (AVPlayer's resource loader and ExoPlayer read `Content-Range` and request the rest); an app that fills a loading request itself must loop until it has the bytes it needs. A full `200` (a `download` with no `Range`) is not capped.
- No range, a `Range` the Inbox does not read, or several ranges: the full `200`.
- An unsatisfiable range (a start at or past the end, `bytes=-0`, any range of an empty file): `416` with `Content-Range: bytes */size` and no body.
- `ETag`: the sent version's `"<sent_sha256>"`; the current file's `"<dev>-<ino>-<size>-<mtime µs>"` (strong, as nginx's stat tag is; `If-Range` compares strongly), from the stat of the descriptor the Inbox opened (never a hash per request: every seek is one). `If-Range` that is not exactly this version's ETag (or is a date) gets the full `200`: the file changed (the agent re-rendered it). Re-read `threads/:id/attachments` and start again.
- `Content-Length`: on every answer of 1 MiB or less (a player's `bytes=0-1` probe, and a range of up to 1 MiB). A longer answer is streamed and arrives chunked, without `Content-Length` (the Inbox's HTTP server drops it on a streamed body); its size is the length `Content-Range` names (`206`), or the attachment's `size` (`200`).
- Headers on every answer: `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin` and a sandbox CSP. `video`: `Content-Type` the sniffed `video/*` type, `Content-Disposition: inline`, `Cache-Control: private, no-cache`. `download`: `application/octet-stream` (`application/pdf` for a PDF), `Content-Disposition: attachment`, `Cache-Control: no-store`.
- The door forwards three request headers of the phone's to the window: `Range` and `If-Range` (on a GET) and `If-None-Match` (the image routes' validator, 7.38), besides the event stream's `Last-Event-ID`; nothing else. It returns the window's status and headers unchanged: `206`, `Content-Range`, `Accept-Ranges`, `Content-Length`, `ETag`.
- A streamed answer the app stops reading for 30 s is ended by the Inbox (its file handle closes) and the connection errors: a player that paused that long asks again from where it is, with a `Range`.
- The door is GET only, so there is no HEAD. AVPlayer's first probe (`bytes=0-1`) returns the size in `Content-Range`.

Suggested app shape: `AVURLAsset` on a custom scheme (`plannotator-video://<att id>?version=…`), with an `AVAssetResourceLoaderDelegate` that answers each `AVAssetResourceLoadingRequest` from the door with the app's pinned `URLSession` and bearer token. Set `contentInformationRequest.contentType` from `media_type` (or the `Content-Type` of `/video`), `contentLength` from the total in `Content-Range`, and `isByteRangeAccessSupported = true`. If an answer is a `200` (an older Inbox on `/download`), slice that body for the request, or fall back to the full download. ExoPlayer: a `DataSource` over the same requests.

### 11.3 A video by Range

```sh
curl -sS "$INBOX/api/inbox/device/attachments/att_01K70000000000000000000030/video" \
  -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-1' -D - -o /dev/null
```

```
HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Range: bytes 0-1/483393536
Content-Length: 2
Accept-Ranges: bytes
ETag: "1000004-2b1f0a-1cd0b000-6b0d1a2f4c5e0"
Content-Disposition: inline; filename="launch-cut-v3.mp4"; filename*=UTF-8''launch-cut-v3.mp4
Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: same-origin
Cache-Control: private, no-cache
```

A seek: `Range: bytes=104857600-` with `If-Range` set to that ETag gets `206` with the next 8 MiB (`Content-Range: bytes 104857600-113246207/483393536`), and the player asks again from `113246208`; a stale `If-Range` gets the full `200`; `Range: bytes=483393536-` gets `416` with `Content-Range: bytes */483393536`. Another kind: `415 { "code": "attachment_not_video" }`.

### 11.4 A download by Range

The same request to `attachments/:id/download` answers the same way, with the download's own type, disposition and `Cache-Control`. A native player can stream any file from it.

### 11.5 The relay

No relay changes in v1 (the owner's answer 3). A sealed command carries no headers, so no Range reaches the window through the relay: `video` and `download` answer the whole file, which the relay carries when it fits one frame and answers `413 result_too_large` otherwise, without reading it. Over the relay the app shows "Plays when your phone reaches this computer over Wi-Fi or Tailscale" with Download. Planned for v1.1: an optional `headers: { range, if_range }` in the sealed command and `headers: { content_range, accept_ranges, etag }` in the result; the app then fetches pieces of 8 MiB or less.

### 11.6 The comment record

The app saves comments with the existing `POST annotations` (7.17): `{ idempotency_key, attachment_id, version, annotation }`, `version` `"current"` or the sent sha256 as for other files. The annotation:

```json
{
  "id": "ann-vid-<uuid>",
  "blockId": "video",
  "startOffset": 0,
  "endOffset": 0,
  "type": "COMMENT",
  "text": "Logo is clipped on the right edge at this size.",
  "originalText": "launch-cut-v3.mp4 at 1:42",
  "createdA": 1760440000000,
  "inboxVideo": { "time": 102.4 },
  "images": [{ "path": "<data dir>/inbox/markups/<sha256>.jpg", "name": "launch-cut-v3 at 1:42" }]
}
```

- `inboxVideo.time` is seconds from the start, with millisecond precision. It is the only new field. On a video the Inbox requires `blockId: "video"` and a `time` of 0 or more (`422 validation_error` otherwise).
- `images` is optional. The Mac attaches the paused frame there (a JPEG kept through its markups route). The phone sends no `images` in v1, because the door has no upload route. When it shows a comment with an image, the phone loads it with `GET markups/<name>` (already on the allowlist).
- An older Inbox refuses a comment on a video (`422 annotation_not_allowed`), because there the kind reads `file`.
- Send: the surface's `export_feedback` builds the feedback text with Plannotator's exporter, as for every other kind; the app passes the video records as usual, and `texts` carries no entry for a video. The text lists a film's comments by time, each with a line `At 1:42 (102.4 s of 7:41)` under its heading and the frame's path. The surface needs no new message type, but the app must bundle a `surface.html` built after this shipped: an older surface reads `video` as `file` and leaves these comments out of the text.
