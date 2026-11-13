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
- The creation brake fails closed off loopback: with no rate-limit binding, no `CF-Connecting-IP` or a failing limiter, creation answers `503 brake_unavailable`.
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

No workflow deploys it, and no workflow holds a Cloudflare, Apple or Google secret. Without `APNS_KEY` the relay runs and every push to an APNs token answers `no_apns_key`; without `FCM_SERVICE_ACCOUNT` every push to an FCM token answers `no_fcm_key`.

## The proof

`bun test` from this folder runs the relay under `wrangler dev` (`test/wrangler-relay.ts`; `test/cloud-agent.test.ts` is the cloud agent's proof, with a stand-in routine holding only its pairing string) (local only, persisted under `.wrangler/proof-*`) against a compiled Inbox when `PLANNOTATOR_INBOX_TEST_BINARY` names one, the CLI from source otherwise. Apple is a local HTTP/2 server; Google's two hosts are local servers the relay reaches through `FCM_ORIGIN` and `FCM_OAUTH_ORIGIN` (proof-only variables), with a service account whose RSA key is made for the run. `RELAY_PROOF_APPLE=1` adds the check against Apple's real hosts; `INBOX_PROOF_DIR` keeps the carriage's transcript and storage dumps. The relay workflow (`.github/workflows/relay.yml`) runs exactly this. The root `bun test` skips this folder.
