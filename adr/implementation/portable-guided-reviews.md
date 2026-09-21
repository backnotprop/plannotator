# Portable Guided Reviews — Implementation Spec

Status: implemented on branch `portable-guides` (see §11); first Cloudflare deploy pending
Decision record: `adr/decisions/007-portable-guided-reviews-20260815.md` (D1–D12 referenced throughout)
Salvage source: branch `guided-review-html-export` (`2cf18cc3`), worktree `/Users/ramos/plannotator/guided-review-html-export`

## 1. Goal

Share one Guided Review as a single small HTML file that renders identically to the in-app guide, with the renderer served from `guides.show`. Build the export as a pure function callable from the Plannotator UI and the CLI. Lay the foundation (format, package, domain) for shared feedback and hosted guides without building them.

Non-goals (D11, D12) at the time of writing: share links / upload, annotations or PR threads in exports, extra palettes, the standalone agent generator, an embed API for the commercial platform. Share links were built afterwards under their own contract, `adr/implementation/guide-share-hosting.md` (see the hosting phase in §11); the rest stays out.

## 2. Architecture

```
┌──────────────────────── Producers ────────────────────────┐
│ Plannotator server (Bun + Pi)          plannotator CLI     │
│  guide job launch → capture patch      guide export        │
│  guide-store: {id}.json + {id}.patch    --id | --snapshot  │
│  GET /api/guide/:id/export  ───────┐         │             │
└────────────────────────────────────┼─────────┼─────────────┘
                                     ▼         ▼
                     ┌── @plannotator/core/guide-format ──┐
                     │ snapshot schema v1 · strict parser  │
                     │ toPortableHtml(snapshot) · fixtures │
                     └────────────────┬────────────────────┘
                                      ▼  one HTML file (size ≈ diff)
        ┌────────────────────── guides.show (Cloudflare Worker) ──────────────────────┐
        │ /v1/viewer.<hash>.js  /v1/viewer.<hash>.css  /v1/fonts/*  /v1/langs/*.js   │
        │ immutable, content-hashed · /g/<id> reserved · own deploy, not paste-service│
        └────────────────────────────────────┬────────────────────────────────────────┘
                                             ▼
                     ┌── @plannotator/guide-viewer ────────────────────────┐
                     │ GuideView → GuideSectionCard → GuideFileCard →      │
                     │ GuideViewportManager → AllFilesCodeView (readOnly)  │
                     │ imported by packages/review-editor (in-app)         │
                     │ bundled to viewer.<hash>.js (portable)              │
                     └─────────────────────────────────────────────────────┘
```

Repo layout (new / changed):

| Path | Role |
|---|---|
| `packages/core/guide-format/` | **new** — snapshot types, `parseGuideSnapshot`, `toPortableHtml`, `estimateBytes`, filename slug, fixtures. Browser-safe, zero deps (D5, D9). |
| `packages/guide-viewer/` | **new** — the renderer package `@plannotator/guide-viewer` (D2). Ships TS source + prebuilt `styles.css` like `@plannotator/ui`. |
| `apps/guides-show/` | **new** — Cloudflare Worker with static assets + `wrangler.toml` + the viewer CDN build config (D7, D8). No relationship to `apps/paste-service`. |
| `packages/review-editor/` | imports the guide chain from `@plannotator/guide-viewer`; keeps `GuideScreen`, `GuideEmptyState`, `GuideGenerating` (app shell). |
| `packages/server/`, `apps/pi-extension/server/` | patch capture, `guide-store` v2, export endpoints (D6). |
| `apps/hook/server/index.ts` | `guide export` subcommand (D9). |
| `.github/workflows/` | `guides-show-deploy.yml` on release tags (D10). |

## 3. Snapshot format (`@plannotator/core/guide-format`) — D5

