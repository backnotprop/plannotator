# Scope: hosting shared guides on guides.show

Date: 2026-08-15
Status: scoping — decisions proposed, nothing built. Follows ADR 007 (D7 reserved the URL space, D11 put share links out of scope).

> **Outcome (2026-08-15).** Built as proposed, then simplified. What shipped: the share service inside `apps/guides-show/share/` (pure handler + `GuideStore` interface, R2 and in-memory stores) served by the existing Cloudflare Worker over the `guides-show-guides` R2 bucket; encrypted-by-default links with `--public` opt-in; no expiry by default with an optional per-upload `ttlSeconds`; one-time delete tokens; the `plannotator guide share` / `unshare` CLI; the Share menu in Plannotator; `PLANNOTATOR_GUIDE_SHARE_URL` / `guideShareUrl`. What was cut: the Bun self-host target and the fs and S3 stores (with their `--trust-proxy` / `--public-origin` flags), upload rate limiting, the operator TTL ceiling, and the CLI's `--service-url` flag. Reason: one host target is enough to keep the routes honest and testable, and every extra path was code with no user. "Self-hostable" now means deploying the same Worker under your own Cloudflare account; the only upload guard is the size cap, the same as the paste service. The rest of this memo is the pre-build proposal, kept as written. The contract is `adr/implementation/guide-share-hosting.md`.

## Summary

Today a portable guide is a file. The next step is a link: `https://guides.show/g/<id>`. Almost everything needed already exists — the artifact format (`createGuideHtml` over a strict snapshot), the pinned immutable viewer under `/v1/`, a Worker on the domain with `/g/*` and `/api/*` reserved, and an end-to-end-encrypted share pattern (plan share links: ciphertext in the paste service, key in the URL fragment). The share service is a thin layer on top: store a snapshot, hand out a capability URL, render it with the pinned viewer.

The recommendation is to build it **inside `apps/guides-show`** in the paste service's shape (`core/` handler + storage interface, `stores/` r2|fs|s3, `targets/` cloudflare|bun), **Cloudflare-first, self-hostable by config**, with **encrypted-by-default** links that match how Plannotator already shares plans, and a plain (server-readable) mode reserved for the future platform. Plannotator gains a "Create share link" next to "Download portable guide", a `plannotator guide share` CLI, and one env var to point at a self-hosted origin. The skill repo stays a skill.

## What exists

| Piece | State | Reuse |
|---|---|---|
| Snapshot format + `createGuideHtml` | shipped, `@plannotator/core/guide-format` (browser-safe, runs in a Worker) | the thing we store and render |
| Viewer at `guides.show/v1/<hash>` | live, add-only, SRI-pinned | `/g/<id>` renders with a pinned build, same as the file |
| Worker `apps/guides-show/worker` | live; `/g/*`, `/api/*` reserved (404 `{ reserved: true }`) | becomes the host |
| Paste service `apps/paste-service` | shipped: `core/handler.ts` + `storage.ts` interface, `stores/{fs,kv}`, `targets/{bun,cloudflare}`, 5 MB cap, 7-day TTL, 8-char ids | the architecture template (not the code: guides are bigger, longer-lived, need HTML rendering) |
| Plan share links | end-to-end encrypted, `@plannotator/core/crypto`, key in `#key=`, `PLANNOTATOR_SHARE_URL` / `PLANNOTATOR_PASTE_URL` / `PLANNOTATOR_SHARE=disabled` | privacy model + config precedent |
| Producers | UI button, `guide export --id`, `guide export --guide/--patch` (skill) | each gets a `share` sibling |

## Decisions to make

### S1 — Where the service lives
**Recommendation: `apps/guides-show`**, next to the viewer build and the Worker it extends. One deploy, one domain, one manifest. Rejected: the skill repo `plannotator/guides` (`npx skills add` clones the repo; a service there muddles installs and pulls in monorepo packages the viewer needs); a third repo (viewer build depends on `packages/*`; nothing gained until there is a team that owns hosting separately).

### S2 — What is stored
**Recommendation: the snapshot JSON, plus the viewer pin recorded at upload.** `/g/<id>` renders HTML on read with `createGuideHtml` (pure, already Worker-safe) and caches at the edge. Same bytes as the download would give — no drift (D9). Storing the snapshot rather than the HTML keeps a JSON surface for later (`/g/<id>.json`, embeds, the platform) and lets a link opt into a newer viewer someday without re-upload. Store the pin so it does not silently change today.

### S3 — Privacy model
**Recommendation: encrypted by default, plain by explicit choice.**
- *Encrypted*: client (Plannotator server or CLI) encrypts the snapshot with `@plannotator/core/crypto`, uploads ciphertext, gets `/g/<id>#key=…`. `/g/<id>` serves a viewer shell that fetches `/api/g/<id>`, decrypts in the browser, parses, renders. The host never sees code. This is exactly the plan-share contract users already have; diffs are more sensitive than plans, not less. Cost: no server-side title/OG preview (generic card), no server-side features on the content.
- *Plain*: snapshot stored readable; `/g/<id>` is full HTML with title/intent in OG tags; enables listing, comments, embeds later. Opt-in flag on upload (`--public` / checkbox), never the default.
- Both are unlisted, capability URLs: 128-bit ids (22 base64url chars), not the paste service's 8. Delete via a `deleteToken` returned once at upload (stored hashed).

