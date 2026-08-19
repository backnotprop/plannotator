---
title: "Sharing & Collaboration"
description: "Share plans and annotations via URL with optional short links for large plans."
sidebar:
  order: 21
section: "Guides"
---

> [!NOTE]
> Open source asynchronous link sharing remains available for compatibility but is moving to deprecated support. [Workspaces](/workspaces/) is the primary direction for team sharing. No removal date has been announced.

Plannotator can share plans and annotations with teammates via URL. Small markdown shares put compressed content in the URL fragment, so no backend stores the share payload. Larger markdown shares and raw HTML can use an encrypted short URL backed by the [paste service](/docs/guides/self-hosting/#3-deploy-the-paste-service).

## How sharing works

When you share a plan:

1. Plan markdown + annotations are serialized to a compact JSON format
2. The JSON is compressed using `deflate-raw` via the browser's native `CompressionStream`
3. The compressed bytes are base64url-encoded (URL-safe: `+/=` replaced with `-_`)
4. The result is appended as a URL hash fragment

The share URL looks like:

```
https://share.plannotator.ai/#eNqrVkrOz0nV...
```

The shared content lives in the URL fragment and is compressed, not encrypted. Browsers do not include the fragment in the HTTP request to the portal. The portal host still receives a normal page request, and the Plannotator UI checks GitHub for release metadata without sending the shared content.

## Sharing a plan

1. Click **Export** in the header bar (or use the dropdown arrow for quick actions)
2. In the Export modal, go to the **Share** tab
3. Click **Copy Link** to copy the share URL
4. Send the URL to your teammate

The URL size is shown so you can gauge if it's too large for your messaging platform.

## Importing a teammate's review

When a teammate shares their annotated plan with you:

1. Click the **Export** dropdown arrow → **Import Review**
2. Paste the share URL
3. Their annotations load into your current session

This lets you see exactly what a teammate flagged, merge their feedback with your own, and send a combined review back to the agent.

## Disabling sharing

If you want to prevent sharing (e.g., for sensitive plans), set:

```bash
export PLANNOTATOR_SHARE=disabled
```

Or set it persistently in `~/.plannotator/config.json`:

```json
{ "share": "disabled" }
```

The environment variable takes precedence over the config file.

When sharing is disabled:
- The Share tab is hidden from the Export modal
- The "Copy Share Link" quick action is removed
- The Import Review option is hidden

## Short URLs for large plans

When a markdown plan is too large for a URL (~2KB+ compressed), messaging apps like Slack and WhatsApp may truncate it. Plannotator can create a short link by temporarily storing an encrypted payload in a paste service.

### How it works

1. Click **Export** → **Share**
2. If the URL is large, you'll see a notice: "This plan is too large for a URL"
3. Click **Create short link** to confirm
4. The browser encrypts the compressed payload and uploads only the ciphertext
5. The ciphertext is temporarily stored, then expires after the configured TTL
6. A short URL like `share.plannotator.ai/p/aBcDeFgH#key=...` is generated
7. For markdown, both the short URL and the full hash URL are shown. Raw HTML requires the short-link path.

Those confirmation steps describe markdown in the Export modal. Raw HTML cannot use the hash-only path. In a local raw-HTML session, choosing the header's **Copy Share Link** action or using an Approve or Send Feedback callback can create and upload the encrypted short link immediately. A remote raw-HTML session uploads an encrypted short link automatically when the session is created.

### Privacy & encryption

- The browser encrypts the payload with AES-256-GCM before upload. The paste service receives ciphertext, not readable plan, annotation, or raw HTML content.
- A fresh key is generated with the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/generateKey). It is placed in the URL fragment and is not included in HTTP requests to the paste service or share portal.
- Anyone or any service with the complete link has the key and can decrypt the content. Treat the full URL as a secret.
- Markdown upload from the Export modal happens after you click **Create short link**. Local raw HTML can upload from the header share action or a callback action without that markdown confirmation. Remote raw HTML uploads automatically at session creation.
- Hosted ciphertext expires after 7 days. Self-hosted retention is configurable with `PASTE_TTL_DAYS`.
- The paste service is open source and self-hostable. See the [self-hosting guide](/docs/guides/self-hosting/).
- If the paste service is unavailable, markdown can still use the full hash URL. Raw HTML sharing is unavailable without the short-link path.

### Callback-enabled links

A link creator can configure an `http://` or `https://` callback endpoint and a token. When the recipient chooses **Approve** or **Send Feedback**, the browser posts the action, token, and annotated share URL to that endpoint. For a short link, `annotated_url` can include the complete fragment decryption key. Trust the link creator and callback endpoint with the shared content and key, and use HTTPS to protect the callback in transit.

## Self-hosting the share portal

By default, share URLs point to `https://share.plannotator.ai`. You can self-host the portal and point Plannotator at your instance. See the [self-hosting guide](/docs/guides/self-hosting/) for details.

## Privacy model

- Hash-only shares do not upload the shared content to the portal. The content is not encrypted and is visible to anyone or any service that receives the complete link.
- The static portal receives normal request metadata such as IP address and user agent. It has no Plannotator usage analytics or product telemetry, but functional cookies can remember settings and update-dismissal state.
- The portal performs the automatic GitHub release check every time the app loads. That request contains no plan, annotation, or raw HTML content, and there is currently no opt-out setting.
- Markdown short links are opt-in. They upload AES-256-GCM ciphertext and keep the decryption key in the URL fragment, similar to [PrivateBin](https://privatebin.info/).
- Raw HTML uses the short-link path and can upload through local header or callback actions, or automatically when a remote session is created.
- Sending either kind of link transfers the full URL through your chosen email, chat, ticket, or other service. That service can retain the content or key embedded in the link.