```jsonc
{
  "kind": "plannotator-guided-review",
  "version": 1,
  "exportedAt": "2026-08-15T20:00:00Z",
  "guide": {
    "title": "Auth token refresh",
    "intent": "…markdown…",
    "sections": [{ "title": "…", "overview": "…markdown…", "diffs": [{ "file": "src/auth.ts", "summary": "…" }] }],
    "unplacedFiles": ["README.md"],
    "reviewed": [true, false]
  },
  "review": { "rawPatch": "diff --git a/… ", "gitRef": "main..HEAD", "diffType": "since-base", "base": "origin/main" },
  "source": {
    "kind": "pr",                              // local | pr | workspace | commit
    "repo": "backnotprop/plannotator", "branch": "feat/auth", "headSha": "…",
    "pr": { "url": "https://github.com/…/pull/1082", "number": 1082, "title": "…", "platform": "github" },
    "commitSha": null
  },
  "generator": { "engine": "claude", "model": "sonnet", "generatedAt": "…", "customInstructions": "…or null" },
  "theme": { "palette": "plannotator" }        // optional hint
  // "annotations": reserved for v2 (D3) — parser rejects it in v1
}
```

Rules:
- Strict: unknown fields rejected at every level with a JSON-path error (salvaged parser). `reviewed` normalized to `sections.length`. `guide` is `CodeGuideOutput & { reviewed }` — never `saved`/`moved`.
- No size caps (D1). Structural sanity caps only (sections ≤ 100, refs ≤ 50 000) to keep parsing total.
- `languages` are **derived**, not stored: `detectLanguages(rawPatch)` maps file extensions → grammar ids (reuse `getCallFlowPatchFiles`-style path extraction + a small ext→lang map).
- One fixture per version under `packages/core/guide-format/fixtures/v1/*.json`; `compat.test.ts` parses all fixtures with the current parser (D8, D10 gate).

`toPortableHtml(snapshot, { viewer: { base, jsHash, cssHash, jsIntegrity, cssIntegrity, version } })` emits:

```html
<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="plannotator-guided-review" content="v1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://guides.show 'wasm-unsafe-eval' blob:; style-src https://guides.show 'unsafe-inline'; font-src https://guides.show; img-src data: blob:; connect-src https://guides.show; worker-src blob:; base-uri 'none'; form-action 'none'">
<title>{title} · Guided Review</title>
<link rel="stylesheet" href="https://guides.show/v1/viewer.{cssHash}.css" integrity="sha384-…" crossorigin="anonymous">
<link rel="modulepreload" href="https://guides.show/v1/langs/typescript.{hash}.js" crossorigin="anonymous"> <!-- one per detected language -->
</head><body>
<div id="root">
  <!-- D1/D6 fallback: title, intent, per-section title + overview + file list + summaries, rendered as simple HTML. Readable with no network. -->
</div>
<script id="plannotator-guided-review" type="application/json">{escaped snapshot}</script>
<script type="module" src="https://guides.show/v1/viewer.{jsHash}.js" integrity="sha384-…" crossorigin="anonymous"></script>
</body></html>
```

- Escaping: `&`, `<`, `>`, U+2028/9 → `\uXXXX` inside the JSON script (salvaged, tested with a literal `</script>` in a patch line).
- `connect-src https://guides.show` exists only so grammar chunks can be dynamically imported; nothing else may be fetched (D4).
- Filename: `guided-review-{slug}.html`.

## 4. Viewer package (`@plannotator/guide-viewer`) — D2, D3, D4, D8

### 4.1 Public surface
```ts
export function GuideViewer(props: { snapshot: GuideSnapshot; theme?: 'light'|'dark'|'system'; palette?: string }): JSX.Element
export function mountGuideViewer(el: HTMLElement, snapshot: GuideSnapshot, opts?): { unmount(): void }
export { GuideView, GuideSectionCard, GuideFileCard, GuideViewportProvider } // used by review-editor
```
`GuideViewer` = parse patch (`parseDiffToFiles`) → `ThemeProvider` (palette from `theme` hint → cookie/system) → `GuideViewportProvider` → `GuideView` with a `codeViewProps` bundle in **read-only** shape. No fetch anywhere; `configStore` given an in-memory storage backend so nothing writes cookies on `file://`.