### S4 — Limits and lifetime
- Size cap for hosting (the file has none — D1 — but the host must): **25 MB** ciphertext/snapshot; over that, "download instead" with the size.
- Lifetime: **no expiry by default** for guides (a review link that dies in 7 days is a worse product than a file); optional TTL parameter for the paranoid. Deleted on request via token. Reconsider when a platform with accounts exists.
- Abuse: per-IP rate limit on upload (Cloudflare rate-limiting rule or Durable Object counter), size cap, `Content-Type` allowlist. Turnstile only if needed.

### S5 — Self-hosting
Same shape as the paste service, documented in `apps/guides-show/README.md`:
- **Cloudflare (first-class)**: `wrangler deploy` with an R2 bucket for guides (KV's 25 MB value cap and eventual consistency make R2 the right store; the viewer already lives in R2). Config via `wrangler.toml` vars.
- **Bun target**: `bun run apps/guides-show/targets/bun.ts` with `stores/fs` (or `stores/s3`), for a box behind a company VPN. Serves `/v1/` viewer assets from `dist/viewer` too, so a self-hosted origin is complete on its own.
- Plannotator side: `PLANNOTATOR_GUIDE_SHARE_URL` (default `https://guides.show`) — mirrors `PLANNOTATOR_SHARE_URL`; `PLANNOTATOR_SHARE=disabled` turns guide sharing off with everything else; `PLANNOTATOR_GUIDE_VIEWER_URL` already covers a self-hosted viewer. Config-file equivalents in `~/.plannotator/config.json`.

### S6 — Plannotator integration
- **UI**: Share menu on the guide screen grows **Create share link** beside Download (D11 anticipated this). Flow: click → confirm dialog (what is uploaded, encrypted, unlisted, size) → `POST /api/guide/:id/share` on the review server → server encrypts + uploads → dialog shows URL, copy, and the delete token once. Never uploads without the confirmation (same rule as large plan shares).
- **Server**: `POST /api/guide/:id/share` (Bun + Pi mirror), `DELETE` counterpart using the stored token, and a per-guide record of `{ url, createdAt }` in the guide envelope so a saved guide remembers its link.
- **CLI**: `plannotator guide share --id <saved> | --guide g.json --patch p.patch [--public] [--ttl]` prints the URL (and the delete token to stderr). The `plannotator-guide` skill gets one optional line: "if the user wants a link, run `guide share` instead of `guide export`".
- **Viewer**: `/g/<id>` is same-origin with `/v1/`, so the worker pool takes the plain module-worker path; the probe already handles it. Add a "Download this guide" affordance on hosted pages (the file is the portable form).

### S7 — Reserved, not built
Accounts, listing/search, comments or annotations on shared guides (format slot exists, D3), embeds/iframe API, custom domains for teams. The URL space (`/g/`, `/api/`) and the JSON-at-rest choice (S2) keep all of these open.

## Architecture (proposed)

```
apps/guides-show/
  worker/index.ts          existing: /v1 immutable, landing, → mounts share routes
  share/
    core/handler.ts        pure request handling: create/get/delete, limits, id gen, HTML render via createGuideHtml
    core/storage.ts        interface { put(id, blob, meta), get(id), delete(id) }
    stores/r2.ts  fs.ts  s3.ts
    targets/cloudflare.ts  binds R2 + rate limit; targets/bun.ts serves share + /v1 from disk
  site/                    landing (unchanged), later: "paste a guide" upload page? (not v1)
```

Routes:
- `POST /api/g` — body `{ mode: "encrypted"|"plain", viewer: <manifest pin>, data }` → `{ id, url, deleteToken }`
- `GET  /g/<id>` — plain: full HTML (OG tags, `Cache-Control: public, s-maxage=…`, purge on delete); encrypted: viewer shell that fetches `/api/g/<id>` and decrypts with `#key`
- `GET  /api/g/<id>` — raw stored payload (JSON or ciphertext); `GET /g/<id>.html` — the portable download
- `DELETE /api/g/<id>` — with `Authorization: Bearer <deleteToken>`

## Phases

1. **Service** — `share/core` + r2 store + Worker routes, encrypted + plain modes, limits, tests against the paste-service test shape; deploy; smoke: upload a fixture, open `/g/<id>` from another origin.
2. **Plannotator** — server endpoints (both runtimes), Share menu "Create share link" with confirm dialog, `guide share` CLI, env/config wiring, docs (`portable-guides` page gains "Hosted links"), `PLANNOTATOR_SHARE=disabled` honored.
3. **Self-host** — Bun target + fs/s3 stores, README recipe, `PLANNOTATOR_GUIDE_SHARE_URL` end to end against a local instance.
4. **Skill** — one optional step in `plannotator/guides` SKILL.md once a release ships `guide share`.

## Open questions (need a call from you)

1. Encrypted-by-default (S3)? It matches plan sharing and is the safer product, but it costs link previews and blocks server-side features until a user opts into plain.
2. Expiry (S4): none by default, or a long default (e.g. 1 year) to keep the bucket honest?
3. Should hosted links be created from the Plannotator **server** (uploads from the user's machine, needs the review server running) or should the CLI also work fully offline-from-Plannotator (`guide share --guide/--patch`)? Recommendation: both, sharing one function.
