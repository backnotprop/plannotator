# Plannotator Inbox on a phone: the wire contract

Date: 2026-10-08. Step C1 of the mobile plan. The records it follows: the owner's thirteen mobile decisions (`.product/approved/plannotator-mobile-decisions-2026-10-07/approval.md`), the iPhone design of record (`.product/approved/plannotator-mobile-iphone-2026-10-07/`, renders 1.1 to 9.2) and the build plan (`research/plans/plannotator-mobile-2026-10-07/PLAN.md`), all in the Workspaces meta repo.

This document is the contract the iPhone app, the Inbox's device door, the LAN listener, the relay Worker and the surface bridge build against: P1, P2, S1, R1, R2 and M1 to M6. Names below are final. A later change edits this file first. A bare number such as 1.3 or 4.3 names a render of the iPhone record; "exchange 7.x" and the Exchange columns name section 7.

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

An offer is single use. It closes when it is redeemed, when it expires, after 5 wrong codes, or when the window makes a new one: one offer is open at a time, so six digits always name one offer. The offer lives in the server's memory only; a restart closes it.

Pairing needs the phone to reach the computer once, over the same Wi-Fi or the tailnet; the relay does not carry a redemption in v1. With both addresses null the offer still answers (a simulator reaches the Inbox on `127.0.0.1`), and "Pair a phone" offers the "Reach from this Wi-Fi" switch in place.

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

The phone reads a link with an unknown `v` as "update the app". Both addresses are tried in order (LAN, then tailnet) for the redemption. The relay's address and mailbox arrive in the redemption's answer, not in the link.

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
5. A POST in the allowlist carries `idempotency_key` in its body (section 6), else `422 validation_error`. The two exceptions are `pair` and `revoke`, which change nothing when repeated.
6. The request is handed to the window's own handler under the window's path. The door adds nothing and strips nothing; the phone sends no `serverSession`, which the window's guard accepts (`checkServerSession`: absent passes).

Where the door answers. On the loopback listener, the door sits beside the window. The tailnet reaches a second loopback listener, open only while "Reach from my tailnet" is on, that serves the door and nothing else: any path outside `/api/inbox/device/` answers `404 device_route_not_found` there, whatever its Host. `tailscale serve` points at that listener, never at the window's port. On the LAN listener only the door exists (section 3).