### 4.2 Refactors (from the coupling audit; S/M sizes)
| # | Change | Where | Size |
|---|---|---|---|
| R1 | `GuideView` takes `files`, optional `revealFile`, optional `activeSearchMatch` as props (local reveal token fallback already exists) | `GuideView.tsx:65,79-83,107` | S |
| R2 | `GuideSectionCard` takes `allFiles` prop instead of `state.files` | `GuideSectionCard.tsx:100` | S |
| R3 | `GuideFileCard` takes one `codeViewProps` bundle instead of 46 `useReviewState` reads | `GuideFileCard.tsx:112-160` | M |
| R4 | Move `renderInlineMarkdown.tsx`, `renderMarkdownProse.tsx`, `diffParser.ts`, `types.ts (DiffFile)` into the package; move `shared/diff-paths.ts` → `core` | 4 files | S |
| R5 | Move `shared/guide.ts` (types) → `core/guide`, keep shim | — | S |
| R6 | Repoint `usePierreTheme.ts:2` type import to `core/config-types` | — | S |
| R7 | `AllFilesCodeView` `readOnly` prop: `enableLineSelection/enableGutterUtility=false`, no `ToolbarHost`/`CommentPopover`/`FileCommentBanner`/`EditProvider` (behind `React.lazy` so they code-split out) | `AllFilesCodeView.tsx:2290-2291, 2432-2489` | M |
| R8 | Split `isActive` (annotation target) from `enableKeyboardShortcuts` (the `window` keydown at `:2119`) | `AllFilesCodeView.tsx:2031-2033` | S |
| R9 | `FileHeader`: `OpenInAppButton` behind an explicit prop; `AllFilesCodeView`: `fileContentFetcher` seam (default = `/api/file-content`; viewer passes `null` → no augmentation, no expand controls) | `FileHeader.tsx:332`, `AllFilesCodeView.tsx:1246` | M |
| R10 | Package CSS build: Tailwind v4 `@source` over the package + `theme.css` base palette + review-only overrides (`--text-xs: 0.8125rem`, `--panel-header-h`), mirroring `packages/ui/vite.css.config.ts` | new | M |
| R11 | Shiki narrowing (see 4.3) | build | M |
| R12 | `GuideViewAdapter` in review-editor: reads `useReviewState()`, builds the bundle; `GuideScreen` unchanged otherwise | new, `GuideScreen.tsx:375-383` | S |
| R13 | Annotation slot preserved (D3): the `codeViewProps` bundle keeps `annotations`/callbacks typed; read-only hosts pass empty — no API removal | — | S |

Parity gate: existing `GuideView.test.tsx` / `GuideSectionCard.test.tsx` keep passing against the package; the app renders the guide byte-identically (manual browser check + a Playwright/DOM snapshot of the guide screen before/after the move on the demo guide).

