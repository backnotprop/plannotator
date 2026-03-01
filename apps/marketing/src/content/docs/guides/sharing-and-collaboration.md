---
title: "Sharing & Collaboration"
description: "Share plans and annotations via URL with optional short links for large plans."
sidebar:
  order: 21
section: "Guides"
---

Plannotator lets you share plans and annotations with teammates via URL. Small plans are encoded entirely in the URL hash — no backend, no accounts, no server stores anything. Large plans can optionally use short URLs via the [paste service](/docs/guides/self-hosting/#3-deploy-the-paste-service).

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

All data lives entirely in the URL. The share portal is a static page that reads the hash and renders it — it makes no network requests.

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

When sharing is disabled:
- The Share tab is hidden from the Export modal
- The "Copy Share Link" quick action is removed
- The Import Review option is hidden

## Short URLs for large plans

When a plan is too large for a URL (~2KB+ compressed), messaging apps like Slack and WhatsApp may truncate it. Plannotator can create a short link by temporarily storing the compressed plan in a paste service.

### How it works

1. Click **Export** → **Share**
2. If the URL is large, you'll see a notice: "This plan is too large for a URL"
3. Click **Create short link** to confirm
4. The compressed plan is temporarily stored, then automatically deleted after the configured TTL
5. A short URL like `share.plannotator.ai/p/aBcDeFgH` is generated
6. Both the short URL and the full hash URL are shown — the short URL is safe for messaging apps

### Privacy

- Plans are only uploaded when you explicitly click "Create short link" — no data leaves your machine until you confirm
- Pastes auto-expire and are permanently deleted (hosted: a few days, self-hosted: configurable via `PASTE_TTL_DAYS`)
- The paste service is fully open source — you can audit exactly what it does
- Self-hosters can run their own paste service for complete control — see the [self-hosting guide](/docs/guides/self-hosting/)
- If the paste service is unavailable, the full hash URL is always available as fallback

## Self-hosting the share portal

By default, share URLs point to `https://share.plannotator.ai`. You can self-host the portal and point Plannotator at your instance. See the [self-hosting guide](/docs/guides/self-hosting/) for details.

## Privacy model

- Plans and annotations are never sent to any server — the data lives entirely in the URL hash
- The share portal is a static page — it only reads the hash and renders client-side
- No analytics, no tracking, no cookies on the share portal
- Short URLs are opt-in — data is only uploaded when you explicitly click "Create short link" (see [Short URLs for large plans](#short-urls-for-large-plans) for details)
