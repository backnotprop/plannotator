# Plannotator Inbox relay

A Cloudflare Worker with one Durable Object per mailbox. It carries pushes, and a paired phone's reads and answers, between a person's Inbox and their phones, and holds only what it cannot read: hashes, each phone's relay switch, its one push token (APNs or FCM), and envelopes sealed under keys made at pairing on the computer and the phone. The wire contract is `adr/implementation/inbox-mobile.md`, section 4, with section 10 for Android (FCM).

## Push

A device holds at most one push token: `PUT .../devices/:dev/apns` (iPhone) or `PUT .../devices/:dev/fcm` (Android), each clearing the other. `POST .../push` sends to whichever the device holds:

- APNs (`src/apns.ts`): HTTP/2 over a `connect()` TLS socket (`src/apns-h2.ts`), an ES256 provider token signed with the APNs key.
- FCM (`src/fcm.ts`): HTTP v1 `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send` with plain `fetch`, the body `{ "message": { "token", "data": { "e": "<envelope>" }, "android": { "priority": "high", "collapse_key": "<collapse_id>" } } }`. The OAuth access token is minted from the service account: a JWT signed RS256 with WebCrypto, exchanged at `oauth2.googleapis.com/token`, reused for 50 minutes. FCM's `UNREGISTERED` deletes the token (`fcm_gone`), as Apple's 410 does (`apns_gone`).

With neither token a push answers `no_push_token`.

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

`bun test` from this folder runs the relay under `wrangler dev` (local only, persisted under `.wrangler/proof-*`) against a compiled Inbox when `PLANNOTATOR_INBOX_TEST_BINARY` names one, the CLI from source otherwise. Apple is a local HTTP/2 server; Google's two hosts are local servers the relay reaches through `FCM_ORIGIN` and `FCM_OAUTH_ORIGIN` (proof-only variables), with a service account whose RSA key is made for the run. `RELAY_PROOF_APPLE=1` adds the check against Apple's real hosts; `INBOX_PROOF_DIR` keeps the carriage's transcript and storage dumps. The relay workflow (`.github/workflows/relay.yml`) runs exactly this. The root `bun test` skips this folder.
