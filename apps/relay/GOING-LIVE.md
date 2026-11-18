# Going live with relay 1.1 (owner steps)

Prepared, not run. Every step here needs the owner's Apple or Cloudflare account; no agent and no workflow runs them. Run them from `apps/relay/` in this repository.

What 1.1 adds is in `adr/implementation/inbox-mobile.md`, section 4, "Relay 1.1 and push 2". Everything it adds was proved under `wrangler dev` with a local stand-in for Apple (`test/relay-1-1.test.ts`, `test/sealed.test.ts`); nothing in it has reached Apple yet.

## 1. What you need first

- The APNs auth key: Apple Developer, Certificates, IDs & Profiles, Keys, a key with Apple Push Notifications service enabled. Apple lets you download its `.p8` file once.
- The key's Key ID (10 characters, shown with the key) and your Team ID (10 characters, Membership details).
- The app's bundle id, and any TestFlight or development build's bundle id that should get pushes.

## 2. The three secrets

Each command asks for the value, or reads it from the file you pipe in. Values are kept by Cloudflare as Worker secrets and never in a file in this repository.

| Secret | What it holds | Command |
|---|---|---|
| `APNS_KEY` | The `.p8` file's whole text, `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----` | `bunx wrangler secret put APNS_KEY < AuthKey_XXXXXXXXXX.p8` |
| `APNS_KEY_ID` | That key's Key ID | `bunx wrangler secret put APNS_KEY_ID` |
| `APNS_TEAM_ID` | Your Team ID | `bunx wrangler secret put APNS_TEAM_ID` |

Until all three are set, every push to an iPhone answers `no_apns_key` and nothing else changes. (`FCM_SERVICE_ACCOUNT`, for Android, is a later step; the README's Deploy section has it.)

## 3. The bundle ids

`wrangler.toml` holds `[vars] APNS_TOPICS = "ai.plannotator.app"`. To let another build get pushes, add its bundle id, comma-separated, for example `"ai.plannotator.app,ai.plannotator.app.dev"`, and commit the change. Keep `ai.plannotator.app` on the list while any app that names no topic is in use. A phone that registers a bundle id not on the list is refused (`400 topic_not_allowed`).

## 4. Deploy

```sh
bunx wrangler deploy
```

It adds no Durable Object class, so no migration runs. Each mailbox gains its new columns at its first request after the deploy. Open sockets close at the deploy, as at any deploy; the Inbox reconnects within a second, and phones poll until they open their socket again.

## 5. Check it

```sh
./live-check.sh
```

Expect every line to start with `ok`, including the three new ones:

```
ok    relay 1.1: GET devices/:dev/socket is served
ok    relay 1.1: DELETE devices/:dev/commands/probe is served
ok    relay 1.1: PUT devices/:dev/liveactivity is served
```

`FAIL  relay 1.0 still deployed: ...` means the deploy did not take. Run the script at most once a minute: it spends that minute's mailbox creations from your address.

Then one sealed push to your own paired test phone, on the computer whose Inbox it is paired with, after the app has registered its push token (the app's notifications allowed):

```sh
bun live-push-check.ts dev_XXXXXXXXXXXXXXXXXXXXXXXXXX
```

The device id is in Settings, Remote devices, or in `inbox/devices.jsonl`. The script reads this computer's mailbox and that phone's pairing secret, seals a test summary exactly as the Inbox seals a push, and prints only the relay's answer:

| Output | Meaning |
|---|---|
| `{"http":202,"sent":true,...}` | Apple took it. The phone shows "Plannotator relay check" |
| `"reason":"no_push_token"` | The app has not registered its token yet |
| `"reason":"no_apns_key"` | A secret is missing (step 2) |
| `"reason":"topic_not_allowed"` | The app's bundle id is not on `APNS_TOPICS` (step 3) |
| `"apns_status":403,"apns_reason":"InvalidProviderToken"` | The key, Key ID and Team ID do not belong together |
| `"apns_status":400,"apns_reason":"BadDeviceToken"` | The token's environment is wrong: a development build registers `sandbox`, TestFlight and the App Store `production` |
| `"apns_status":400,"apns_reason":"DeviceTokenNotForTopic"` or `"TopicDisallowed"` | The key's team or the bundle id does not match the build |

It never prints a secret, a key, an envelope or a token, and the test notification uses a thread id no real thread has, so it replaces no real notification.

## 6. Rolling back

```sh
bunx wrangler deployments list
bunx wrangler rollback <the version before 1.1>
```

What the person sees after a rollback to 1.0:

- The Inbox reads no version in `hello` and stops sending `live` pushes; question pushes and the phone's reads and answers go on unchanged.
- Phones lose their socket and poll `items`, as before. Cancel answers `404 not_found`, so a held write waits like any held write.
- A phone that registered a bundle id other than `ai.plannotator.app` gets no pushes, since 1.0 pushes every token under that id.
- The columns 1.1 added stay and 1.0 ignores them. A command 1.0 holds meanwhile is written without the `handed` mark, and the column defaults to handed, so when you deploy 1.1 again it cannot be taken back: Cancel answers `409` and its result says what happened. No write can be reported taken back after it ran.

To stop all iPhone pushes without a rollback: `bunx wrangler secret delete APNS_KEY`. Every push then answers `no_apns_key`.