### 4.3 CDN build (`apps/guides-show/viewer.vite.config.ts`) — D8
- Entry `viewer.tsx`: read `#plannotator-guided-review`, `parseGuideSnapshot`, `mountGuideViewer(#root)`; on parse failure render an error card over the fallback body.
- **Multi-file build, not single-file**: `inlineDynamicImports: false`. Shiki's `bundledLanguages` entries are already lazy `() => import(...)` loaders, so Rollup emits **one chunk per grammar** automatically → `/v1/langs/<lang>.<hash>.js`. The `shiki/wasm` alias from `apps/review/vite.config.ts` is reused. **Spike (Phase 2 gate):** confirm `@pierre/diffs`' static `bundledLanguages` import keeps the map tiny and grammars in chunks; if not, alias `shiki` to a narrowed shim exporting the same map shape.
- Fonts: `@fontsource-variable/inter` + `geist-mono` latin subsets emitted as files under `/v1/fonts/`, referenced from the CSS; `font-display: swap` with system fallback (D8).
- Worker: emit `worker.<hash>.js` as a real, import-free file (`inlineDynamicImports`; `check-budgets` asserts no module syntax so it can run as a classic worker). Runtime (`viewer/portablePool.tsx`): fetch it, then probe construction strategies in order — blob classic, blob module, data classic, data module — with a one-line worker that must answer; first that answers builds the pool, none → main-thread. Chrome refuses blob module workers from `file://` ("cross-origin redirects of the top-level worker script", asynchronously via the `error` event) but accepts classic blob workers, which is why the probe is live and not a `location.protocol` switch. `PoolWatchdog` drops the provider if the pool is not initialized within 4 s (Pierre renders nothing while waiting on a pool whose workers died), and the guide re-renders on the main thread.
- Output manifest `manifest.json` `{ version:1, js, css, integrity:{js,css}, langs:{ts:'langs/typescript.<h>.js',…} }` consumed by `toPortableHtml`'s callers (server/CLI read it at build time; the Plannotator binary embeds the manifest of the viewer it was released with).
- **Size budgets (CI fails above):** `viewer.js` ≤ 1.2 MB raw / 400 KB gzip; `viewer.css` ≤ 120 KB / 30 KB gzip; HTML shell overhead (everything but the snapshot) ≤ 25 KB. Measured and tightened after Phase 2.

## 5. guides.show — D7, D8, D10

- `apps/guides-show/`: Cloudflare Worker (static assets binding) + `wrangler.toml` (own account/project; **no shared code or config with `apps/paste-service`**).
- Routes: `/v1/*` static, `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *` (grammar/font/worker fetches from `file://` and other origins), `Cross-Origin-Resource-Policy: cross-origin`. `/g/*` → 404 JSON `{ reserved: true }` (route reserved, D11). `/` → minimal landing.
- Immutability: the deploy step **only adds** files; it never overwrites an existing `/v1/<name>` (upload script checks existence and fails on hash collision with different content).
- Deploy: `.github/workflows/guides-show-deploy.yml` on `v*` tags — build viewer → run `compat.test.ts` → upload assets → publish manifest as a release asset. Local: `bun run --cwd apps/guides-show deploy`.
- Platform-readiness (D7): Worker skeleton keeps a router so `/g/<id>` + upload can be added as routes; R2 binding declared but unused; no KV/DO now.

## 6. Plannotator producer — D6, D9, D11

### 6.1 Patch capture at launch (Bun + Pi)
- `buildCommand` guide branch (`review.ts:~1060-1198`) returns `launchReview: { rawPatch, gitRef, diffType, base, source }` next to `changedFilesSnapshot`/`guideContext`. **Repairs reuse the failed job's `launchReview`.**
- `agent-jobs.ts` keeps it in a server-side map (`jobLaunchReviews`, like `jobChangedFilesSnapshots`) — **never on `AgentJobInfo`** (that object is broadcast over SSE). Handed to `onJobComplete` in `meta`; cleared from the map after completion.
- `guide-review.ts` `GuideSession` keeps `launchReviews: Map<jobId, LaunchReview>` **only for successful guides** (set in `onJobComplete` on success), evicted with the job. This is the in-session source for live ids and the fallback when history is off.
- `guide-store.ts` envelope **v2**: adds `review: { gitRef, diffType, base, source, patchFile: "{id}.patch" }`; `saveForJob` writes `{id}.patch` (atomic tmp+rename) beside `{id}.json`; v1 envelopes still load (no patch → export reports "diff not retained"). Respects `writesEnabled()`.
- `buildSnapshot(jobId|savedId)` in `guide-review.ts`: guide (+ current reviewed state) + launchReview + generator (job engine/model, `guideContext`, custom instructions used) → `GuideSnapshot`.

