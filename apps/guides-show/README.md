# guides.show

The portable Guided Review viewer and its Cloudflare Worker.
Decision record: `adr/decisions/007-portable-guided-reviews-20260815.md`; spec: `adr/implementation/portable-guided-reviews.md`.

## What lives here

- `viewer/` — the browser entry that turns an exported guide (`<script id="plannotator-guided-review">`) into the same guide UI Plannotator renders: `@plannotator/guide-viewer` over `AllFilesCodeView` in `readOnly` mode. Multi-file Vite build (`vite.viewer.config.ts`): `viewer.<hash>.js/.css`, one chunk per Shiki grammar, the highlight worker as a file, fonts as files.
- `worker/` — the Cloudflare Worker: serves `/v1/*` from the `guides-show-viewer` R2 bucket (immutable, CORS `*` so `file://` documents can load it), the landing page from static assets, and shared guides (`/g/<id>`, `/api/g*`) through the share handler over the `guides-show-guides` R2 bucket.
- `share/` — the guide share service (contract: `adr/implementation/guide-share-hosting.md`): `core/handler.ts` is the pure request handler the Worker runs, `core/storage.ts` the store interface, `stores/` the R2 and in-memory stores.
- `build/` — `manifest-plugin` (emits `manifest.json`: entry paths + SRI + grammar chunk map), `read-only-stubs-plugin` (keeps annotation UI out of the bundle), `deploy-viewer` (add-only R2 upload), `check-budgets`, `sync-manifest`, `export-sample`, `serve-local`.
- `packages/core/guide-viewer-manifest.ts` (generated here by `sync-manifest`) — checked in; what Plannotator embeds so exports pin the viewer this release publishes. Lists only the grammar chunks `detectGuideLanguages` can reference (every chunk is still built and published). Regenerate with `bun run build:viewer && bun run sync:manifest`; CI fails if stale.
- `site/` — landing page.

## Local loop

```sh
bun run --cwd apps/guides-show build:viewer          # dist/viewer
bun run --cwd apps/guides-show serve:local           # http://localhost:8787/v1/ (CDN stand-in)
bun run --cwd apps/guides-show export:samples -- --base http://localhost:8787/v1/ --out dist/samples-local
open apps/guides-show/dist/samples-local/*.html      # opens from file://, loads the local "CDN"
```

Or through the real Worker: `bun run deploy:viewer -- --local` (seeds local R2) then `bun run dev:worker` and export against `http://localhost:8787/v1/`. `dev:worker` passes `--host localhost:8787` so the URLs the Worker builds from the request (share links, the viewer pin on hosted pages) carry the port; without it wrangler presents the host as bare `localhost` and every link it hands out points at port 80.

`bun run test` runs the worker, share and viewer tests; `bun run typecheck` checks the Worker, share handler and build scripts (strict, `tsconfig.json`). `typecheck:viewer` (`tsconfig.viewer.json`) covers the React viewer, whose own files are clean but which imports `@plannotator/review-editor` and inherits its pre-existing type errors, so it is not a gate.

## Self-hosting

Shared guides are stored by whoever runs the service. The hosted service is guides.show; deploying the same Worker under your own Cloudflare account gives you the same routes, and Plannotator can be pointed at either.

Once per account:

```sh
cd apps/guides-show
wrangler r2 bucket create guides-show-viewer      # immutable viewer builds under /v1/
wrangler r2 bucket create guides-show-guides      # shared guides (deletable)
```

Then publish the viewer build and the Worker (the domain in `wrangler.toml` `routes` is yours to change):

```sh
bun run build:viewer && bun run deploy:viewer     # add-only upload of dist/viewer to /v1/
wrangler deploy
```

Uploads are anonymous by design (the encrypted default means the host cannot read them). Two brakes exist in code: the size cap (25 MiB per guide) and a per-IP rate limit on **creation only**. `POST /api/g` runs through Cloudflare's native rate limiting binding, keyed on `CF-Connecting-IP`, and answers `429 { "error": "too many requests" }` with `Retry-After: 60` past 20 creates per minute. That ceiling is far above what a person does (a few shares an hour), so a compliant user never meets it and only a script does. Reads, `DELETE` (already gated by the delete token issued at create), preflights and the `/v1/` assets are never limited.

The binding is declared in `wrangler.toml`:

```toml
[[ratelimits]]
name = "GUIDE_CREATE_LIMITER"
namespace_id = "1001"        # any id you have not used for another limiter in this account

  [ratelimits.simple]
  limit = 20
  period = 60                # only 10 or 60 are accepted
```

