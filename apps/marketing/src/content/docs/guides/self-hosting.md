---
title: "Self-Hosting"
description: "Deploy and self-host the full Plannotator system — hook, share portal, and paste service."
sidebar:
  order: 23
section: "Guides"
---

Plannotator has three components. Only the hook is required.

> [!NOTE]
> Open source asynchronous link sharing is moving to deprecated support. Workspaces is the primary direction for team sharing. The self-hosted portal and paste service remain documented for compatibility, with no announced removal date.

## Components

| Component | Required | What it does |
|-----------|----------|--------------|
| Hook | Yes | Local binary that intercepts `ExitPlanMode`, runs the review UI |
| Share Portal | Optional | Static site that renders shared plans. When you open a share link, this is what loads in your browser. |
| Paste Service | Optional | Storage backend for the share portal. When a plan is too large for a URL, the paste service holds the compressed data and the portal fetches it on load. |

### How sharing works

Small markdown shares put compressed, unencrypted content in the URL fragment. The share portal reads the fragment in the browser, and the fragment is not included in the portal's HTTP request. Anyone or any service with the complete URL can read the shared content.

Large markdown shares and raw HTML do not fit the hash-only flow. Markdown users confirm short-link creation in the Export modal. Local raw HTML can create a short link immediately through the header share action or a configured callback action, while remote raw HTML creates one automatically at session startup. In each case, the browser encrypts the payload with AES-256-GCM before sending ciphertext to the paste service. The decryption key is embedded in the URL fragment (`#key=...`) and is not included in HTTP requests to the paste service or portal. When someone opens the complete link, the portal fetches the ciphertext and decrypts it in the browser. Anyone with that link can do the same.

**Without paste service:** Markdown sharing still works when the content fits in a URL fragment. No backend stores the shared payload, but the portal host receives normal request metadata and any service used to send the complete link can see its content. Raw HTML cannot be shared through this path.

**With paste service:** Large markdown and raw HTML shares get short URLs. The service stores client-encrypted ciphertext until the configured TTL expires.

## 1. Install the Hook

See [Installation](/docs/getting-started/installation/) for hook setup instructions.

## 2. Deploy the Share Portal

The share portal is a static single-page application with no application database. It loads shared hash content in the browser, fetches ciphertext for short URLs, and performs Plannotator's GitHub release check every time the app loads. There is currently no setting to disable that check. The built portal bundles its default Inter and Geist Mono fonts plus its syntax highlighter (Shiki, via the diff renderer) and themes, so those defaults do not require Google Fonts or any CDN. Rendered documents can still load remote assets that they reference.

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

The paste service accepts the browser-encrypted share payload and returns a short ID. Ciphertext goes in, and a link containing the browser-held decryption key comes out. Pastes auto-delete after the configured TTL. No database is required.

The paste service is fully open source — the same codebase you're looking at.

### Run the binary

Download the paste service binary for your platform from [GitHub Releases](https://github.com/backnotprop/plannotator/releases). Binaries are available for macOS (ARM64, x64), Linux (x64, ARM64), and Windows (x64).

```bash
chmod +x plannotator-paste-*
./plannotator-paste-darwin-arm64   # or whichever matches your platform
```

Pastes stored to `~/.plannotator/pastes/` by default.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PASTE_PORT` | `19433` | Server port |
| `PASTE_DATA_DIR` | `~/.plannotator/pastes` | Storage directory |
| `PASTE_TTL_DAYS` | `7` | Auto-delete after N days |
| `PASTE_MAX_SIZE` | `5242880` | Max encrypted payload size (5 MB) |
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