Corrected in P1 (plannotator-ops's review of PR 1776): the first draft kept tailnet requests on the door by their Host header, on the assumption that "through `tailscale serve` the Host is the MagicDNS name". It is the client's own Host: `tailscale serve` passes it through (`r.Out.Host = r.In.Host`), so a tailnet peer sending `Host: localhost` passed the loopback allowlist and reached the window's routes (the pairing offer, `/mcp`, settings, restart). The separation now comes from the socket, as the LAN listener's does, and no Host is read for it.

The allowlist. Each row is the window's handler as it is today, with the request and answer the window uses (`CLAUDE.md`, "Inbox Server"). Exchange numbers point at section 7.

| Door route | Window route | Request | Answer | Exchange |
|---|---|---|---|---|
| `GET health` | `GET /api/inbox/health` | | `{ ok, app, version, serverSession, pid, update }`; the cheapest read, the phone's reachability probe for 9.2 | 7.4 |
| `GET threads[?project=prj_...]` | `GET /api/inbox/threads` | | the list model: `{ serverSession, version, cursor, update, notice, projects, project, sections, decisions_waiting }` | 7.5 |
| `GET projects` | `GET /api/inbox/projects` | | `{ serverSession, cursor, projects: [{ id, key, name, root, created_at, threads, unread }] }` | 7.6 |
| `GET threads/:id` | `GET /api/inbox/threads/:id` | | `{ serverSession, cursor, thread, decisions }` | 7.7 |
| `POST threads/:id/seen` | same | `{ idempotency_key }` | `{ thread: row }` | 7.8 |
| `GET events[?cursor=n]` | `GET /api/inbox/events` | `Last-Event-ID` or `?cursor=` | SSE: `hello`, `record` per store line (`id:` = seq), `status`, a heartbeat every 15 s | 7.9 |
| `POST messages/:id/picks` | same | `{ idempotency_key, questions: [{ key, revision, answer or null }] }` | `{ message_id, questions, reply: null }` | 7.10 |
| `POST messages/:id/reply` | same | `{ idempotency_key, words?, questions?, feedback?, annotation_ids? }` | `{ message_id, questions, reply, replayed, decisions, decisions_refused }` | 7.11 |
| `POST messages/:id/resolve` | same | `{ idempotency_key, resolved? }` | `{ thread: summary }` | 7.12 |
| `POST threads/:id/delete` | same | `{ idempotency_key }` | `{ ok, store }` | 7.13 |
| `GET threads/:id/attachments` | same | | `{ serverSession, attachments: [state], annotations }` | 7.14 |
| `GET attachments/:id/view[?version=sent]` | same | | `{ serverSession, attachment, version, text, html }`; also Share (the "..." menu of section 4 of the record), which writes `text` to a file named `attachment.name` | 7.15 |
| `GET html-assets/<token>/<path>` | `GET /api/html-assets/<token>/<path>` | | the asset's bytes, as annotate serves them | 7.16 |
| `POST annotations` | same | `{ idempotency_key, attachment_id, version, annotation }` | `{ annotation }` | 7.17 |
| `POST annotations/:id/remove` | same | `{ idempotency_key }` | `{ annotation }` | 7.18 |
| `GET messages/:id/guide` | same | | `{ message_id, guide, snapshot }` | 7.19 |
| `POST messages/:id/guide/reviewed` | same | `{ idempotency_key, reviewed: boolean[] }` | `{ message_id, reviewed }` | 7.20 |
| `POST messages/:id/decision` | same | `{ idempotency_key, key, recording?, draft? }` | `{ question }` | 7.21 |
| `GET decisions?project=prj_...` | same | | `{ serverSession, cursor, project_id, waiting, decisions }` | 7.22 |
| `GET threads/:id/sessions` | same | | `{ serverSession, home, project, sessions }` | 7.23 |
| `POST threads/:id/message` | same | `{ idempotency_key, session, body }` | `{ message, replayed }` | 7.24 |
| `POST revoke` | (the door's own) | `{}` | `{ device }` | 7.25 |
| `POST pair` | (the door's own) | `{ secret or code, name, platform }` | see above | 7.2, 7.3 |

Door routes are written relative to `/api/inbox/device/`; window routes keep their full paths.

What the door never answers, by construction (none is in the allowlist, and the tailnet's listener serves nothing else): `/`, `/favicon.png`, `/mcp`, `/api/inbox/bridge/*`, `/api/inbox/control/*`, `/api/inbox/attachments/:id` (raw bytes; every attachment kind is text and `view` carries it), `/api/inbox/settings`, `/api/inbox/restart`, `/api/inbox/projects/:id/delete`, `/api/inbox/decisions/:id/retire` and `replace`, `/api/inbox/pairing`, `/api/inbox/devices*`, `/api/inbox/tailnet`, `/api/inbox/lan`. The computer chores stay on the computer (decision 5). The bridge and control routes keep their own guards and refuse a device token like any other wrong token (`401 unauthorized`).

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

## 3. The LAN listener

Off until "Reach from this Wi-Fi" is switched on in the window's Settings (P2).

- **What it serves:** the door, and only the door: the same door-only handler as the tailnet's listener (section 2). Anything outside `/api/inbox/device/` answers `404 device_route_not_found`, whatever its Host, Origin or encoding. It skips the Host allowlist: it serves only a bearer door that refuses any Origin, and a browser cannot present the token.
- **Where:** all interfaces (`0.0.0.0`), on a port chosen free the first time and kept in `inbox.json` as `lan: { port }`, so the address a phone holds survives a restart. All interfaces rather than the LAN addresses one by one, so a new DHCP address is served without a restart and the Bonjour record keeps pointing at a live port; every interface reaches the same door and nothing else.
- **The address in the link (`lan`):** `ip:port`, where the ip is the first IPv4 address of an interface that is up, not loopback, not link-local (169.254/16) and not Tailscale's (100.64/10), private ranges first. It is read when the offer is made, so it follows the computer to a new network. With no such address the listener keeps running, `lan` is null, and the window says the computer is not on a network.
- **TLS:** an ECDSA P-256 certificate, self-signed, subject `CN=Plannotator Inbox`, valid for 100 years (the phone reads no dates), made by `openssl` as child processes the first time the listener starts (`openssl ecparam -name prime256v1 -genkey -noout`, then `openssl req -new -x509 -days 36500 -subj "/CN=Plannotator Inbox"`, two steps, which macOS's LibreSSL 3.3 and OpenSSL 3 both accept) and kept in `inbox/tls/cert.pem` and `inbox/tls/key.pem` (files 0600, directory 0700; LibreSSL writes the files 0644, so they are made inside the 0700 directory and set to 0600 after). It is never rotated. Deleting `inbox/tls/` makes a new one, and every phone paired over the Wi-Fi pairs again. With `openssl` missing or failing, the switch answers `409 lan_unavailable` and stays off.
- **The fingerprint:** SHA-256 of the certificate's DER bytes, 64 lowercase hex. It rides the link as `fp` and the Bonjour record as `fp`.
- **What the phone checks:** the leaf certificate's SHA-256 equals the fingerprint it holds. Nothing else: no host name, no chain, no dates. The pin is the check.
- **Bonjour:** while the listener is on, the Inbox advertises `_plannotator-inbox._tcp` through a child process (`dns-sd -R` on macOS, `avahi-publish -s` on Linux; no dependency; where neither exists the listener still works by typed address and the window says so) with the instance name `computer.name`, the listener's port, and TXT `v=1` and `fp=<fingerprint>`. The phone lists these in 1.3 and matches a found record to a paired computer by `fp`, so a new IP address is followed without pairing again. A phone that pairs by typed digits after picking a record pins the record's `fp`. The publisher runs under `sh`, which ends it when its stdin closes: the Inbox closes it on a clean stop, and the kernel closes it when the Inbox dies without one (kill -9), so no record outlives the Inbox.
- **Off and stops:** switching off closes the listener, ends the publisher and clears `lan` from `inbox.json`; the certificate stays, so switching on again keeps every phone's pin. A clean stop (quit, the stop route, a restart to update, before the new run starts) closes the listener and the publisher and leaves the switch on; the next start opens the same port again with the same certificate.

The switch's window routes (added in P2; the first draft named the switch but no route), beside the tailnet's:

- `GET /api/inbox/lan`: `{ lan: { on, address, fingerprint, bonjour, error } }`. `on` is the person's switch as `inbox.json` keeps it; `address` is the link's `ip:port`, null while the listener is closed or the computer has no network address; `fingerprint` is the certificate's SHA-256 while the listener runs; `bonjour` is true while the record is published (false where neither `dns-sd` nor `avahi-publish` exists: the phone types the address); `error` says why the listener is not working, in the window's words.
- `POST /api/inbox/lan` (window guards) `{ serverSession?, on }`: `{ lan }`. Turning it on makes the certificate if there is none, opens the listener and publishes the record at once; `409 lan_unavailable` when the certificate cannot be made, and the switch stays off. Turning it off closes both and clears `lan` from `inbox.json`.

## 4. The relay

A Cloudflare Worker in `apps/relay/` with one Durable Object per mailbox, on the model of `apps/guides-show/worker`: it holds what it cannot read. The origin is `https://relay.plannotator.ai` (owner item 20, recommended); `PLANNOTATOR_RELAY_URL` points the Inbox at `wrangler dev` in a proof.

### Keys

All made on the computer and the phone at pairing; none ever reaches the relay.

- **The pairing secret** `S`: the offer's 32 bytes, held by the phone (Keychain, this device only, shared with the notification extension's group) and by the computer (`inbox/device-secrets/<dev id>`).
- **The device key** `K = HKDF-SHA256(ikm = S, salt = UTF-8 bytes of the device id, info = "plannotator-inbox relay key v1", length = 32)`: the AES-256-GCM key of every envelope between this Inbox and this phone.
- **The relay secret** `R = HKDF-SHA256(ikm = S, salt = UTF-8 bytes of the device id, info = "plannotator-inbox relay auth v1", length = 32)`, base64url: the phone's bearer at the relay. The relay stores only `SHA-256(R)` as hex.
- **The mailbox secret** `M`: 32 random bytes, base64url, made by the Inbox with the mailbox and kept in `inbox/relay.json` (0600) as `{ v: 1, url, mailbox_id, secret }`. The Inbox's bearer at the relay. The relay stores only `SHA-256(M)` as hex.

Web Crypto (`deriveBits` with `HKDF`) and CryptoKit (`HKDF<SHA256>.deriveKey`) both compute these. R1 commits test vectors made from all-zero inputs, and the proof has Swift and TypeScript open each other's envelopes.

### The envelope

Exactly the format `packages/core/crypto.ts` writes: `base64url(IV || ciphertext || tag)`, a fresh random 12-byte IV per envelope, AES-256-GCM with a 16-byte tag, no additional data, base64url without padding. The plaintext is UTF-8 JSON. R1 adds `encryptWithKey(plaintext, key)` and `decryptWithKey(envelope, key)` to `packages/core/crypto.ts` beside the existing pair, with the same byte layout.

### What the relay stores and deletes

- **Per mailbox:** `secret_sha256`.
- **Per device:** `secret_sha256`, `carriage` (the phone's relay switch), the APNs token and its environment (plain: Apple needs it), `cursor` (the highest store seq the Inbox has posted for it, a number), the next item number `n`, the down items `{ n, cursor, ciphertext }`, the up commands `{ id, ciphertext }`.
- **Never:** a key, a secret, a subject, a body. Logs carry ids and status codes only.
- **Deleted:** a down item when the phone acknowledges it (by item number, or by store cursor when it read those lines directly); every down item when the phone turns carriage off; an up command when the Inbox reports it applied; a device and everything it holds when the Inbox removes it (a revoke); an APNs token when Apple answers 410. There is no time sweep.

### Routes

Every route answers JSON. Errors are `{ error, code }`: `400 bad_request`, `401 unauthorized` (a bearer whose SHA-256 does not match), `404 mailbox_not_found`, `404 device_not_found`, and `429 too_many_requests` with `Retry-After` from the creation brake. `POST /v1/mailboxes` goes through the same Cloudflare rate limiting rule guides.show puts on `POST /api/g` (the `[[ratelimits]]` block of `apps/guides-show/wrangler.toml`, keyed on `CF-Connecting-IP`, failing open where it cannot resolve); the relay adds no number of its own, and no other route is braked. "Inbox bearer" is `Authorization: Bearer <M>`; "device bearer" is `Authorization: Bearer <R>` of the device in the path.

| Route | Who | Request | Answer | Exchange |
|---|---|---|---|---|
| `POST /v1/mailboxes` | the Inbox, at its first pairing | `{ secret_sha256 }` | `201 { mailbox_id }`; `mbx_` plus 16 random bytes as base64url | 7.26 |
| `PUT /v1/mailboxes/:mbx/devices/:dev` | Inbox bearer | `{ secret_sha256, cursor }`: `SHA-256(R)` and the store cursor at pairing (the phone read everything before it directly) | `200 { device_id }`; repeating it with the same hash is a no-op | 7.27 |
| `DELETE /v1/mailboxes/:mbx/devices/:dev` | Inbox bearer | | `204`; the device's revoke on the computer | 7.28 |
| `PUT /v1/mailboxes/:mbx/devices/:dev/carriage` | device bearer | `{ on: false }`, or `{ on: true, cursor }` with the store cursor the phone holds | `204`; the device stays registered either way, and the Inbox's socket gets a `carriage` frame | 7.35 |
| `PUT /v1/mailboxes/:mbx/devices/:dev/apns` | device bearer | `{ token, environment: "sandbox" or "production" }`; `token: null` removes it | `204` | 7.29 |
| `POST /v1/mailboxes/:mbx/push` | Inbox bearer | `{ device_id, collapse_id, ciphertext }` | `202 { sent: true }`, or `200 { sent: false, reason: "no_apns_token" or "apns_gone" }` | 7.30 |
| `GET /v1/mailboxes/:mbx/socket` | Inbox bearer, WebSocket upgrade | frames below | | 7.31 |
| `GET /v1/mailboxes/:mbx/devices/:dev/items?after=n` | device bearer | | `{ items: [{ n, ciphertext }], inbox_online }`, every held item after `n` in order | 7.32 |
| `POST /v1/mailboxes/:mbx/devices/:dev/ack` | device bearer | `{ through: n }`, or `{ cursor }` when the phone read the store directly up to that seq | `204`; deletes items up to `n`, or record items whose cursor is at or below `cursor` | 7.33 |
| `POST /v1/mailboxes/:mbx/devices/:dev/commands` | device bearer | `{ id, ciphertext }` | `202 { queued: true, inbox_online }`; an `id` it already holds answers `200 { queued: false, inbox_online }` | 7.34 |

`inbox_online` says whether the Inbox's socket is connected now: the phone's "Sent. Waiting for your computer" (owner item 26).

### The Inbox's socket

The Inbox holds one outbound WebSocket to its mailbox while the mailbox has a device, and reconnects when it drops. Frames are JSON text.

Relay to Inbox:

- `{ "type": "hello", "devices": [{ "device_id", "cursor", "carriage": boolean, "apns": boolean }] }` on connect. The Inbox writes each listed device's `carriage` into its device record, removes any listed device it revoked, and registers only the non-revoked devices with `carriage: true` that the relay does not list. A device whose phone turned carriage off stays listed, so a reconnect never registers it again.
- `{ "type": "command", "device_id", "id", "ciphertext" }`: each held up command, in order, until it is applied.
- `{ "type": "carriage", "device_id", "on", "cursor" }`: the phone flipped its relay switch (9.2). The Inbox writes `carriage` into the device record. Off: it sends that device no items and no pushes. On: it resumes items after `cursor`.

Inbox to relay:

- `{ "type": "item", "device_id", "cursor", "ciphertext" }`: one down item, sent only to a device with carriage on. `cursor` is the record's store seq, or null for a result; the relay keeps the highest so the Inbox resumes from `hello`.
- `{ "type": "applied", "device_id", "id" }`: the command was applied (or refused); the relay deletes it.

### What goes down and up

Down item plaintexts:

- `{ "v": 1, "type": "record", "seq", "kind", "id", "<kind>": record }`: one store line, exactly the `record` event of the event stream (`eventPayload` in `packages/server/inbox.ts`) with `v` and `type` added. After a device's `cursor`, every line goes down, in seq order. A phone reading over the Wi-Fi or the tailnet acknowledges by store cursor (`ack { cursor }`), so its queue holds only what it missed.
- `{ "v": 1, "type": "result", "id", "status", "content_type", "body_b64" }`: the door's answer to an up command, its bytes as base64.

Up command plaintext: `{ "v": 1, "id", "method", "path", "body" }`, where `path` is a door path (`/api/inbox/device/...`) and `body` is the JSON body the phone would have sent directly. The Inbox applies it through the door as that device, so the allowlist, the revocation check and the idempotency rule are the same on every path. A GET through the relay (the list after a long absence, an attachment's view, an HTML asset) is a command whose `id` is a fresh random id; a POST's `id` is its `idempotency_key` (section 6).

### Push

The Inbox posts one push per paired device with carriage on, after an agent's message lands with a question or a guided review (`send_message` or `submit_guide`, where `packages/inbox/notify.ts` would raise a browser notification for the question). One message is one push however many questions it carries.

The push plaintext, encrypted under the device key:

```json
{
  "v": 1,
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

- `agent` is `inboxAgentName(author)`, `project` the project's name.
- `question` is present only when the message has exactly one question, it is single-choice, and it has at most four choices (Apple shows at most four actions). Otherwise it is null, and the notification opens the thread (render 7.2).
- `collapse_id` is the thread id, so a thread's newer push replaces its older one.
- Apple's payload ceiling is 4096 bytes. When the APNs body would pass it, the Inbox drops `question.context`, then `question`, then sends `{ v, thread_id, message_id }` alone.

What the relay sends to APNs, with `apns-push-type: alert`, `apns-priority: 10`, `apns-topic: ai.plannotator.app` and `apns-collapse-id: <collapse_id>`:

```json
{ "aps": { "alert": { "title": "Plannotator", "body": "New in your Inbox" }, "mutable-content": 1, "sound": "default" }, "e": "<envelope>" }
```

The cleartext alert shows only if the notification service extension cannot run. The extension decrypts `e` with the device key and sets the title to `subject` and the body to `<agent> in <project>`, followed by `: <context>` when the question carries one (render 7.1). With a question it registers a category for that notification whose actions are the choices, recommended first, identifiers `choice.0` to `choice.3`, each `authenticationRequired` (render 7.2). A tapped choice is one Send (section 6, exchange 7.11).

## 5. The surface bridge

`packages/core/inbox-surface-bridge.ts` exports the message types and `INBOX_SURFACE_BRIDGE_VERSION = 1`. The surface is S1's single-file build, loaded by the app's `WKWebView` from the app scheme `plannotator-surface://app/surface.html`. It has no network access; the shell fetches every byte through the door and hands it over.

- **Shell to surface:** `window.plannotatorSurface.receive(message)`, called by the shell.
- **Surface to shell:** `window.webkit.messageHandlers.plannotatorSurface.postMessage(message)`. The shell takes messages from the main frame only, so an agent's HTML, drawn in its sandboxed frame, cannot reach the bridge.
- **Every message** is `{ v: 1, type, ... }`. A surface given another `v` answers `error` with `code: "bridge_version"`.
- **The asset scheme:** `plannotator-asset://inbox/api/html-assets/<token>/<path>` is served by the shell from the door's `GET html-assets/<token>/<path>` (directly, or as a relay command). Before it opens an HTML attachment, the shell rewrites the page's `<base href>` from the window's root-relative `/api/html-assets/<token>/` to `plannotator-asset://inbox/api/html-assets/<token>/`. The page's root-relative asset paths then resolve on that scheme too, and the token never reaches web content.

Annotations are Plannotator's `Annotation` (`packages/ui/types.ts`) inside the Inbox's `InboxAnnotationRecord` (`packages/core/inbox-attachments.ts`), and attachments are `InboxAttachmentState`, as the door answers them.

### Shell to surface

| Type | Fields | When |
|---|---|---|
| `open_attachment` | `attachment: InboxAttachmentState`, `version` (`"current"` or the sent sha256), `text`, `html` (string with the rewritten base, or null), `annotations: InboxAnnotationRecord[]` (this file and version, waiting for a Send), `focus` (an annotation id to scroll to, or null) | the person opens a file (3.6, 4.1 to 4.4) |
| `open_guide` | `message_id`, `guide: InboxGuideRef`, `snapshot`, `reviewed: boolean[] or null` | a guided review opens (6.1, 6.2) |
| `set_mode` | `mode: "annotate" or "interact"` | the switch of 4.3 |
| `step_pin` | `direction: "parent" or "child"` | Parent or Child in 4.3 |
| `set_appearance` | `theme: "light" or "dark"`, `text_scale` (the Dynamic Type size as a multiple of the default, from `UIFontMetrics`) | at open and on every change |
| `commit_annotation` | `annotation: InboxAnnotationRecord` | the door saved it; the surface draws it as saved |
| `remove_annotation` | `id` | removed, or a draft cancelled (4.4 Cancel) |

### Surface to shell

| Type | Fields | When |
|---|---|---|
| `ready` | `bridge: 1`, `build` | the bundle loaded; the shell sends nothing before it |
| `selection` | `quote` (string or null), `draft` (`Annotation` or null) | a text selection settled or cleared; Comment in the edit menu uses `draft` (4.1, 4.2) |
| `pin` | `target: { label, selector }`, `draft: Annotation` | an HTML pin landed, or Parent or Child moved it (4.3) |
| `draft` | `target: { kind: "block" or "node" or "edge", label }`, `draft: Annotation` | a tap on a block (pinpoint) or a diagram part: open the composer now (4.4) |
| `annotation` | `id` | a saved mark was tapped: the shell shows it with Edit and Remove (4.3) |
| `reviewed` | `message_id`, `reviewed: boolean[]` | a section's Reviewed tick (6.2) |
| `link` | `href` | a link in the content; the shell opens it in the system browser |
| `error` | `code`, `message` | the surface could not draw what it was given |

A draft is an `Annotation` with an empty `text`. The shell fills the person's words into `text`, saves `{ attachment_id, version, annotation }` through the door (7.17), and answers with `commit_annotation`. Edit (4.3) is the same save with the same annotation id and a new key. HTML-asset tokens live in the Inbox's memory, so after the Inbox restarts an asset answers 404; the shell then fetches `view` again.

## 6. Idempotency

Every command a phone sends carries one key: `idempotency_key` in the request body, the field the window's Send and New message already take. The phone mints a random UUID per intent (one pick tap, one Send, one tick) and keeps it until it has a definite answer (any 2xx or 4xx), across retries, path changes and app restarts.

| Command | Door route | Key |
|---|---|---|
| Pick | `POST messages/:id/picks` | body `idempotency_key` |
| Send | `POST messages/:id/reply` | body `idempotency_key` (also the store's own key) |
| Seen | `POST threads/:id/seen` | body `idempotency_key` |
| Resolve | `POST messages/:id/resolve` | body `idempotency_key` |
| Delete | `POST threads/:id/delete` | body `idempotency_key` |
| Annotation save, remove | `POST annotations`, `POST annotations/:id/remove` | body `idempotency_key` |
| Tick | `POST messages/:id/guide/reviewed` | body `idempotency_key` |
| Decision switch | `POST messages/:id/decision` | body `idempotency_key` |
| New message | `POST threads/:id/message` | body `idempotency_key` (also the store's own key) |

- **The door** keeps `inbox/device-commands.jsonl`, one line per applied command: `{ v: 1, at, device_id, key, method, path, status, body }`, with the answer's status and JSON body. It is read at start. A key seen before for that device on the same method and path answers the recorded status and body, adds `Idempotent-Replayed: true`, and writes nothing. That header is the replay signal: a replayed Send answers its recorded body, whose `replayed` field reads as it did the first time. The log keeps every answer body, reply bodies included, for as long as the store lives. The same key on another route is `409 idempotency_key_reused`. A 5xx is not recorded, so a retry runs again.
- **The relay path** carries the key as the up command's `id`. The relay holds one command per `id`, and the Inbox applies it through the door, so a command posted twice, or re-sent after the Inbox applied it but before the relay heard, writes once.
- **The lock-screen answer** is one Send with the pick inside it (7.11): `{ idempotency_key, questions: [{ key, revision, answer: { v: 1, key, kind: "single", prompt, selected: [label] } }] }`. It tries the direct path first, then the relay, with the same key.

## 7. The exchanges

P1 replays 7.1 to 7.25, 7.36 and 7.37 against a compiled binary; P2 replays 7.2 over the LAN; R1 and R2 replay 7.26 to 7.35 against `wrangler dev`. Fixture values are placeholders, never secrets: `AAAA...` stands for a 32-byte value, `tok_exampleaaaa...` for a token, repeated hex for a hash.

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

`401 { "error": "That code is not the one on your computer.", "code": "pairing_code_wrong", "tries_left": 4 }`. With `"code":"482913"` the answer is 7.2's.

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
  ],
  "decisions_waiting": 0
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
            "recommendation": "Yes", "suggested_text": null, "decision_on_answer": false,
            "stopped": null, "holds_up": [], "asked_by_agent_id": null, "orphaned": false,
            "state": "open", "answer": null, "revision": 0, "sent_revision": 0,
            "picked_by": null, "picked_at": null, "sent_reply_id": null, "decision_id": null,
            "message_id": "msg_01K70000000000000000000010",
            "decision_recording": false, "decision_draft": null
          }
        ]
      }
    ]
  },
  "decisions": []
}
```

### 7.8 Seen

```sh
curl -sS -X POST "$INBOX/api/inbox/device/threads/msg_01K70000000000000000000010/seen" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000001"}'
```

`{ "thread": <the row of 7.5, now "unseen": 0> }`. Without the key: `422 { "error": "idempotency_key: required on a phone's command.", "code": "validation_error", "field": "idempotency_key" }`.

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
  "replayed": false,
  "decisions": [],
  "decisions_refused": []
}
```

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
  "annotations": []
}
```

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

### 7.21 The decision switch

```sh
curl -sS -X POST "$INBOX/api/inbox/device/messages/msg_01K70000000000000000000010/decision" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"00000000-0000-4000-8000-000000000009","key":"q-1a2b3c4d","recording":true,"draft":{"text":"Run the retry tests against the test clock before each release.","reason":null}}'
```

`{ "question": <7.7's question with "decision_recording": true, "decision_draft": { "text": "Run the retry tests against the test clock before each release.", "reason": null }> }`. After the answer was sent: `409 question_already_sent`.

### 7.22 A project's decisions

```sh
curl -sS "$INBOX/api/inbox/device/decisions?project=prj_01K70000000000000000000002" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "serverSession": "00000000000000000000000000000001",
  "cursor": 1301,
  "project_id": "prj_01K70000000000000000000002",
  "waiting": [],
  "decisions": [
    {
      "id": "dec_01K70000000000000000000030",
      "project_id": "prj_01K70000000000000000000002",
      "text": "Run the retry tests against the test clock before each release.",
      "reason": "Asked by Claude Code: Run the retry tests against the Stripe test clock?",
      "source": { "kind": "answer", "question_id": "msg_01K70000000000000000000010/q-1a2b3c4d", "message_id": "msg_01K70000000000000000000010", "thread_id": "msg_01K70000000000000000000010", "agent": { "host": "claude-code", "session": "ses_01K70000000000000000000003", "name": null } },
      "state": "current",
      "version": 1,
      "replaces_id": null,
      "replacement_id": null,
      "created_at": "2026-10-08T10:52:00.000Z",
      "changed_at": null,
      "idempotency_key": null
    }
  ]
}
```

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
  -d '{"device_id":"dev_01K70000000000000000000001","collapse_id":"msg_01K70000000000000000000010","ciphertext":"AAAAAAAAAAAAAAAAexampleciphertextexample"}'
```

`202 { "sent": true }`. With no APNs token registered: `200 { "sent": false, "reason": "no_apns_token" }`.

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

The command's plaintext is `{"v":1,"id":"00000000-0000-4000-8000-000000000003","method":"POST","path":"/api/inbox/device/messages/msg_01K70000000000000000000010/reply","body":{"idempotency_key":"00000000-0000-4000-8000-000000000003","words":"Go ahead.","questions":[{"key":"q-1a2b3c4d","revision":1}]}}`; the result item's plaintext is `{"v":1,"type":"result","id":"00000000-0000-4000-8000-000000000003","status":200,"content_type":"application/json; charset=utf-8","body_b64":"<7.11's answer as base64>"}`.

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

## 8. What this contract leaves out

The Workspaces source (W0 to W2 have their own contract), FCM and Android, the iPad, pairing through the relay, deleting a mailbox, a retention sweep at the relay, rates beyond the reused creation brake, raw attachment bytes on the door, device attestation, request signing, re-authentication, and any Settings, restart or storage route on the phone.

## 9. Rulings written in (2026-10-08)

The coordinator ruled the eight questions the first draft left open; each is now part of the sections above.

1. Pairing through the relay is not in v1. With neither path on, "Pair a phone" offers the Wi-Fi switch (section 1).
2. The QR link carries no `mailbox`; the redemption's answer carries the relay (section 1).
3. The phone's relay switch is `PUT .../devices/:dev/carriage`. Its state lives in the device record, and a reconnect registers only devices with carriage on (sections 2 and 4).
4. Pushes go out for questions and guided reviews only (section 4, Push).
5. The relay has no time sweep. A phone reading directly acknowledges by store cursor (section 4).
6. Mailbox creation reuses guides.show's per-IP brake, with no new number (section 4, Routes).
7. The certificate and the Bonjour record come from `openssl` and `dns-sd` (`avahi-publish` on Linux) as child processes, with no dependency (section 3).
8. The tailnet HTTPS port is 8443, kept in `inbox.json`. A mapping held by something else is reported, never overwritten (section 1).