### 6.2 Endpoints (Bun `review.ts` + Pi `serverReview.ts`, byte-parity)
- `GET /api/guide/:jobId/export-info` → `{ bytes, languages[] }` (`saved:{id}` and live ids; `decodeURIComponent` like siblings).
- `GET /api/guide/:jobId/export` → `text/html`, `Content-Disposition: attachment; filename="guided-review-{slug}.html"`, `Cache-Control: no-store`. 404 when no guide/patch; **no 409 large-file gate** (D1).
- Both stay live under `PLANNOTATOR_AI=disabled` like the other `/api/guide/*` reads.

### 6.3 CLI (`apps/hook/server/index.ts`) — D9
- `plannotator guide export --id <savedGuideId> [--out <file>]` — reads `${DATA_DIR}/guides/**/{id}.json` + `.patch`.
- `plannotator guide export --snapshot <snapshot.json> [--out <file>]` — the pure form (a complete snapshot document, wrapped as-is).
- `plannotator guide export --guide <guide.json> --patch <diff.patch | -> [--out <file>]` — the agent form (D9 caller 3: the standalone `plannotator-guide` skill, its own repo). The agent writes only the guide (`title/intent/sections[/unplacedFiles]` + optional `review{gitRef,base}`/`source`/`generator`) and hands over the `git diff`; the CLI validates strictly against the patch (unknown or duplicate files are errors that list the patch's files), infers `source` from git in cwd, builds the snapshot, and round-trips it through the strict parser before writing HTML.
- `plannotator guide list` — id, label, title, savedAt, hasPatch (small, helps `--id`).
- Exit codes: 0 ok, 1 not found / invalid snapshot, 2 usage.

### 6.4 UI
- `GuideView` header **Share** menu (adapt salvaged `GuideShareMenu`): one item, "Download portable guide (N KB)"; preflight `export-info`; anchor download; toast on failure. No placeholders (D11). Hidden when `export-info` 404s (v1 envelope without patch).

## 7. Phases and gates

| Phase | Work | Gate (must pass to proceed) |
|---|---|---|
| 0 | Branch `portable-guides` off main. Salvage `guide-export.ts`+test, `portableGuideSnapshot.ts`+test, `workerPool` split (restore deleted comments), portable Vite/entry as references. Create `packages/core/guide-format` with schema v1, parser, `toPortableHtml`, fixtures, `compat.test.ts`. | Tests green; fixture parses; escaping test with `</script>`; `bun run typecheck`. |
| 1 | Viewer carve-out R1–R13; `packages/guide-viewer` with CSS build; review-editor imports it. | Existing guide tests green; app parity check (demo guide before/after screenshots identical, no new network calls in app); `AllFilesCodeView` read-only renders demo diff with no `/api/*` requests. |
| 2 | CDN build + size budgets; grammar-chunk spike; worker/file:// switch; local `file://` and `http://localhost` smoke on a real exported guide. | Budgets met; grammars are chunks; `file://` opens with highlighting; hosted opens with worker; fallback body readable with network blocked. |
| 3 | `apps/guides-show` Worker, wrangler, immutability check, deploy workflow (dry-run to a staging project first). | `curl` headers correct; second deploy refuses to overwrite; a Phase-2 HTML pointed at the real domain renders. |
| 4 | Producer: launch capture, guide-store v2, endpoints (Bun+Pi), CLI, Share menu. | `guide-persistence.test.ts` extended for both runtimes (export-info/export, `saved:` id, v1-envelope 404); CLI tests (`--id`, `--snapshot`, exit codes); Pi vendor parity check; manual: generate → switch diff → export → HTML shows the *launch-time* diff. |
| 5 | Docs (`docs/commands/code-review.md`, CLAUDE.md env/endpoints tables), release notes, first tagged deploy. | Release pipeline publishes viewer; a guide exported by the release binary opens from disk on a machine without Plannotator. |

## 8. Verification matrix (decision → check)

| Decision | Verified by |
|---|---|
| D1 size ≈ diff, no caps | HTML overhead budget in CI; no size gate in export path; test exporting a 20 MB synthetic diff succeeds |
| D2 one renderer | `packages/review-editor` has **no** copy of the guide chain (lint: import from `@plannotator/guide-viewer` only); parity screenshots |
| D3 read-only, slot preserved | `codeViewProps` type still carries annotation fields; read-only render shows no toolbar/popover; `annotations` block rejected by v1 parser (test) but documented as reserved |
| D4 guide screen only, no server calls | Playwright on `file://` export: zero non-guides.show requests; CSP blocks any accidental fetch |
| D5 strict, self-describing | unknown-field rejection tests; all four `source.kind`s render an honest header (fixture per kind) |
| D6 launch-time diff | integration test: launch guide → switch diff → export → snapshot patch equals launch patch; repair reuses it |
| D7 standalone Cloudflare | `apps/guides-show` imports nothing from `apps/paste-service`; separate wrangler + workflow |
| D8 immutable/pinned, per-need assets | deploy script refuses overwrite; HTML carries hash+integrity; only detected languages preloaded; fonts served as files |
| D9 pure export, three callers | `toPortableHtml` has no I/O; UI + CLI both call it; `--snapshot` form works with a hand-written snapshot; `--guide/--patch` form (skill) validates an authored guide against its patch — `guide-cli.test.ts` |
| D10 release-gated deploy | workflow triggers only on tags; `compat.test.ts` in the job |
| D11/D12 scope | Share menu single item; no `/g` handler; no embed docs. Superseded for share links by the D11 addendum: the menu now has Download + Create share link and `/g` is served by the share handler; still no embed docs |

## 9. Salvage from `guided-review-html-export`

| Keep (adapt) | Rewrite / drop |
|---|---|
| `packages/shared/guide-export.ts` → `core/guide-format` (parser, escaping, URL sanitizer, filename slug, HTML renderer skeleton) | in-memory `launchSnapshots` map + `buildCommand(jobId)` signature change |
| `guide-export.test.ts` (unknown-field, `</script>`, `javascript:` URL, slug tests) | `estimatePortableGuidedReviewExportBytes` building HTML on every menu open |
| `portableGuideSnapshot.ts` + test | mutable `v1/viewer.js` on the marketing CDN + `deploy.yml` changes |
| `workerPool.tsx` → `workerPoolRuntime.ts` split (**restore the deleted profiling comments**) | `DiffViewer` `fileContentFetchEnabled` gating (guide no longer renders through it) |
| `apps/review/portable.tsx` + `vite.portable.config.ts` as starting points for the CDN build | "Fully self-contained" 17 MB format; large-file 409 gate; disabled "Create HTML share link" item |
| `useUpdateCheck({enabled})`, `OpenInAppButton` gate idea | `GuideDiffSection` edits (file deleted upstream) |

## 10. Risks and spikes

1. **Grammar chunking** — depends on Rollup splitting Shiki's lazy loaders once `inlineDynamicImports` is off, and on Pierre's static `bundledLanguages` import not pulling grammars eagerly. Phase 2 spike; fallback = alias `shiki` to a narrowed shim.
2. **Main-thread highlighting** (only when no worker strategy is accepted) for very large diffs (the deleted comment measured >2 s of `findNextMatchSync` while scrolling). Mitigation: idle-time highlight, or accept; hosted guides get the worker.
3. **`configStore` writes cookies on first read** — the viewer must install an in-memory storage backend before anything reads a setting.
4. **Tailwind CSS for the package** — `@plannotator/ui/styles.css` does not scan review-editor; a wrong `@source` yields unstyled chips. Gate: visual parity in Phase 1.
5. **React duplication** in the commercial platform later — package declares `react`/`react-dom` peers; not a v1 concern.
6. **Bun/Pi drift** — every endpoint/store change lands in both; `guide-persistence.test.ts` runs both servers.
7. **Fallback body fidelity** — deliberately simple (D6 note in decision record); do not over-invest.

## 11. Task tracker

Status: implemented on branch `portable-guides` (2026-08-15); awaiting the one-time Cloudflare setup + first deploy. Share link hosting built 2026-08-15 (below); its production deploy (bucket + Worker) is also pending.

- [x] Phase 0 — branch, salvage, `core/guide-format` + fixtures + compat test (33 tests)
- [x] Phase 1 — guide chain carved into `packages/guide-viewer` behind `GuideHost`; `ReviewGuideHost` adapter; `AllFilesCodeView` `readOnly` + `enableKeyboardShortcuts`; parity gate 0/1,440,000 px vs main on the demo guide. Deviation from §4.2: the package injects the diff renderer (host contract) instead of moving `AllFilesCodeView` and its tail into the package; the CDN build imports it from review-editor and stubs annotation-only modules at resolve time (R10 package CSS build deferred — the CDN build reuses the review stylesheet).
- [x] Phase 2 — `apps/guides-show` multi-file build: 235 grammar chunks split automatically (spike confirmed, no shim), entry 378 KB gz (budget 400), worker fetched → blob/data with a live construction probe (Chrome `file://` needs a *classic* blob worker; the earlier blob-module check only passed under `--allow-file-access-from-files`), pool watchdog → main-thread, fonts as files, KaTeX stubbed, `manifest.json` (SRI from bytes on disk), budgets script; smoke: file://, hosted, offline fallback.
- [x] Phase 3 — Worker (R2 for `/v1/`, assets for landing, `/g` + `/api` reserved), add-only R2 publish script, deterministic manifest + checked-in `packages/core/guide-viewer-manifest.ts` with sync/check, `guides-show-deploy.yml` on `v*` tags. Verified locally with `wrangler dev` + local R2. **Not yet run against Cloudflare** — needs bucket, domain, secrets (README checklist).
- [x] Phase 4 — `GuideLaunchReview` captured in `buildCommand`, carried server-side through agent-jobs (Bun + Pi), memoized in `GuideSession`, persisted as `{id}.patch` beside the envelope; `/api/guide/:id/export` + `/export-info` on both servers; `plannotator guide list|export`; `GuideExportButton`; e2e test with a fake engine; docs.
- [ ] Phase 5 — first tagged viewer deploy to guides.show, then export from a release binary and open on a machine without Plannotator.
- [x] Hosting phase (guide share hosting, `adr/implementation/guide-share-hosting.md`, 2026-08-15): built. `apps/guides-show/share/` (pure handler + `GuideStore` interface; R2 and memory stores) behind the Cloudflare Worker (`GUIDES` R2 binding), the only host target (self-hosting = deploying the same Worker; the Bun target, fs/S3 stores, rate limiting and the TTL ceiling were built and then removed as code with no user); core `createGuideShellHtml` + hosted/payload meta + `GUIDE_SHARE_KEY_PARAM`; viewer boot for the hosted encrypted path (fragment key, fetch, decrypt, error cards) and the client-side Download button on hosted pages; `packages/server/guide/guide-share.ts` (`shareGuide` / `unshareGuide`, vendored to Pi); `resolveGuideShareUrl` (`PLANNOTATOR_GUIDE_SHARE_URL` / `guideShareUrl`); `POST|DELETE /api/guide/:jobId/share` + `/share-info` on both servers with the envelope `share` record; `plannotator guide share` / `unshare`; the Share menu + `GuideShareDialog`; `GuideViewportProvider` eager mode. Tests: `share/core/handler.test.ts`, `share/stores/stores.test.ts`, `worker/index.test.ts`, `guide-share.test.ts`, `guide-cli.test.ts`, guide persistence on both runtimes, `GuideViewportManager.test.tsx`. Smoke (encrypted link renders in headless Chrome with Download present; `--public` page carries `og:title`; `unshare` then 404) done against the local Worker. Deploying the Worker with the `guides-show-guides` bucket to guides.show is a separate, explicit step.
