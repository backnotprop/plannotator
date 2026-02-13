---
title: "Sharing & Collaboration"
description: "Share plans and annotations via URL — no backend required."
sidebar:
  order: 21
section: "Guides"
---

Plannotator lets you share plans and annotations with teammates via URL. All data is encoded in the URL hash — no backend, no accounts, no server stores anything.

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

## Self-hosting the share portal

By default, share URLs point to `https://share.plannotator.ai`. You can self-host the portal and point Plannotator at your instance. See the [self-hosting guide](/docs/guides/self-hosting/) for details.

## Privacy model

- Plans and annotations are never sent to any server
- The share portal is a static page — it only reads the URL hash client-side
- No analytics, no tracking, no cookies on the share portal
- If you self-host, you have complete control over the infrastructure
