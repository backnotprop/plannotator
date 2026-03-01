---
title: "Self-Hosting"
description: "Deploy and self-host the full Plannotator system — hook, share portal, and paste service."
sidebar:
  order: 23
section: "Guides"
---

Plannotator has three components. Only the hook is required.

## Components

| Component | Required | What it does |
|-----------|----------|--------------|
| Hook | Yes | Local binary that intercepts `ExitPlanMode`, runs the review UI |
| Share Portal | Optional | Static site that renders shared plans. When you open a share link, this is what loads in your browser. |
| Paste Service | Optional | Storage backend for the share portal. When a plan is too large for a URL, the paste service holds the compressed data and the portal fetches it on load. |

### How sharing works

Small plans are encoded entirely in the URL hash — the share portal reads the hash and renders the plan. No backend involved. The data remains private — it never leaves the URL.

Large plans don't fit in a URL. **When a user explicitly confirms** short link creation, the compressed plan is sent to the paste service, which stores it and returns a short ID. A compressed plan goes in, a link to retrieve it comes out. The share URL becomes `share.plannotator.ai/p/aBcDeFgH` (or `your-portal.example.com/p/aBcDeFgH` if self-hosting). When someone opens that link, the portal fetches the compressed data from the paste service, decompresses it, and renders the plan.

**Without paste service:** Sharing still works for plans that fit in a URL. Those plans stay completely private — the data lives only in the URL hash and never touches a server. Large plans show a warning that the URL may be truncated by messaging apps.

**With paste service:** Large plans get short, reliable URLs that work everywhere. Plannotator temporarily stores the compressed plan data — it auto-deletes after the configured TTL.

## 1. Install the Hook

See [Installation](/docs/getting-started/installation/) for hook setup instructions.

## 2. Deploy the Share Portal

The share portal is a static single-page application. It has no backend, no database, and makes no network requests beyond fetching paste data for short URLs.

### Build

```bash
bun install
bun run build:portal
```

Output: `apps/portal/dist/`

### Deploy

Upload the `dist/` folder to any static hosting provider.

#### Nginx

```nginx
server {
    listen 80;
    server_name plannotator.internal.example.com;
    root /var/www/plannotator;
    try_files $uri /index.html;
}
```

#### AWS S3 + CloudFront

```bash
aws s3 sync apps/portal/dist/ s3://your-bucket/ --delete
```

Configure the CloudFront distribution to return `/index.html` for 404s (SPA routing).

#### Vercel / Netlify / Cloudflare Pages

Point to the repository root:
- **Build command**: `bun run build:portal`
- **Output directory**: `apps/portal/dist`

## 3. Deploy the Paste Service

The paste service accepts compressed plan data and returns a short ID. A compressed plan goes in, a link to retrieve it comes out. Pastes auto-delete after the configured TTL. No database required.

The paste service is fully open source — the same codebase you're looking at.

### Option A: Run the binary

Download the paste service binary from [GitHub Releases](https://github.com/backnotprop/plannotator/releases):

```bash
curl -fsSL https://plannotator.ai/install-paste.sh | bash
```

Or download directly from [GitHub Releases](https://github.com/backnotprop/plannotator/releases).

Start it:

```bash
plannotator-paste
```

Pastes stored to `~/.plannotator/pastes/` by default.

### Option B: Docker

```bash
docker run -d -p 19433:19433 -v plannotator-pastes:/data \
  ghcr.io/backnotprop/plannotator-paste:latest
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PASTE_PORT` | `19433` | Server port |
| `PASTE_DATA_DIR` | `~/.plannotator/pastes` | Storage directory |
| `PASTE_TTL_DAYS` | `7` | Auto-delete after N days |
| `PASTE_MAX_SIZE` | `524288` | Max payload size (512KB) |
| `PASTE_ALLOWED_ORIGINS` | (see defaults) | CORS allowed origins |

## 4. Connect the Components

```bash
export PLANNOTATOR_SHARE_URL=https://your-portal.example.com
export PLANNOTATOR_PASTE_URL=https://your-paste.example.com
```

## 5. Verify

1. Start a plan review in Claude Code or OpenCode
2. Add annotations, click **Export** → **Share**
3. Confirm the share URL starts with your configured domain
4. If the plan is large, click **Create short link** when prompted
5. Open the short URL — the plan should render correctly
