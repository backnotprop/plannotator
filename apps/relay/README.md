# Plannotator Inbox relay

A Cloudflare Worker with one Durable Object per mailbox. It carries pushes, and a paired phone's reads and answers, between a person's Inbox and their phones, and holds only what it cannot read: hashes, each phone's relay switch, its one push token (APNs or FCM), and envelopes sealed under keys made at pairing on the computer and the phone. The wire contract is `adr/implementation/inbox-mobile.md`, section 4, with section 10 for Android (FCM).

## Push

A device holds at most one push token: `PUT .../devices/:dev/apns` (iPhone) or `PUT .../devices/:dev/fcm` (Android), each clearing the other. `POST .../push` sends to whichever the device holds:

- APNs (`src/apns.ts`): HTTP/2 over a `connect()` TLS socket (`src/apns-h2.ts`), an ES256 provider token signed with the APNs key.
- FCM (`src/fcm.ts`): HTTP v1 `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send` with plain `fetch`, the body `{ "message": { "token", "data": { "e": "<envelope>" }, "android": { "priority": "high", "collapse_key": "<collapse_id>" } } }`. The OAuth access token is minted from the service account: a JWT signed RS256 with WebCrypto, exchanged at `oauth2.googleapis.com/token`, reused for 50 minutes. FCM's `UNREGISTERED` deletes the token (`fcm_gone`), as Apple's 410 does (`apns_gone`).

With neither token a push answers `no_push_token`. Pushes are not rate limited: a push needs the phone's push token, which only the app and the relay hold.

The overrides `APNS_ORIGIN`, `FCM_ORIGIN` and `FCM_OAUTH_ORIGIN` exist only for the proof and are honored only when they name a loopback host (`127.0.0.1`, `localhost`, `[::1]`); any other value is ignored, logged once, and the production host is used.

## Cloud agents

A paired cloud agent (contract section 13, "Through the relay") is a device registered with `kind: "agent"`: carriage off for good (`carriage`, `apns`, `fcm` and pushes answer `403 agent_device`), and only results are kept for it, never a record item. It posts sealed commands and reads its own results like a phone, and acknowledges one result at a time (`ack { item }`). Its signal, `GET /v1/mailboxes/:mbx/signals/<token>`, needs no login and answers only `{ signal }`, a random value the Inbox changes (`POST .../devices/:dev/signal`) when the person writes in one of that agent's threads; it is limited to 20 reads a minute per signal (`src/limits.ts`). Removing the device deletes its signal with everything else it held. Cloud agents need no Worker secret: a relay deployed without the Apple and Google keys carries them.

## What the relay sees, and its limits

