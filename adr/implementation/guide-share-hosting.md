# Guide share hosting — implementation contract

Date: 2026-08-15. Scope memo: `adr/research/scope-guide-share-hosting-20260815.md`. Decisions taken there and confirmed: encrypted by default with `--public` opt-in; no expiry by default (`ttl` optional); CLI shares without a running Plannotator; the service lives in `apps/guides-show`; Cloudflare only — self-hosting means deploying the same Worker under your own account.

This document is the contract every part codes against. Names below are final; change them here first.

## 1. Payload formats

Two modes. Both store one text body per guide.

| mode | body stored | how produced (uploader) | how consumed (viewer) |
|---|---|---|---|
| `encrypted` (default) | `encrypt(await compress(snapshot))` — a base64url string (`@plannotator/core/crypto` `encrypt` over `@plannotator/core/compress` `compress`, exactly like plan share links) | uploader keeps `key`, puts it in the URL fragment `#key=<key>` (`GUIDE_SHARE_KEY_PARAM`) | viewer fetches body, `decrypt(body, key)` → `decompress(...)` → `parseGuideSnapshot(value)` |
| `plain` | the snapshot JSON text (must pass `parseGuideSnapshotJson` server-side) | `--public` / "allow link previews" | server renders `createGuideHtml(snapshot, { viewer, hosted })`; the viewer reads the embedded snapshot as today |

`snapshot` is a `GuideSnapshotV1` from `@plannotator/core/guide-format` (`buildGuideSnapshot` / `buildSavedGuideSnapshot` / `buildAuthoredGuideSnapshot`).

Size cap on the stored body: `MAX_SHARED_GUIDE_BYTES = 25 * 1024 * 1024`. Over the cap → `413 { error: "too large", maxBytes }`. (The downloadable file has no cap — D1; the host must.)

## 2. Identifiers and tokens

