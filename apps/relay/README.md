# Plannotator Inbox relay

A Cloudflare Worker with one Durable Object per mailbox. It carries pushes, and a paired phone's reads and answers, between a person's Inbox and their phones, and holds only what it cannot read: hashes, each phone's relay switch, its APNs token, and envelopes sealed under keys made at pairing on the computer and the phone. The wire contract is `adr/implementation/inbox-mobile.md`, section 4.

## Deploy

The owner deploys the relay, never CI. `wrangler.toml` names the custom-domain route `relay.plannotator.ai`; that route and the Worker go live only when the owner runs, from this folder:

```sh
wrangler secret put APNS_KEY      # the .p8 file's text
wrangler secret put APNS_KEY_ID
wrangler secret put APNS_TEAM_ID
wrangler deploy
```

No workflow deploys it, and no workflow holds a Cloudflare or Apple secret. Without `APNS_KEY` the relay runs and every push answers `no_apns_key`.

## The proof

`bun test` from this folder runs the relay under `wrangler dev` (local only, persisted under `.wrangler/proof-*`) against a compiled Inbox when `PLANNOTATOR_INBOX_TEST_BINARY` names one, the CLI from source otherwise. `RELAY_PROOF_APPLE=1` adds the check against Apple's real hosts; `INBOX_PROOF_DIR` keeps the carriage's transcript and storage dumps. The relay workflow (`.github/workflows/relay.yml`) runs exactly this. The root `bun test` skips this folder.