- It sees ids, hashes of the bearers, each device's relay switch and push token, sizes and timing. Everything else is sealed under keys it never holds.
- Anything held, a down item, a result or a command, is deleted once it is 30 days old: an alarm on the mailbox, set for its oldest row (`src/limits.ts`; `HELD_MAX_AGE_SECONDS` may only shorten it, for the proof).
- A device may hold at most 50 commands or 64 MiB of them; past that a command answers `429 too_many_held`.
- The Worker refuses a request before it wakes a mailbox when its route is unknown, it has no bearer where one is needed, or its body is too large by `Content-Length` (64 KiB, or 32 MiB and a little for a command).
- On a device route, a device the mailbox does not hold answers `401` like a wrong secret, so nobody can probe which devices exist.
- Mailbox creation is braked at 20 a minute per client address (`CF-Connecting-IP`; an IPv6 address counts by its /64, so one host cannot rotate through its block), in two steps: Cloudflare's rate limiting binding first, a cheap filter whose counts are approximate and cached per machine (requests on separate connections pass it well over 20), then that address's `CreateBrake` Durable Object (`src/create-brake.ts`), one count in a fixed 60 s window wherever the request lands. Over either: `429 too_many_requests` with `Retry-After`. The object keeps one row (the window's start and count, never the address) and deletes it when the window ends.
- The Worker answers a plain-http request with a bare `403` and no body, on every route (the zone's redirect does not cover the `workers.dev` address); only `wrangler dev` on loopback is served over http, and the proof runs it with `--upstream-protocol https` because it rewrites the URL to the custom domain.
- The creation brake fails closed off loopback: with no rate-limit binding, no `CreateBrake` binding, no `CF-Connecting-IP`, or either failing, creation answers `503 brake_unavailable`.
- A cloud agent's signal address is a secret inside a URL. Anything that logs URLs (Cloudflare request logs, Logpush, a proxy on the agent's side) keeps it, and whoever holds it learns that something changed in that agent's threads, and when; nothing more. Leave URL logging off, or redact `/signals/`.
- The signal's limit of 20 reads a minute is counted in the mailbox object's memory, so it starts again whenever Cloudflare unloads the object. It is a brake, not a quota.
- Not done: mailbox ids that prove themselves (`mbx_` plus random bytes plus a short HMAC under a Worker secret, checked by the Worker before it wakes an object). Today any well-formed id wakes an object, which stores nothing for an id never made. Adding it means a new Worker secret, a longer id the pairing string and `relay.json` must accept, and keeping today's ids working until their Inboxes make new mailboxes.

## Deploy

The owner deploys the relay, never CI. `wrangler.toml` names the custom-domain route `relay.plannotator.ai`; that route and the Worker go live only when the owner runs, from this folder:

```sh
wrangler secret put APNS_KEY              # the .p8 file's text
wrangler secret put APNS_KEY_ID
wrangler secret put APNS_TEAM_ID
wrangler secret put FCM_SERVICE_ACCOUNT   # the Firebase service account's JSON key file, whole
wrangler deploy
```

`FCM_SERVICE_ACCOUNT` is the key file Google's console downloads for a service account of the Firebase project (it names `project_id`, `client_email`, `private_key_id` and `private_key`); the account needs permission to send through the Firebase Cloud Messaging API. Pipe the file in (`wrangler secret put FCM_SERVICE_ACCOUNT < key.json`) and keep it out of the repository.

`wrangler deploy` also applies the Durable Object migrations in `wrangler.toml` (`v1` the mailboxes, `v2` the `CreateBrake` counts). To check the brake after a deploy, send 21 or more creates with an invalid body (`-d '{}'`), one `curl` per request so each opens its own connection: the first 20 answer `400`, the rest `429` until the minute ends.

After a deploy, `./live-check.sh` (not part of CI) checks the live relay: its plain answers, https only, a wrong token gets 401 or 404, and the creation brake answers 429; it makes no mailbox and leaves no data. Run it at most once a minute: it spends that minute's creations from your address.

No workflow deploys it, and no workflow holds a Cloudflare, Apple or Google secret. Without `APNS_KEY` the relay runs and every push to an APNs token answers `no_apns_key`; without `FCM_SERVICE_ACCOUNT` every push to an FCM token answers `no_fcm_key`.

## The proof

`bun test` from this folder runs the relay under `wrangler dev` (`test/wrangler-relay.ts`; `test/cloud-agent.test.ts` is the cloud agent's proof, with a stand-in routine holding only its pairing string) (local only, persisted under `.wrangler/proof-*`) against a compiled Inbox when `PLANNOTATOR_INBOX_TEST_BINARY` names one, the CLI from source otherwise. Apple is a local HTTP/2 server; Google's two hosts are local servers the relay reaches through `FCM_ORIGIN` and `FCM_OAUTH_ORIGIN` (proof-only variables), with a service account whose RSA key is made for the run. `RELAY_PROOF_APPLE=1` adds the check against Apple's real hosts; `INBOX_PROOF_DIR` keeps the carriage's transcript and storage dumps. The relay workflow (`.github/workflows/relay.yml`) runs exactly this. The root `bun test` skips this folder.