It is **optional** in the Worker's `Env`: delete the block, or run `wrangler dev` / the local stand-in, and creation is simply not limited. The limiter also fails open when it throws and when there is no `CF-Connecting-IP` to key on (nothing is in front of the Worker), because a broken brake must never be what stops people sharing guides.

Guides are kept indefinitely. That is a deliberate decision, not an oversight: a review link that dies on a timer is a worse product than a downloaded file, so the host imposes no TTL and nothing prunes the bucket. Expiry happens only when an upload asks for one (`ttlSeconds`), and it is enforced on read: an expired guide is deleted the next time any route touches it, so one nobody opens stays in the bucket until then. Retention is worth revisiting with the lean sharing refactor.

### Pointing Plannotator at your host

| Setting | Effect |
|---|---|
| `PLANNOTATOR_GUIDE_SHARE_URL=https://guides.example.com` (or `{ "guideShareUrl": "..." }` in `~/.plannotator/config.json`) | Where `plannotator guide share`, the review UI's share dialog and `unshare` upload to and delete from. |
| `PLANNOTATOR_GUIDE_VIEWER_URL=https://guides.example.com/v1/` | The viewer base that downloaded portable guides pin, so exports open against your `/v1/` instead of guides.show. Must be https (or http on localhost). |
| `PLANNOTATOR_SHARE=disabled` (or `{ "share": "disabled" }`) | Turns sharing off entirely; the share commands refuse and the UI hides the option. |

## Share API

Guides are encrypted by default: the uploader keeps the key in the URL fragment (`#key=...`) and the host only ever sees ciphertext; `plain` guides (`--public` / "allow link previews") are stored as snapshot JSON so the page can carry `og:title` and friends.

| Route | Request | Response |
|---|---|---|
| `POST /api/g` | JSON `{ mode: "encrypted" \| "plain", data: string, viewer?: { js, css, jsIntegrity?, cssIntegrity?, langs? }, ttlSeconds?: number }` | `201 { id, url, deleteToken, expiresAt? }`; `url = <origin>/g/<id>` (the uploader appends `#key=...` for encrypted). `400` bad shape or a plain snapshot that fails validation (`{ error, path, message }`), `413 { error: "too large", maxBytes }` over 25 MiB, `429 { error: "too many requests" }` with `Retry-After` past the per-IP create limit. `expiresAt` is present only when the upload asked for a `ttlSeconds`. |
| `GET /g/<id>` | | `200 text/html`: plain guides render the full page with the pinned viewer; encrypted guides get the shell that fetches `/api/g/<id>` and decrypts in the browser. `Cache-Control: public, max-age=300`. `404`: a small "not found" page. |
| `GET /api/g/<id>` | | The stored body: `text/plain` ciphertext (encrypted) or `application/json` (plain). `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300`. `404 { error: "not found" }`. |
| `DELETE /api/g/<id>` | `Authorization: Bearer <deleteToken>` | `204`; `401` missing or wrong token; `404` unknown or expired. |
| `OPTIONS /api/g*` | | CORS preflight: `*`, `POST, GET, DELETE, OPTIONS`, `Content-Type, Authorization`. |
| `GET /v1/*` | | Immutable viewer assets, CORS `*`. |
| `GET /healthz` | | `{ "ok": true }`. |

The `viewer` pin is the `{ js, css, jsIntegrity, cssIntegrity, langs? }` the uploader embeds in its own exports; the host renders the page with it, on its own `/v1/`. Without a pin the host uses its bundled manifest. Ids and delete tokens are 16 random bytes as base64url; the token is stored as a SHA-256 hash and shown once at create.

## Immutability

Everything under `/v1/` is content-hashed and never overwritten or deleted. Exports pin `viewer.<hash>.js` + `integrity`, so a guide exported today opens forever. Mutable pointers (build manifests) live under `/meta/`, never `/v1/`.

## Deploy status

First deployed 2026-08-15 from a local wrangler login: bucket `guides-show-viewer` created, viewer build `viewer.DULnMtI1.js` published to `/v1/`, Worker live on the `guides.show` custom domain. Verified: immutable + CORS headers on the edge, served bytes match the pinned SRI, an export with the default URL opens from disk.

## First deploy checklist (one-time)

1. Cloudflare: create R2 buckets `guides-show-viewer` (viewer builds) and `guides-show-guides` (shared guides); add the `guides.show` zone; the Worker route uses `custom_domain = true`.
2. GitHub: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, Workers R2 Storage:Edit, Zone DNS for the custom domain) and `CLOUDFLARE_ACCOUNT_ID` secrets in the `production` environment (the paste-service secrets may already cover this if the token has R2 scope).
3. Run the `guides.show deploy` workflow manually once (workflow_dispatch), then it runs on every `v*` tag.