- `id`: 16 random bytes, base64url (22 chars). Unlisted capability URL.
- `deleteToken`: 16 random bytes, base64url, returned ONCE at create; stored as hex SHA-256 (`deleteTokenHash`).
- Viewer pin: the uploader sends the `{ js, css, jsIntegrity, cssIntegrity, langs? }` it embeds in exports (its `GUIDE_VIEWER_MANIFEST`); the server stores it and renders with it. If absent, the server uses its own bundled manifest. `baseUrl` is never sent — the host always uses its own viewer base (`https://<host>/v1/`, the Worker's own origin).

## 3. Storage interface (`apps/guides-show/share/core/storage.ts`)

```ts
export interface StoredGuideMeta {
  readonly mode: 'encrypted' | 'plain';
  readonly createdAt: string;            // ISO
  readonly expiresAt?: string;           // ISO, absent = never
  readonly deleteTokenHash: string;      // hex sha256
  readonly viewer?: { js: string; css: string; jsIntegrity?: string; cssIntegrity?: string; langs?: Record<string, string> };
  readonly bytes: number;                // body length
}
export interface GuideStore {
  put(id: string, body: string, meta: StoredGuideMeta): Promise<void>;
  get(id: string): Promise<{ body: string; meta: StoredGuideMeta } | null>;   // null when missing OR expired (store may lazily delete)
  delete(id: string): Promise<void>;
}
```
Stores: `stores/r2.ts` (objects `g/<id>` body + `g/<id>.meta` JSON; the meta object is written first and deleted last so a half-written guide reads as absent), `stores/memory.ts` (tests).

## 4. HTTP API (Worker)

| Route | Request | Response |
|---|---|---|
| `POST /api/g` | JSON `{ mode: 'encrypted'\|'plain', data: string, viewer?: {…}, ttlSeconds?: number }` | `201 { id, url, deleteToken, expiresAt? }` where `url = <origin>/g/<id>` (the uploader appends `#key=…` itself for encrypted). Errors: `400` bad shape / plain that fails `parseGuideSnapshotJson` (with `path`+`message`), `413` over cap, `429 { error: 'too many requests' }` + `Retry-After` over the per-IP create limit. |
| `GET /g/<id>` | — | plain: `200 text/html` from `createGuideHtml(snapshot, { viewer, hosted: { url } })`; encrypted: `200 text/html` from `createGuideShellHtml({ viewer, hosted: { url }, payloadUrl: '/api/g/<id>' })`. `Cache-Control: public, max-age=300`. `404` unknown/expired: a small HTML "not found" page (same styling class as fallback). |
| `GET /api/g/<id>` | — | the stored body: encrypted → `text/plain; charset=utf-8`; plain → `application/json`. `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300`. `404 { error: 'not found' }`. |
| `DELETE /api/g/<id>` | `Authorization: Bearer <deleteToken>` | `204`; `401` bad/missing token; `404`. |
| `OPTIONS /api/g*` | — | CORS preflight (`*`, `POST, GET, DELETE, OPTIONS`, `Content-Type, Authorization`). |
| `GET /healthz` | — | unchanged. |

Two brakes on anonymous uploads, both in code: the size cap, and a rate limit on **creation only**. `POST /api/g` goes through Cloudflare's native rate limiting binding (`wrangler.toml`: `[[ratelimits]] name = "GUIDE_CREATE_LIMITER"`, `simple.limit = 20`, `simple.period = 60`; the runtime accepts a period of 10 or 60 and nothing else), keyed on `CF-Connecting-IP`, answering `429 { error: 'too many requests' }` with `Retry-After: 60`. The ceiling is deliberately generous: a person shares a guide a few times an hour, so 20 a minute is only ever met by a script and a compliant user cannot notice it. Reads, `DELETE` (already gated by the delete token issued at create), preflights and `/v1/` are not limited. The binding is OPTIONAL in the Worker's `Env` and the check fails open in every direction it cannot resolve (no binding, so `wrangler dev`, a self-host that drops the block and the tests are unlimited; no `CF-Connecting-IP`, so nothing is in front of the Worker to key on; a binding that throws). The brake protects the hosted deployment and must never be what breaks a local run or a self-host.

Retention is indefinite by decision, not by omission: no operator lifetime ceiling, nothing prunes the bucket, because a review link that dies on a timer is a worse product than a file. (Plannotator's paste service is the precedent for anonymous, unauthenticated uploads, but its guards are stricter: 5 MB and a 7-day TTL.) Expiry is per upload (`ttlSeconds`), never imposed by the host, and it is enforced on read: an expired guide is deleted the next time any route touches it, so an expired guide nobody opens stays in the bucket. Worth revisiting with the lean sharing refactor, not before.

Store failures answer `500 { error: 'internal error' }` (API) or the styled error page; the store's own message is logged host-side (`GuideShareContext.logError`, default `console.error`) and never returned. Error pages name the serving host (`url.host`), not guides.show, and reuse core's exported `FALLBACK_STYLE` (`.pgr-fallback`).

Worker `wrangler.toml`: add `[[r2_buckets]] binding = "GUIDES" bucket_name = "guides-show-guides"` (bucket must be created before deploy — deploy is a separate, later step; NOT done as part of this build).

## 5. Core additions (done)

`packages/core/guide-format.ts` now exports: `GuideHtmlOptions.hosted?: { url }`, `GuideHostedPage`, `createGuideShellHtml({ viewer, hosted, payloadUrl })`, `GUIDE_HOSTED_META_NAME`, `GUIDE_PAYLOAD_META_NAME`, `GUIDE_SHARE_KEY_PARAM`. Hosted pages carry `<link rel=canonical>`, `og:*`, `robots noindex`, and the hosted meta; the CSP `connect-src` includes the hosted origin when it differs from the viewer origin. Re-exported through `@plannotator/shared/guide-format`; Pi vendors via `vendor.sh`.

## 6. Viewer (`apps/guides-show/viewer/main.tsx`)

Boot: if `#plannotator-guided-review` script exists → today's path. Else if `<meta name=GUIDE_PAYLOAD_META_NAME>` exists → hosted encrypted: read `key` from `location.hash` (`URLSearchParams` over the fragment), fetch `content` URL, `decrypt` → `decompress` → `parseGuideSnapshot`. Error cards: missing key ("This link is missing its key — the part after `#`"), 404 / network ("This guide is no longer available"), decrypt failure ("The key in this link does not open this guide"). Render the skeleton while fetching.

Hosted pages (either mode, detected by `<meta name=GUIDE_HOSTED_META_NAME>`): `headerActions` gains a **Download** button next to the mode toggle that builds the portable file client-side — `createGuideHtml(snapshot, { viewer })` where `viewer` is reconstructed from the DOM (stylesheet `href`+`integrity`, module script `src`+`integrity`; `baseUrl` = the script's directory; no `langs`) — and saves it via a blob URL (`<a download>`); filename `guideExportFilename(title)`. Never re-fetches from the server; never includes the hosted meta (the file is a plain export).

## 7. Plannotator producers

- `packages/server/guide/guide-share.ts` (Bun; vendored to Pi like `guide-review.ts`): `shareGuide(snapshot, opts: { serviceUrl: string; mode: 'encrypted'|'plain'; ttlSeconds?: number; viewer: Omit<GuideViewerAssets,'baseUrl'>; fetch?: typeof fetch }) → Promise<{ id: string; url: string; deleteToken: string; expiresAt?: string; bytes: number }>` where `url` includes `#key=…` for encrypted. Errors are thrown as `GuideShareError` with `{ status?, message }` (service unreachable, 413, 4xx/5xx with body message).
- Config (`packages/shared/config.ts`): `resolveGuideShareUrl(config)`: env `PLANNOTATOR_GUIDE_SHARE_URL` → `config.guideShareUrl` → `https://guides.show`; must be `http(s)`; trailing slash trimmed; invalid → warn once, default. Sharing is disabled entirely when `resolveSharingEnabled(config)` is false (`PLANNOTATOR_SHARE=disabled` / `{ "share": "disabled" }`).
- Review server endpoints (Bun `packages/server/review.ts` and Pi `apps/pi-extension/server/serverReview.ts`, both):
  - `POST /api/guide/:jobId/share` body `{ public?: boolean, ttlSeconds?: number }` (every field optional; an empty body means the defaults) → `200 { id, url, deleteToken, expiresAt?, bytes, recorded }`; `403 { error: 'sharing disabled' }`; `404` when the guide is not exportable (same resolution as `/export`); `409 { error, url }` when the guide's envelope already records a link (one link per guide: the record is the only place the token lives, so a second upload would orphan the first; remove it first); `502 { error }` on service failure. Same-origin guard as other mutating endpoints. On success, the saved guide envelope (when one exists / after `saved:` ids) records `share: { id, url, createdAt, deleteToken, serviceUrl }` so a saved guide remembers its link and the host it lives on; `recorded` says whether that happened (false when there is no envelope, e.g. guide history off), so the UI only offers Remove link for links it can remove.
  - `DELETE /api/guide/:jobId/share` → calls the host the record names (`serviceUrl`, else the origin of the recorded `url`; never merely the currently configured share URL) with the stored token, clears the envelope record; `204`; `404` no record. A host `404` (already gone) still clears the record.
  - `GET /api/guide/:jobId/share-info` → `{ enabled: boolean, serviceUrl, existing?: { url, createdAt } }`.
- CLI (`packages/server/guide/guide-cli.ts`): `plannotator guide share --id <saved> | --guide g.json --patch p.patch | --snapshot s.json [--public] [--ttl <e.g. 7d|24h|3600>] [--json]`. stdout: the URL (or `{ id, url, deleteToken, expiresAt? }` with `--json`); stderr: `Delete with: plannotator guide unshare <id> --token <deleteToken>` and the size. `--id` refuses (exit 1, no upload) while the saved guide already records a link, printing that link and its unshare command. `plannotator guide unshare <id> --token <t>` → `204` → "Removed"; an id some saved guide remembers is removed from the host its record names. Exit codes as `export`: 0 / 1 (not found, invalid, service error) / 2 usage. Refuses (exit 1) when `PLANNOTATOR_SHARE=disabled`. The hook entrypoint hands the guide CLI the raw argv after `guide` (it strips the annotate gate flags, `--json` included, from everything else).
- UI (`packages/review-editor/components/guide/GuideExportButton.tsx` → becomes a Share menu): **Download portable guide** (unchanged) and **Create share link** (hidden when `/share-info` says disabled). Dialog: what will be uploaded (guide + diff, size from `/export-info`), "End-to-end encrypted: guides.show never sees the code; the key is in the link" (default) with a checkbox "Allow link previews (stores the guide unencrypted)" = `public`; Create → shows the URL with a Copy button and the delete token shown once with its own Copy; if `existing`, show the link and **Remove link**. No upload without the click.

## 8. Self-host

Deploy the same Worker under your own Cloudflare account: create the two R2 buckets, `bun run build:viewer && bun run deploy:viewer`, `wrangler deploy` (README "Self-hosting"). There is no other host target.

## 9. Viewport nicety

`GuideViewportProvider` accepts `eager?: boolean`; when true every registered shell mounts (no window). `GuideView` sets `eager={files.length <= GUIDE_EAGER_MOUNT_MAX_FILES}` (`= 15`). Applies in-app and portable.

## 10. Tests that must exist

- `share/core/handler.test.ts`: create/get/delete for both modes with the memory store; caps; bad plain snapshot rejected with path; delete token semantics; expiry honored; HTML for plain has og:title + hosted meta and NO payload meta; encrypted shell has payload meta and no title/intent.
- `worker/index.test.ts`: the wiring only — share routes dispatched through `worker.fetch` over a fake `GUIDES` bucket with the bundled manifest as the fallback pin; `/v1` asset headers; 404 pages; the create rate limit through an env-injected fake binding (429 + `Retry-After` when spent, keyed per IP, never consulted for reads/delete/preflight/assets, fail-open with no binding, no client IP, or a limiter that throws).
- `packages/server/guide/guide-share.test.ts`: `shareGuide` against a fake fetch (encrypted → url has `#key=`, payload decrypts back to the snapshot; plain sends JSON; errors mapped).
- `guide-cli.test.ts`: `share`/`unshare` with a stubbed service (inject `fetch`), exit codes, `--json`.
- `guide-persistence.test.ts` (or a new file) both runtimes: `/share`, `/share-info`, `DELETE`, sharing-disabled 403, envelope record.
- Viewer: no DOM test harness for the boot path — covered by the manual/headless smoke below.
- `GuideViewportManager` eager mode: shells all mounted when eager, window preserved otherwise.

## 11. Smoke (end of build; no production deploy)

`bun run --cwd apps/guides-show deploy:viewer -- --local && bun run --cwd apps/guides-show dev:worker` + `PLANNOTATOR_GUIDE_SHARE_URL=http://localhost:8787 PLANNOTATOR_GUIDE_VIEWER_URL=http://localhost:8787/v1/ plannotator guide share --guide … --patch …` → open the printed URL in headless Chrome: guide renders (encrypted path), Download button present; `--public` variant: `og:title` in the HTML; `unshare` → 404 afterwards. Deploying the Worker to guides.show (and creating the `guides-show-guides` bucket) is a separate step, taken only when told.
