# Handoff: reusing Plannotator's document UI in Workspaces

This document is for the team building the commercial **Workspaces** app. It explains what this PR shipped, how the published packages are put together, and exactly how Workspaces plugs its own backend (storage, auth, realtime, AI) into the same document UI that Plannotator uses — without forking or rebuilding it.

If you read nothing else, read **"The 60-second version"**, **"Supported imports"**, and **"The seam catalog"**.

---

## The 60-second version

- Plannotator's document UI (markdown rendering, theme, the annotation editor, settings, comments, file browser, plan diff, layout) is now two installable npm packages: **`@plannotator/ui`** (React components + hooks + theme) and **`@plannotator/core`** (pure utils + types, zero dependencies, browser-safe).
- Workspaces installs both, imports the components it wants, imports one stylesheet, loads fonts, and calls **`configurePlannotatorUI({ ... })` once at startup** to plug in its own backend.
- Every place the UI talks to a backend is an **optional seam**. Each seam has a default that reproduces today's Plannotator behavior (hitting `/api/*` over fetch). If Workspaces passes its own implementation, the UI uses that instead. If it passes nothing, it behaves like Plannotator.
- Plannotator itself is **unchanged** — it passes nothing and keeps using the defaults. This is the core constraint the whole design protects (see "The law").

---

## What this PR changed (inventory)

**New package: `@plannotator/core`** — a browser-safe, zero-dependency package carved out of `@plannotator/shared`. It holds the pure utilities and types `ui` depends on, so `ui` can be installed without dragging in Plannotator's Node/server code. Modules were moved with `git mv` (not copied). CI typechecks it with no `@types/node` so a `node:` import can't sneak in.

Core modules: `agents`, `agent-jobs`, `agent-terminal`, `browser-paths`, `code-file`, `compress`, `crypto`, `external-annotation`, `extract-code-paths`, `favicon`, `feedback-templates`, `goal-setup`, `open-in-apps`, `project`, `source-save`, plus extracted type files (`config-types`, `storage-types`, `workspace-status-types`, `ai-context`, `types`).

**`@plannotator/shared` re-exports core via one-line shims** — e.g. `packages/shared/project.ts` is just `export * from '@plannotator/core/project';`. This is why none of Plannotator's ~99 internal import sites changed: they still import from `@plannotator/shared/*` and get the moved code transparently.

**`@plannotator/ui` got the host-override seams** (the bulk of the diff) plus:
- `configure.ts` — the single front door, `configurePlannotatorUI()`.
- Each seam file gained a `setX`/`resetX` (or `get`) accessor and a default implementation.
- `*.seam.test.tsx` files — tests proving each seam defaults to Plannotator behavior and routes to a host override when set.
- Precompiled `styles.css` (~187KB, ~31KB gzip) built from `styles-entry.css` via `vite.css.config.ts`, so a consumer doesn't have to wire Tailwind to use the theme. Font binaries are **not** bundled (the consuming app owns fonts) — including KaTeX's math fonts: the publish build deliberately excludes `katex/dist/katex.min.css` (which would inline ~1.1MB of fonts). If you render math, see "Math rendering (KaTeX)" below.
- `wideMode.ts` moved from `packages/editor` into `ui/utils` (it was UI-layer state).

Net: roughly 130 files changed, +5k/−2.4k vs main (regenerate with `git diff main --stat` for exact numbers — this line goes stale with every rebase). Most of the deletions are the `git mv` of core modules out of `shared`; most of the additions are seams + tests + the moved core package.

---

## Architecture: three packages, one rule

```
@plannotator/core   ← pure utils + types. zero deps. browser-safe (no node:). PUBLISHED.
       ↑
@plannotator/ui     ← React components + hooks + theme + configure(). PUBLISHED.
                       depends on core (exact-version lockstep).
       ↑
@plannotator/shared ← Node/git/server logic. PRIVATE to the monorepo.
                       re-exports core's moved modules via shims so Plannotator is untouched.
```

- **Workspaces installs `@plannotator/ui` + `@plannotator/core`.** It never touches `shared` (that's Plannotator's server-side code).
- **No circular dependencies by construction**: `core` imports nothing, `ui` imports `core`, `shared` imports `core`. One direction only.
- **The packages ship TypeScript source, not compiled JS.** Workspaces' bundler compiles them (it's an internal consumer, and this keeps source-mapping and tree-shaking clean). That means Workspaces needs a TS/TSX-capable bundler — Vite + React 19 + Tailwind v4, with `moduleResolution: "bundler"`, `allowImportingTsExtensions`, `jsx: "react-jsx"`. Because your `tsc` type-checks the shipped `.ts`/`.tsx` with **your** compiler options (`skipLibCheck` only exempts `.d.ts`), the source is kept clean under `strict: true` — **CI-enforced**: `packages/ui/tsconfig.strict-consumer.json` type-checks the supported-import surface under full strict as part of the repo's `typecheck`, mirroring a standalone Vite consumer (which is also how it was originally verified).

### The seam pattern (how an override works)

Each seam is a module-level variable holding the current implementation, defaulting to Plannotator's behavior, with a setter:

```ts
// utils/storage.ts (representative)
export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const cookieBackend: StorageBackend = { /* Plannotator's cookie reads/writes */ };
let backend: StorageBackend = cookieBackend;            // ← the default IS today's behavior

export function setStorageBackend(b: StorageBackend) { backend = b; }   // ← host override
export function resetStorageBackend() { backend = cookieBackend; }      // ← tests restore default
```

Everything in the UI reads through `backend`. Plannotator never calls the setter, so it stays on cookies. Workspaces calls `setStorageBackend(itsOwnBackend)` once at startup (via `configurePlannotatorUI`) and the whole UI persists settings to Workspaces' store instead.

**A note on this being module-level (a "singleton") and not a React Provider:** this is intentional and safe *for a client-side app*. Each user's browser runs its own copy of these variables; there's one logged-in user per browser; nothing is shared across users. The only setup where a module-level global is wrong is **server-side rendering** — one server process rendering for many concurrent users would let one user's render read another's identity. **Workspaces does not do SSR**, so this is a non-issue. If Workspaces ever adds SSR for this UI, that's the moment to revisit (the fix would be a React `<PlannotatorUIServices>` provider, and `configurePlannotatorUI` would become a thin compatibility shim over it). Until then, don't add that complexity.

---

## The seam catalog

Pass any subset of these to `configurePlannotatorUI({ ... })`. Anything omitted keeps Plannotator's default. The interfaces below are the real contracts as shipped.

| Seam (config key) | Type | What it controls | Default behavior |
|---|---|---|---|
| `storageBackend` | `StorageBackend` | Where UI settings persist (identity, plan-save prefs, toggles) | Cookies |
| `identityProvider` | `IdentityProvider` | Who the current user is — stamps `author`, drives the `(me)` badge, and (via `isEditable()`) whether the Settings rename controls show | Reads `displayName` from ConfigStore (server > cookie > generated "tater" name); editable |
| `imageSrcResolver` | `(path, base?) => string` | Turns a stored image path/ref into a URL the browser can load | `/api/image?path=…` (http(s) URLs pass through unchanged) |
| `uploadTransport` | `UploadTransport` | Where pasted/attached images upload to | `POST /api/upload` (multipart), returns `{ path }` |
| `docPreviewFetcher` | `(path, base?) => Promise<DocPreviewResult \| null>` | Hover/inline preview of a linked `.md` doc | `GET /api/doc` |
| `fileTreeBackend` | `FileTreeBackend` | The file/folder browser tree + live-watch | `GET /api/reference/files`, EventSource watch |
| `draftTransport` | `DraftTransport` | Auto-saved annotation drafts (survive a crash/reload) | `GET/POST/DELETE /api/draft` |
| `externalAnnotationTransport` | `ExternalAnnotationTransport<T>` | Live/agent comments streamed into the doc | SSE `/api/external-annotations/stream` + polling snapshot + CRUD |
| `aiTransport` | `AITransport` | The "Ask AI" chat session/query/abort/permission | `POST /api/ai/{session,query,abort,permission}` |
| `serverSync` | `ServerSyncFn` | Push a settings change back to the server | No-op-ish (Plannotator's local sync) |
| `loadSettingsFromBackend` | `boolean` | After install, re-hydrate settings from your `storageBackend` | off |
| `mathRendererLoader` | `() => Promise<MathRenderer>` | How KaTeX is loaded when no renderer is registered before the first math node renders (see "Lazy renderers and eager entries"). Once registered, the package default is never called, not even as a fallback after a rejected load, and `resetMathRenderer()` keeps the registration (0.34.0); a default load already in flight at registration still fills the slot (pre-existing, see `setMathRendererLoader`), so register before the first math render | `utils/math-default-loader`'s `import('katex')`, JS only; CSS stays yours |
| `identityGenerator` | `() => string` | The synchronous generator behind the default "tater" display name when no `identityProvider` is installed | A built-in 16 x 16 word pool of the same `adjective-noun-tater` shape; Plannotator registers the full dictionary via `utils/identity-tater` |
| `alertIconRenderer` | `(name: string) => ReactNode | null` | The icon rendered for a GitHub alert whose title line carries `<!-- icon: name -->` (0.38.0; grammar in `utils/alertTitle`). Called only for a title line with an icon comment and no leading emoji; a null return falls back to the type icon | `null` for every name: the type's own icon, the package bundles no icon set |

### Interface details worth knowing

**`StorageBackend`** — must be **synchronous** (`getItem`/`setItem`/`removeItem` return immediately). If Workspaces' real store is async (KV, D1, a Durable Object), back this with an in-memory cache that you hydrate before mounting the UI, and write through asynchronously. That's also what `loadSettingsFromBackend: true` is for — it re-reads settings from your backend right after install, once it's in place.

**No cookies on a configured host.** Settings resolution is **lazy** (first settings access, not module import). Plannotator's default backend is cookies (its servers run on random ports, so cookies are the only storage that survives across sessions there), and on first resolution the store seeds missing defaults — including a generated identity — into whatever backend is live. Because `configurePlannotatorUI` installs your `storageBackend` before anything reads a setting, a host that configures at startup gets **zero `plannotator-*` cookies** written to its origin, ever: all reads and seeding writes go to your backend. (Covered by `config/configStore.lazyInit.seam.test.ts`.) Only an unconfigured consumer — or one that reads settings before calling configure — falls back to cookie writes.

> **⚠️ Ordering is load-bearing and nothing enforces it.** Call `configurePlannotatorUI` only **after** your settings hydration has completed. If you configure while the cache is still empty, `loadSettingsFromBackend` finds nothing, **seeds generated defaults into your backend via `setItem`** (including a freshly generated random display name), and nothing ever re-runs hydration — so the junk defaults can win over the user's real settings, and if your `setItem` writes through to durable storage they persist. The sync-and-prehydrated rule is a contract, not a runtime check. (For `localStorage`, which is already synchronous, none of this bites.)

**`IdentityProvider`** — `getIdentity(): string` (display name), `isCurrentUser(author): boolean`, and optional `isEditable(): boolean` (default editable). For Workspaces this is your auth'd user. **Return `isEditable() => false`** for logged-in users: Workspaces stamps the author from the server-side account id and users can't rename themselves, so the UI must hide its rename/regenerate controls — otherwise a locally-chosen name diverges from the server-stamped author (the "split author" hazard). Two things to know from the Workspaces side: (1) the current `Me` projection (`GET /v1/me`) carries only `user_id` + `email` — **no display name** — so until the backend adds a name field, `getIdentity()` can only return the email or id; (2) free-text author names *are* accepted for anonymous commenters on open docs, so `isEditable()` may return `true` for that branch.

**`UploadTransport`** — `upload(file: File): Promise<{ path: string; originalName? }>`. The default does Plannotator's `POST /api/upload` and returns the server path. For Workspaces, send the bytes to your asset API (`PUT /v1/workspaces/:wsId/assets/:assetPath`) and return the content-addressed URL (or an opaque ref) in `path`. Notes from the Workspaces asset layer: your API makes the **caller choose the asset path** and 409s if a document owns it, so your adapter — not the UI — owns path selection (namespace uploads, e.g. an `assets/` prefix); it enforces a **10 MiB cap + content-type allowlist**, so surface upload failures; and because asset URLs need **no signing** (content-addressed, served from the cookieless `tot.page` origin), `imageSrcResolver` can be a pass-through — returning a full URL in `path` renders directly (the default resolver passes http(s) URLs through).

**`DraftTransport`** — `load()`, `save(body, { keepalive })`, `remove(generation, { keepalive })`. The generation-gated tombstone and keepalive retry logic stay inside the hook; you only provide the three transport calls. `keepalive: true` means "best-effort deliver this even though the page is closing" (maps to `fetch(..., { keepalive: true })` or `navigator.sendBeacon`). One non-obvious contract on `load()`: it returns `{ data, generation }`, where `generation` is the **deletion tombstone counter** for the no-draft case — Plannotator's server encodes it in the 404 body so a stale tab can't resurrect a deleted draft. If your backend tracks draft deletions, return the tombstone generation with `data: null`; if it doesn't, return `{ data, generation: null }` and the hook still works (you just lose stale-tab deletion protection).

**`ExternalAnnotationTransport<T>`** — `subscribe(onEvent, onError) => unsubscribe`, `getSnapshot(since) => { annotations, version } | null` (return `null` for "no changes", i.e. the 304 case), plus `add/remove/update/clear`. For Workspaces this is your realtime layer — a Durable Object WebSocket or SSE fanning out comment events. `T` extends `{ id: string; source?: string }`; if your annotation type adds fields, call `setExternalAnnotationTransport<YourType>()` directly for full type safety (the `configure` front door pins the base type for ergonomics).

**`AITransport`** and **`FileTreeBackend`** currently return `Response` objects** (the raw `fetch` response) rather than parsed domain types — `session/query` return `Promise<Response>`, `loadTree/loadVaultTree` return `Promise<Response>` whose JSON is a known shape. **This is a known rough edge** (see "Known rough edges"). To satisfy these today, Workspaces has to hand back something `Response`-shaped (status, `.json()`, and for `query`, an SSE body stream). It works, but it leaks the old HTTP contract. We deliberately left it as-is for the first cut (move-don't-rewrite); expect to clean it up in a v2 driven by what's actually painful when you wire it.

---

## How Workspaces consumes it

```bash
npm install @plannotator/ui @plannotator/core
```

```ts
// app entry, once at startup
import { configurePlannotatorUI } from "@plannotator/ui/configure";
import "@plannotator/ui/styles.css";

// load fonts (the stylesheet references --font-sans / --font-mono but ships no binaries)
import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
// …or provide your own fonts and set --font-sans / --font-mono to match.

configurePlannotatorUI({
  storageBackend,                 // your settings store (localStorage is already sync)
  identityProvider,               // your auth'd user (isEditable:false for logged-in users)
  imageSrcResolver,               // your asset URL scheme (pass-through for content-addressed URLs)
  uploadTransport,                // upload pasted images to your R2 asset API
  docPreviewFetcher,              // your doc store
  fileTreeBackend,                // your workspace file tree + realtime watch
  draftTransport,                 // your draft store
  externalAnnotationTransport,    // adapt your Yjs/WebSocket realtime onto this
  // aiTransport,                 // omit — Workspaces has no AI backend yet (stays default/off)
  serverSync,                     // your settings push
  loadSettingsFromBackend: true,  // re-hydrate settings from storageBackend after install
});
```

```ts
// then render the components you want
import { Viewer } from "@plannotator/ui/components/Viewer";
```

A few component-specific behaviors (e.g. an "open this diff in the editor" action) are passed as **props** at the render site rather than through `configure` — those are local to one component, not app-global.

### Mapping the seams to Workspaces' actual stack

Grounded in a read of the Workspaces repo (`apps/app`, `apps/usercontent`, `apps/web`, the DocumentDO). The web app doesn't import this UI yet, so this is the greenfield wiring plan.

| Seam | Workspaces backing | Effort |
|---|---|---|
| `storageBackend` | `window.localStorage` — already synchronous, matches the seam as-is. (Server-syncing prefs later is optional; not needed for the seam.) | trivial |
| `identityProvider` | Read the already-hydrated `me` from `SessionContext` (`GET /v1/me`). `getIdentity()` returns email/id (no name field yet), `isCurrentUser(a) = a === me.user_id`, `isEditable() => false` for logged-in users. | thin adapter |
| `imageSrcResolver` | Pass-through — asset URLs are content-addressed and need no signing. | trivial |
| `uploadTransport` | `PUT /v1/workspaces/:wsId/assets/:assetPath` → R2 (`AssetBytes` interface). Adapter owns asset-path selection. | new adapter |
| `docPreviewFetcher` | `GET /v1/workspaces/:wsId/documents/:docId` (D1 + git content store). | thin adapter |
| `fileTreeBackend` | `GET /v1/workspaces/:wsId/documents` (D1 doc list); live-watch via the DocumentDO. | thin adapter |
| `draftTransport` | KV or a per-doc Durable Object; `sendBeacon` for keepalive. | thin adapter |
| `externalAnnotationTransport` | **Transport kind differs** — Workspaces realtime is Yjs-over-WebSocket (DocumentDO), and comments are REST with no live push. Adapt comment events onto the DO awareness channel (or add an SSE endpoint). | biggest adapter |
| `aiTransport` | **No AI backend exists** in Workspaces. Leave at default/off until one is built. | new infra (later) |
| `serverSync` | A Worker endpoint that persists the settings delta. | thin adapter |

**Backend follow-up (Workspaces side, not a UI change):** if you want readable author names instead of raw `user_…` ids in comments, the `Me`/annotation projections need to start carrying a display-name field (WorkOS has `first_name`/`last_name`; the current `Me` projection drops them).

---

## Supported imports (the allowlist)

The exports map is broad (wildcards over `./components/*`, `./hooks/*`, `./utils/*`), because Plannotator's own apps consume the package too. **Importable is not the same as supported for a host.** A number of exported modules still call Plannotator's local server directly, with no seam — they exist for Plannotator's plan-review/code-review apps and will break (failed fetches to `/api/*` on your origin) if a host renders them. (The wildcards aren't even literally complete: a handful of `.ts` files under `components/` don't resolve through the `*.tsx` pattern — e.g. `components/diagramLanguages`. Everything in the supported table below resolves; stay on the list.)

We deliberately did **not** restructure the exports map in this PR (move-don't-rewrite); this list is the contract instead.

### Supported — safe for a host that configures the seams

| Import | Notes |
|---|---|
| `configure` (`configurePlannotatorUI`) | The front door. Also re-exports **every seam contract type** (`StorageBackend`, `IdentityProvider`, `UploadTransport`/`UploadResult`, `DraftTransport`, `ExternalAnnotationTransport`/`ExternalAnnotationEvent`, `AITransport`, `FileTreeBackend`/`VaultNode`, `ImageSrcResolver`, `DocPreviewFetcher`/`DocPreviewResult`, `ServerSyncFn`) so host adapters need one import. |
| `theme` / `styles.css` | Theme tokens + precompiled stylesheet. **Prefer `styles.css`.** The raw `theme` export still `@import`s KaTeX (re-acquiring the fonts `styles.css` deliberately excludes, as separate lazy files) and contains Tailwind v4 `@theme` at-rules, so it's inert without Tailwind processing. |
| `types` | `Annotation`, `Block`, `AnnotationType`, etc. |
| `utils/parser` (`parseMarkdownToBlocks`, `exportAnnotations`) | Pure — no backend. |
| `components/BlockRenderer` + the block components it renders (`TableBlock`, `HtmlBlock`, `Callout`, `MermaidBlock`, `MathBlock`, …) | Pure rendering. |
| `components/InlineMarkdown` | Code-file hover previews route through the `docPreviewFetcher` seam. Wiki-link rendering takes the sync `resolveLinkedDoc` prop (live labels + deleted-doc treatment; see "Wiki-link seams (0.27.0)"). |
| `components/Viewer` | The full annotatable document. Required props: `markdown` and `taterMode` (pass `false`). **Pass `disableCodePathValidation` unless you implement `/api/doc/exists`** — code-path validation is a prop-level opt-out, not a `configure` seam. `annotationHeader={{ onInputMethodChange, onModeChange, hideQuickLabel? }}` opts into one Viewer-owned, in-flow header containing the compact annotation controls and existing document actions. It reserves its measured responsive height, preserves all document badges, and follows `stickyActions` as one unit; omit it for the legacy action bar. Compact mode contains no help link. `hideQuickLabel` still requires the host to clamp restored mode state away from `'quickLabel'`. A host-owned scroll element must be supplied through `ScrollViewportProvider` (`hooks/useScrollViewport`) so stuck chrome and anchor clearance use the real scroller. |
| `components/MarkdownEditor` | Theme-bridging wrapper over `@plannotator/markdown-editor`. Takes CM6 extensions via the `extensions` prop (captured ONCE per `documentId` — see "Wiki-link seams (0.27.0)") and re-exports `wikiLinks`, `embedPicker`, `embedSlashItem`, `planEmbedInsert`, and their public types. |
| `components/MarkdownDiff` | Theme-bridging wrapper over `@plannotator/markdown-editor`'s frozen two-revision diff. Same shim pattern as `components/MarkdownEditor` (ThemeProvider bridge, `extensions` passthrough, grid card chrome); never editable. See "Frozen markdown diff (0.28.0)". |
| `components/CommentPopover` | Anchor capture + comment entry. Ask-AI UI renders only if you pass `onAskAI`. |
| `components/AnnotationPanel` | Renders from your annotation state; no fetches of its own. |
| `components/AnnotationToolstrip` | The annotation mode toolstrip (Select / Pinpoint / Markup / Comment / Redline / Label). **Pass `showHelpLink={false}` in a host** — the default help modal embeds Plannotator's own YouTube walkthroughs. `hideQuickLabel` omits only the Label button (`StickyHeaderLane` forwards it, so the pinned scroll header matches); it hides the control, it does **not** clamp the mode — keep host mode state out of `'quickLabel'` (including preferences restored through `utils/editorMode`, which accepts it from storage) or text selection silently opens the quick-label picker with no visible cause. `hideInputMethodSwitch` likewise omits the pinpoint/drag switch. *(Blessed in 0.35.0.)* |
| `components/StickyHeaderLane` | The backward-compatible standalone ghost lane used by Plannotator beside Viewer's legacy action bar. Defaults remain hidden/inert at rest and visible only while stuck, including the incumbent hidden chrome during its fade. Its `visibility="always"` mode remains a zero-height overlay and therefore requires host-owned clearance. New hosts that need a visible in-flow header should use `Viewer.annotationHeader` instead; it owns both clusters and their clearance. **The `visibility="always"` / `sticky={false}` pair is soft-deprecated as of 0.37.0**: it shipped in 0.36.0, its one intended consumer moved to `Viewer.annotationHeader` before adopting it, and it has no known consumers. It is retained for compatibility and still tested, but do not build new integrations on it. `sticky={false}` uses normal-flow positioning, creates no intersection observer, and must be paired with `visibility="always"`. Wide active-label, tight icon-only, and narrow stacked fallbacks remain measurement-driven, and `hideQuickLabel` still forwards to the compact toolstrip. |
| `components/ThemeProvider` | Color-mode context. |
| `theme-modes` (`THEME_MODES`, `Mode`) | The supported Light/Dark/System catalog and mode type. `Mode` also remains exported from `components/ThemeProvider` for compatibility with existing consumers. |
| `components/ImageThumbnail` / `getImageSrc` | Routes through `imageSrcResolver`. |
| `components/AttachmentsButton` | Routes through `uploadTransport`. |
| Seam-backed hooks: `useAnnotationHighlighter`, `useAnnotationDraft`, `useCodeAnnotationDraft`, `useExternalAnnotations`, `useFileBrowser` | Their network access goes through the seams in the catalog above. |
| `config` (`ConfigStore`) | Persists through `storageBackend`. |
| `components/TableOfContents` | Pure — renders from `blocks`; pair with `useActiveSection` for scroll-spy. *(Blessed in 0.24.0.)* |
| `components/ResizeHandle` + `hooks/useResizablePanel` | Layout pair for draggable panel widths; persists the width through the `storageBackend` seam. *(Blessed in 0.24.0.)* |
| `hooks/useActiveSection` | Scroll-spy over rendered headings; no backend. *(Blessed in 0.24.0.)* |
| `hooks/useScrollViewport` | Resolves the scrolling element for viewport-aware UI; no backend. *(Blessed in 0.24.0.)* |
| `utils/annotationHelpers` | Pure annotation utilities (`getAnnotationCountBySection`, `buildTocHierarchy` + `TocItem`). *(Blessed in 0.24.0.)* |
| `components/html-viewer` (`HtmlViewer`, `projectHostThreads`, `buildPersistedHtmlAnchor`) | The raw-HTML annotation viewer: overlay-projected placed markers, pinpoint anchors, multi-target comments. Props + validated bridge protocol; no backend of its own. See "Raw-HTML annotation viewer + syntax-highlighting migration (0.29.0)" and "HTML annotation parity seams". *(Blessed in 0.29.0.)* |
| `components/HtmlSurfaceControls` | The eye / refresh / pen header controls for an HTML surface, with per-string `labels` overrides. Presentation only. See "HTML annotation parity seams". |
| `hooks/useHtmlRefresh` | Re-fetch a rendered HTML document through a host-supplied `fetchSnapshot`, remount the viewer on a reload generation, acknowledge the restore report once. See "HTML annotation parity seams". |
| `shortcuts` (`useHtmlAnnotateShortcuts`, `defineShortcutScope`, the scope registry) | The declarative keyboard-shortcut engine and the per-surface scopes, including the HTML annotate scope (Mod+Shift+A toggles annotate mode, Mod+Shift+X shows/hides the tools). Pure: React plus `utils/platform`; no backend. |
| `utils/selectionActions` + `components/SelectionActionsDropdown` | The host selection-actions seam: `SelectionAction`, `SelectionActionContext`, the pure `buildSelectionActionContext`, and the dropdown `AnnotationToolbar` opens. Pure React; no backend. *(Blessed in 0.43.0.)* |
| `utils/mentions` + `components/MentionPicker` + `hooks/useMentionAutocomplete` | The `@` mention seam behind `CommentPopover`'s `mentionSource` (and, since 0.43.1, `Viewer`'s and `HtmlViewer`'s): the pure grammar (`mentionTrigger`, `mentionMatches`, `applyMentionPick`, `survivingMentions`), the portaled picker, and the keyboard state machine. Pure React; no backend. *(Blessed in 0.43.0.)* |
| `utils/composerTokens` | The comment composer's token highlight ranges: `skillTokenRanges`, `mentionTokenRanges`, `mergeTokenRanges` and `ComposerTokenRange`. Pure (no DOM, no styling) — the one place that decides which bytes of a composer's text are a token and which source wins when two claim the same ones. *(Blessed in 0.44.0.)* |
| `utils/inputMethod` (`getInputMethod`, `saveInputMethod`, `refreshInputMethodStamp`) | The per-surface pinpoint/drag input-method preference with its TTL. Persists through the `storageBackend` seam; no backend of its own. |
| `utils/codeHighlight` / `utils/codeBlockMark` / `utils/syntaxTheme` | The Shiki-based fence highlighter, swap-surviving annotation marks, and palette→Shiki theme mapping. Replaces all `.hljs` styling. *(Blessed in 0.29.0.)* |
| `utils/math` (`loadMathRenderer`, `getMathRenderer`, `getMathRendererSource`, `setMathRenderer`, `setMathRendererLoader`, `getMathRendererLoader`, `resetMathRenderer`) and `utils/math-eager` | The math renderer slot and its eager KaTeX registration. Import `utils/math-eager` for synchronous typesetting on the first commit; call `loadMathRenderer()` to pre-warm the lazy path. `resetMathRenderer()` empties the slot and keeps the registered loader; `setMathRendererLoader(null)` drops it. See "Lazy renderers and eager entries". |
| `utils/mermaid-math-slot` | Alias target only: what a host redirects Mermaid's own `katex` import to, so `$$` labels in diagrams typeset through the math slot and the host build carries one KaTeX chunk. Never import it yourself. See "Lazy renderers and eager entries", item 2. |
| `utils/identity-tater` | Side-effect entry that registers the full username dictionary into the identity generator slot. Import it only if you rely on the default tater names and want the full dictionary; a host with `identityProvider` should not. |
| `utils/mermaid` (`loadMermaidRuntime`, `getMermaidRuntime`, `getMermaidRuntimeSource`, `setMermaidRuntime`, `MERMAID_CONFIG`) and `utils/mermaid-eager` | The Mermaid runtime slot and its eager registration. Omit `utils/mermaid-eager` for the lazy path with retry, which is what Plannotator itself does since 0.40.0 (Mermaid 12); import it to register the runtime in your entry chunk at startup. See "Lazy renderers and eager entries" and "Mermaid 12 (0.40.0)". |
| `utils/mermaidTheme` (`buildMermaidThemeVariables`, `readThemeTokens`, `applyMermaidTheme`, `mermaidThemeKey`, `buildMermaidConfig`, `ensureContrast`, `buildMermaidShadow`, `DEFAULT_MERMAID_SHADOW_AMOUNT`), `utils/diagramShadow` and `utils/cssColor` | Theme-aware diagram configuration: the pure token-to-`themeVariables` mapping with its contrast guard, the palette-derived node shadow (`options.shadowAmount`, default 0.7 of Mermaid's own), the document token reader, and the cached per-`(palette, mode, shadow amount)` `initialize` step `MermaidBlock` runs before each render. Additive; with no theme tokens on the document the static `MERMAID_CONFIG` stays in force. See "Theme-aware Mermaid diagrams (0.40.0)". |

**AI is fully avoidable** — with one precision worth knowing. No AI *UI* is reachable from the supported components: `useAIChat` is imported only by `components/ai/DocumentAIChatPanel` and `useAIProviderConfig`, neither of which any supported component imports, and `CommentPopover`'s Ask-AI affordance exists only behind the optional `onAskAI` prop. `configure.ts` does statically import the `useAIChat` module (it needs `setAITransport`), but if you never use AI the hook is dead code and bundlers eliminate it — verified empirically: a standalone consumer's production bundle importing the full supported surface contains zero `/api/ai` strings. Don't import `components/ai/*` and don't pass `aiTransport`, and you ship no AI code.

### Unsupported — calls Plannotator's local server, no seam

Don't import these in a host. Each hits hardcoded Plannotator endpoints:

- `components/sidebar/VersionBrowser`, `hooks/usePlanDiff`, `components/plan-diff/*` — `/api/plan/version(s)` (Plannotator's version history; Workspaces builds its own versions UI anyway).
- `hooks/useArchive`, `components/sidebar/ArchiveBrowser` — `/api/archive/*`.
- `hooks/useAgents`, `hooks/useAgentJobs`, `components/AgentsTab` — `/api/agents/*`.
- `components/Settings`, `components/settings/HooksTab` — Plannotator-specific tabs (Obsidian vaults, hooks, integrations).
- `components/ExportModal`, `components/OpenInAppButton` — `/api/save-notes`, `/api/open-in` (Obsidian/Bear/editor integrations).
- `components/goal-setup/*` — Plannotator's goal-package scaffolding endpoints.
- `hooks/useEditorAnnotations` — `/api/editor-annotations` (VS Code extension only).
- `hooks/useLinkedDoc` — `/api/doc` directly (the `docPreviewFetcher` seam covers `InlineMarkdown`'s hover previews, **not** this full linked-doc overlay).
- `hooks/useValidatedCodePaths` — `/api/doc/exists` (this is what `Viewer`'s `disableCodePathValidation` turns off).
- `utils/sharing` — Plannotator's public paste service (share-URL feature).
- `hooks/useUpdateCheck`, `components/MenuVersionSection`, `components/PlanHeaderMenu` — Plannotator release checks.
- `utils/planAgentInstructions`, `utils/reviewAgentInstructions` — generate agent instructions that curl Plannotator's local API.
- `components/DecisionControl`, `utils/decisionSpec`, `hooks/useDismissablePopover` — session decision chrome for Plannotator's own approve/deny/exit endpoints (a host's session decisions are its own outcomes against its own backend).

If Workspaces ever wants one of these surfaces, the path is the same as everything else: add a seam to the module in a Plannotator PR, don't fork the component.

### Math rendering (KaTeX): one-time setup if you render equations

The renderer's `MathBlock` (and inline math) uses KaTeX. **KaTeX's stylesheet and its ~1.1MB of math fonts are deliberately NOT in the published `styles.css`** — bundling them would 9x the CSS for every page load, math or not. This is app-developer setup, done once; end users never touch it. Pick one:

1. **Self-hosted (recommended for production):** copy `katex/dist/katex.min.css` + `katex/dist/fonts/` to your own asset origin and add one `<link rel="stylesheet">`. No third-party dependency in your serving path; fonts download lazily, only on pages that actually render math.
2. **CDN tag:** `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@<version>/dist/katex.min.css">` in your HTML — pin `<version>` to the `katex` version in `@plannotator/ui`'s package.json so CSS and the bundled KaTeX JS stay in step. Same lazy-font behavior; adds a third-party origin.
3. **Bundler import:** `import 'katex/dist/katex.min.css';` next to your `styles.css` import — your bundler ships the fonts as separate lazy-loaded files. With npm/bun this resolves out of the box (`katex` is a dependency of `@plannotator/ui` and gets hoisted); under pnpm's strict `node_modules`, add `katex` to your own dependencies to import it directly.

If you skip all three and render math, equations appear as broken-looking raw HTML — that's the symptom to recognize. If you never render math, do nothing.

The JS side is separate and lazy by default: KaTeX's runtime is no longer on the static import graph of `MathBlock` / `InlineMarkdown`. A host that renders `Viewer` without importing `@plannotator/ui/utils/math-eager` gets the TeX source in the same wrapper for one frame, then the typeset markup once `import('katex')` resolves. See "Lazy renderers and eager entries" for the opt-back and the loader seam.

---

## The annotation anchor schema (what you're storing)

When a host persists annotations (your REST comment API), the anchor fields on `Annotation` are the de facto contract. Store them as opaque JSON and round-trip them unchanged — but you should know what they are and when they go stale.

From `@plannotator/ui/types`:

```ts
interface Annotation {
  // ...
  originalText: string;   // the exact text that was selected
  startMeta?: { parentTagName: string; parentIndex: number; textOffset: number };
  endMeta?:   { parentTagName: string; parentIndex: number; textOffset: number };
  mathTargets?: Array<{ blockId: string; tex: string; displayMode: boolean }>; // math selections only
}
```

`startMeta`/`endMeta` are **web-highlighter's DOM anchors**, captured against the *rendered* document: the tag name of the element containing the selection endpoint, the index of that element among all same-tag elements in the rendered DOM (document order), and the character offset within that element's text. They are positional, not content-addressed — they encode "the 14th `P`, character 32", not "this sentence".

**Reattachment order** (in `useAnnotationHighlighter`, when a stored annotation is re-applied to a rendered document):

1. **Math targets first** — if `mathTargets` is present, the matching KaTeX elements are located by `blockId` + exact `tex` string.
2. **Anchor restore** — `highlighter.fromStore(startMeta, endMeta, originalText, id)`. Works when the rendered DOM structure matches what it was at capture time.
3. **Text-search fallback** — if the anchors produce nothing (DOM changed shape), the hook searches the rendered text for an exact, whitespace-normalized occurrence of `originalText` and wraps it manually. This finds the **first** occurrence — if the selected text appears more than once, the highlight can attach to the wrong instance.
4. **Failure** — if the text is gone too, the hook logs a `console.warn` and applies **no highlight**. The annotation is *not* deleted: it still appears in the annotation panel and in exported feedback, it just has no visual anchor in the document body.

**What this means for a host:** anchors survive re-renders of the *same* markdown. Once the document body is edited, the anchors are best-effort — `originalText` is the real recovery key, and an annotation whose text was deleted degrades to a panel-only comment. If you build "comments follow the text through edits" on top of this (Workspaces will, with live editing), plan to re-anchor server-side or via your Yjs layer; don't expect these DOM anchors to do it.

**Honesty note:** the failure path (step 4) is exercised in real use but is **not covered by automated tests** — nothing in the suite asserts the stale-anchor behavior. Treat the described degradation as accurate-but-unverified-by-CI, and test it in your integration if you depend on it.

**Migration caveat — reference-style link resolution (#923):** `parseMarkdownToBlocks` now rewrites CommonMark reference links (`[text][id]`) and blanks their `[id]: url` definitions before splitting into blocks, so documents containing that syntax render differently than they did before this pass existed — a `[text][id]` pair that used to render as literal bracket text now renders as a link, and the definition line disappears from the rendered DOM entirely. That changes both the text and the per-tag DOM index at the affected positions. Any annotation whose `startMeta`/`endMeta` was captured against the *old* (pre-resolution) render of such a document — i.e. persisted before a host upgrades past this change — can restore onto the wrong text after upgrading, same as any other DOM-structure change described above; the text-search fallback (step 3) is the recovery path, and `originalText` is what to fall back to if you need to re-anchor server-side.

---

## Known rough edges (and why they're fine for now)

1. **`AITransport` / `FileTreeBackend` leak `Response`.** They return raw fetch `Response` objects instead of clean domain types (`{ sessionId }`, `AsyncIterable<AIMessage>`, `{ tree, workspaceStatus }`). A reviewer correctly flagged this. We kept it deliberately: the goal of this PR was **move-don't-rewrite**, and reshaping these contracts is exactly the kind of redesign that's better driven by the real consumer (Workspaces) once you feel the pain. Plan a v2 pass on these two once you've wired them.

2. **`InlineMarkdown.tsx` is large (~1k lines)** and now hosts the `docPreviewFetcher` seam inline. Cheap future cleanup: extract the doc-preview seam into its own module so the renderer shrinks. Not blocking.

3. **Module-level singletons, not a Provider.** Covered above — safe because Workspaces is client-side, not SSR. Only revisit if SSR is added.

4. **~~The markdown editor can't take live-collab extensions yet.~~ RESOLVED in 0.27.0.** The plan of record shipped exactly as written: `@plannotator/atomic-editor` ≥0.7.0 and `@plannotator/markdown-editor` ≥0.3.2 thread an optional `extensions?` prop through to the CM6 editor, and the ui shim now declares and forwards it (see "Wiki-link seams (0.27.0)"). You can thread `y-codemirror.next` — or any CM6 extension, e.g. `wikiLinks` — through `components/MarkdownEditor`. Mind the capture-once-per-`documentId` caveat.

None of these block adoption. They're the honest "here's what we'd polish next" list.

---

## UI engine: Base UI (0.23.0)

As of `0.23.0`, `@plannotator/ui` is built on **Base UI** (`@base-ui/react@^1.6.0` — caret, so your own Base UI install dedupes against ours; two copies would break context across portals) instead of Radix. This follows shadcn/ui making Base UI its default engine (July 2026). The migration was deliberate and whole-package: **zero `@radix-ui/*` packages remain** — no mixed engines. Per-component reports with hand-verification checklists live in `packages/ui/.migration/`.

### Dependency changes

- Removed dependencies: `@radix-ui/react-dialog`, `react-dropdown-menu`, `react-popover`, `react-slot`, `react-tabs`, `react-tooltip`.
- Added dependency: `@base-ui/react@^1.6.0` (regular dependency — installs transitively, nothing for you to add).
- **Peer dependency removed: `tailwindcss-animate`.** The kit's enter/exit animations are now CSS-transition-based (Base UI's `data-starting-style`/`data-ending-style`), so the plugin is no longer used. If your Tailwind config loaded it only for this package, you can drop it. Remaining peers are unchanged: `react`, `react-dom`, `tailwindcss`.

### Breaking API changes in 0.23.0 (what a consumer must change)

1. **`asChild` → `render`, everywhere.** `<Button asChild><a/></Button>` becomes `<Button render={<a/>}>label</Button>` (children go on the wrapper, element props on `render`). Applies to `Button`, `Badge`, `DialogTrigger`/`DialogClose`, `DropdownMenuTrigger`, `PopoverTrigger`, and tab parts.
2. **Menu item selection:** `onSelect(event)` no longer exists. Use `onClick`; to keep the menu open after a click (the old `event.preventDefault()` idiom), pass `closeOnClick={false}`. `textValue` → `label`.
3. **`DropdownMenuCheckboxItem` / `DropdownMenuRadioItem` no longer close the menu on click by default** (Base UI defaults `closeOnClick` to `false` for these two; plain `DropdownMenuItem` still closes). Pass `closeOnClick` explicitly for the old behavior. `checked="indeterminate"` is gone (boolean only).
4. **`DropdownMenuLabel` must be nested inside a `DropdownMenuGroup`** (it wires `aria-labelledby`); a free-floating label was legal under Radix.
5. **`PopoverAnchor` export removed.** Base UI has no Anchor part; anchored positioning is a Positioner concern (if you need a custom anchor, ask for a seam — do not fork the wrapper).
6. **Content-level focus/dismiss callbacks are gone.** `onOpenAutoFocus`/`onCloseAutoFocus` → `initialFocus`/`finalFocus` props (element/ref/boolean, on `DialogContent`/`PopoverContent`/`DropdownMenuContent`). `onEscapeKeyDown`/`onPointerDownOutside`/`onInteractOutside` → the Root's `onOpenChange(open, eventDetails)`: branch on `eventDetails.reason` (`'escape-key'`, `'outside-press'`, `'focus-out'`) and call `eventDetails.cancel()` to block the close.
7. **`onOpenChange` gains a second `eventDetails` argument** on every overlay Root. Existing single-arg handlers keep compiling and working.
8. **Styling hooks changed.** `data-[state=open/closed]` → `data-open`/`data-closed`; triggers expose `data-popup-open`; active tab is `data-active` (was `data-[state=active]`); highlighted menu items are `data-highlighted` (items are no longer DOM-focused, so `focus:` variants on menu items do nothing). CSS vars: `--radix-<comp>-content-transform-origin` → `--transform-origin`, `--radix-<comp>-trigger-width` → `--anchor-width`, available-size vars → `--available-width`/`--available-height`.
9. **Tabs behavior:** arrow keys now move focus WITHOUT activating (Base UI's manual-activation default; pass `<TabsList activateOnFocus>` for the Radix feel), and an uncontrolled `Tabs` activates its first tab by default (Radix activated none).
10. **Tooltip:** `children` must be a single React element (was loosely typed). Unset-delay defaults shift: open delay 700ms → 600ms, skip-window 300ms → 400ms (irrelevant if you set them via `TooltipProvider`). `TooltipProvider` deliberately KEEPS the Radix-era prop names (`delayDuration`, `skipDelayDuration`, `disableHoverableContent`) and maps them internally — your provider call sites don't change.
11. **Portals render a wrapper `<div>`** (Radix portals rendered nothing extra). Only matters if you style popups via direct-child selectors on `document.body`.
12. **`Button` now defaults to `type="button"`** (Base UI's Button primitive). Under Radix it rendered a plain `<button>`, whose implicit type is `submit` — a bare `<Button>` inside a `<form>` no longer submits it. Pass `type="submit"` explicitly (it overrides the default). No in-repo forms exist; this is consumer-only.

Dialog/dropdown enter/exit animations look the same (fade+scale, 150–200ms) but are transitions, not keyframes — the subtle Radix `slide-in-from-*` nudge on menus is gone, matching the shadcn base registry look.

### What did NOT change

- Every export name (`Dialog*`, `DropdownMenu*`, `Popover*`, `Tabs*`, `Tooltip*`, `Button`, `Badge`, `PopoutDialog`, `SearchableSelect`) and the theme/token system.
- The seam catalog and `configurePlannotatorUI()` — the engine swap is invisible to the backend seams.
- The strict-consumer TS gate (`tsconfig.strict-consumer.json`) stayed green throughout; your `tsc --noEmit` should too.

Re-verify your seam contract against `0.23.0` before adopting; the list above is exactly what to test against.

---

## Consumer enablement (0.24.0)

Six items accumulated through Workspaces' first three integration slices. All are additive; every default reproduces 0.23.0 behavior.

1. **`AnnotationPanel` host props.** `renderCardFooter?: (annotation) => ReactNode` — a per-card slot at each plan-annotation card's foot (plug reply/resolve UI in; clicks inside the slot don't select the card). `readOnly?: boolean` — hides the built-in mutation affordances (delete/edit on all card kinds); selection and scrolling still work, and as of 0.30.0 the host footer slot still renders (see "Unanchored-annotation reporting + readOnly footer fix (0.30.0)").
2. **Six more supported imports** (already in the table above, tagged *Blessed in 0.24.0*): `TableOfContents`, `ResizeHandle` + `useResizablePanel`, `useActiveSection`, `useScrollViewport`, `utils/annotationHelpers`. All verified under the strict-consumer gate.
3. **`Viewer`/`CommentPopover` `allowImages?: boolean`.** Pass `false` when you have no `uploadTransport` — the attach-image affordance disappears instead of dead-ending. (CommentPopover already had the prop; Viewer now exposes and threads it.)
4. **`Viewer` `readOnly?: boolean`.** View-only users: suppresses every composer entry point (selection toolbar, comment popovers, quick labels, pinpoint, global comment, attachments, checkbox toggles) while existing annotations still render and select.
5. **Stricter consumer gate.** `tsconfig.strict-consumer.json` now also enforces `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters` — the shipped source passes them, so you no longer have to relax those flags in your own tsconfig.
6. **Content-verifying restore (opt-in).** `useAnnotationHighlighter({ verifyRestoredContent: true, onRestoreMismatch })`: a position-based restore that resolves onto the wrong text (document drift) is removed and re-anchored by text search; if the original text is gone entirely, `onRestoreMismatch(annotation, restoredText)` fires and nothing is painted. Default off. If you built a host-side guard for this, you can delete it.

---

## HtmlViewer rendering neutrality (0.25.0)

`HtmlViewer` no longer writes into a rendered document's namespace (Workspaces' upstream brief; supersedes the H-ask-1 patch — delete it on adoption). Arbitrary HTML now renders exactly as in a standalone browser tab:

1. **No bare token injection.** Host theme tokens travel only as viewer-owned `--pn-*` properties (srcdoc block and the bridge's theme handler, which now refuses non-`--pn-` writes). A document defining `--muted`/`--background`/etc. keeps its own values in both host themes.
2. **No root mutations.** The `light` class toggle and the `color-scheme: light` injection are gone for arbitrary documents; light/dark resolves from the document + OS.
3. **Diff CSS gated and scoped.** `<ins>`/`<del>` styles are injected only while `diffActive` and target `ins.plannotator-diff`/`del.plannotator-diff`. If your host renders its own version-diff HTML through the viewer, tag the generated wrappers with `class="plannotator-diff"`; author-written `<ins>`/`<del>` markup is never restyled.
4. **Host theming is opt-in per document.** `<meta name="plannotator-theme" content="host">` in the document's head restores the bare-token push, the `light` root class, and a symmetric `color-scheme` sync — for that document only. Documents relying on the old implicit override must add the tag.

The contract is pinned by `components/html-viewer/srcdoc.test.ts` (no bare custom-property declarations, no `color-scheme`, `--pn-*`-only bridge writes, scoped diff selectors).

---

## Resize-handle seams + file-browser filtering (0.26.0)

Two additive changes; every default reproduces 0.25.0 behavior.

1. **Resize-handle host seams** (`ResizeHandle` + `useResizablePanel`, both already blessed). For hosts that want different edge interactions:
   - `ResizeHandle` new props: `hideHoverTrack?: boolean` (suppress the hover color-reveal entirely), `trackClassName?: string` (restyle the inner 4px track — `className` only reaches the outer wrapper), and `tooltip?: ReactNode` (cursor-following hint, portaled to `document.body`, hidden mid-drag). The track also carries a `[data-resize-track]` attribute (same host-CSS pattern as `[data-collapse]`), so you can kill the hover reveal from plain CSS: `[data-resize-track] { background: none !important; }`.
   - `useResizablePanel` new options: `onClick?: () => void` and `clickThreshold?: number` (default 4). `onClick` fires on pointer-up only when the pointer never traveled past the threshold — the hook owns the pointer state machine, so this is the only reliable way to tell a click from a drag-start. Use it to make the whole handle a click-to-collapse target. It never fires on a snap-close or on `pointercancel` (aborted gestures — palm rejection, system gestures — only clean up drag state). When `onClick` handles a click, the width is left untouched (not committed/persisted).
   - Plannotator's own apps now wire these into a new handle UX (no hover track, cursor tooltip, single-click collapse). The package defaults are unchanged — pass nothing and 0.25.0 behavior is exactly preserved.
   - `packages/ui/README.md` § "Resize-handle seams" documents the same from the host's perspective.
2. **File-browser filtering** (`FileBrowser`, reached via `useFileBrowser`). A built-in filter row above the tree: whitespace-separated tokens AND-match case-insensitively against each file's name (with and without extension) and path (backslashes normalized); folders match on their own name too. While filtering, folders are force-expanded (and non-interactive) and directory collapse state is ignored; Escape clears the query, then closes the input. No new props — consumers get it for free. Behavior pinned by `components/sidebar/FileBrowser.test.ts`.

---

## Wiki-link seams (0.27.0)

Consumer-enablement round for wiki-links (Workspaces' `[[doc_01XYZ|label]]` links over opaque doc ids). Three additive seams plus a housekeeping fix; every default reproduces 0.26.0 behavior.

1. **`MarkdownEditor` `extensions` passthrough.** The shim (`components/MarkdownEditor`) now declares `extensions?: readonly Extension[]` (`Extension` from `@codemirror/state`) and forwards it through `@plannotator/markdown-editor` into the CM6 engine, appended after the built-ins. This is the seam for `wikiLinks(config)`, `y-codemirror.next` collab bindings, custom keymaps (wrap in `Prec.high` to beat built-ins), etc.

   > **⚠️ Captured ONCE per `documentId` — not reactive.** The engine reads the array a single time, when it mounts the document. Swapping in a different array later is **silently ignored** until the next remount (a `documentId` change). Pass a stable reference (module constant or `useMemo` keyed on `documentId`), and never encode changing data in the array itself — extension config callbacks may close over live state (refs/getters); that is the supported way to feed dynamic data into a mounted editor.

   Build extensions against **your own** `@codemirror/*` install: both editor packages declare `@codemirror/state` as a peer, so there is one shared copy — a second copy breaks the editor. Seam pinned end-to-end by `components/MarkdownEditor.extensions.test.tsx` (a facet-based probe mounted through the shim reaches the engine DOM).

2. **`wikiLinks` re-exported through the ui surface.** Hosts must not import `@plannotator/atomic-editor` (outside the import allowlist); `@plannotator/ui` is the single contract. `components/MarkdownEditor` re-exports `wikiLinks` and its types — `WikiLinksConfig`, `WikiLinkSuggestion`, `WikiLinkResolvedTarget`, `WikiLinkStatus`. Usage: build `wikiLinks(config)` and pass it via the `extensions` prop. The config callbacks (`suggest`, `resolve`, `onOpen`) may close over live state — see the capture-once caveat above. Engine 0.7.0's `preferResolvedLabel?: boolean` flag (labeled `[[target|label]]` links opt into showing the resolved title instead of the stored label) is part of the re-exported `WikiLinksConfig`.

3. **`InlineMarkdown` `resolveLinkedDoc`.** Synchronous host resolution of wiki-links in the *viewer*:

   ```ts
   resolveLinkedDoc?: (target: string) => { label?: string; status?: 'active' | 'deleted' } | null;
   ```

   - Callback absent, or returning `null` → exactly the previous rendering (stored label, live link).
   - `label` → displayed instead of the stored label; the stored label is the fallback, the raw target the last resort.
   - `status: 'deleted'` → a muted, struck-through **non-link** span titled "Document deleted" — no anchor, no pointer, no link icon, and `onOpenLinkedDoc` is not wired — even when `onOpenLinkedDoc` is passed.
   - The callback receives the **raw stored target** (`doc_01XYZ`), *before* the `.md`-appending path normalization; `onOpenLinkedDoc` keeps receiving the normalized path (`doc_01XYZ.md`) for non-deleted links, unchanged.
   - **Sync-only by design** — back it with an in-memory cache you keep hydrated. There is deliberately no async variant, no loading state, no phantom-doc creation, no backlink machinery.

   Behavior pinned by `components/InlineMarkdown.resolveLinkedDoc.test.tsx`, including `null` → byte-identical `innerHTML`.

4. **H-ask-1 retired.** The two one-line TS6133 fixes Workspaces carried against `components/html-viewer` (unused `React` default import in `HtmlViewer.tsx`; unused `annotations` destructured binding in `useHtmlAnnotation.ts`) are applied at source. The shipped html-viewer files pass `tsc` under the strict-consumer flags (`--noUnusedLocals` included) — **delete your patch on adoption.**

**Dependency note:** 0.27.0 requires `@plannotator/markdown-editor ^0.3.2` (adds `extensions`) and `@plannotator/atomic-editor ^0.7.0` (adds `wikiLinks` + `preferResolvedLabel`).

---

## Embed media picker (0.31.0)

The package now owns the reusable two-stage `/embed` authoring flow. The host still owns its target catalog, serialized embed grammar, and upload UI/API. This is a per-editor extension seam, not a `configurePlannotatorUI()` backend seam.

1. **Single supported import.** `components/MarkdownEditor` re-exports `embedSlashItem()`, `embedPicker(config)`, `EmbedKind`, `EmbedTarget`, `EmbedPickerConfig`, `planEmbedInsert()`, and `EmbedInsertPlan`. Do not import the nested picker module, `@plannotator/atomic-editor`, or `@plannotator/core` directly from a host.

2. **Compose both stages.** Add the static item to `slashCommands()` and register the picker beside it:

   ```tsx
   import {
     MarkdownEditor,
     embedPicker,
     embedSlashItem,
     slashCommands,
   } from "@plannotator/ui/components/MarkdownEditor";

   const editorExtensions = [
     slashCommands({ items: [embedSlashItem()] }),
     embedPicker({
       getTargets: () => currentTargets,
       buildInsertLine: (target) => buildHostEmbedLine(target),
       uploadTarget: async (kind) => uploadHostTarget(kind),
       getNotice: (docBody) => currentEmbedNotice(docBody),
     }),
   ];

   <MarkdownEditor extensions={editorExtensions} {...editorProps} />;
   ```

   The static item rewrites `/query` to `/embed ` and reopens completion. The picker then performs case-insensitive substring matching over target titles and paths. It deliberately returns `filter: false` so multi-word titles remain in the session.

3. **Captured once, callbacks stay live.** The `extensions` array is still captured once per `documentId`. Keep the extension reference stable and close `getTargets`, `buildInsertLine`, `uploadTarget`, and `getNotice` over live refs or route state. Do not rebuild the array merely because target data changed.

4. **Grammar belongs to the host; splicing belongs to the package.** `buildInsertLine(target)` returns the exact line the host wants stored. `planEmbedInsert()` then normalizes that line into its own blank-line-delimited paragraph and places the caret on the following line. Host-specific path resolution, label escaping, and embed-fragment grammar stay outside the package.

   **Host labels (0.45.1).** `EmbedPickerConfig.labels?: { upload?: string; empty?: string; noMatch?: (query: string) => string }` replaces the three rows that name the target type ("Upload HTML...", "No HTML files in this workspace", "No HTML files match “<query>”") for a host that feeds the picker more than HTML files. Each absent key keeps the built-in text, so a host passing nothing (Plannotator) renders exactly the menu it always did. The "Uploading..." row and the notice row are unchanged.

5. **Upload is optional and single-flight.** When `uploadTarget` is absent, no upload row is rendered. When present, every picker state includes `Upload HTML...`. While its promise is pending, the typed `/embed` text stays visible and a reopened picker shows an inert `Uploading...` row. Resolving with a target inserts it through `buildInsertLine` and the same splice as an existing target; resolving `null` or rejecting leaves the typed command untouched. The package maps the anchor through CodeMirror transactions and silently drops the insert if the command was edited away. The host owns all failure UI.

6. **One CodeMirror dependency graph.** The picker imports `@codemirror/autocomplete`, `@codemirror/state`, and `@codemirror/view` from `@plannotator/ui`'s declared dependencies. `@plannotator/atomic-editor` declares these as peers, so a consumer must resolve one shared copy. A second live copy of `@codemirror/state` breaks extensions just as it does for `wikiLinks`.

Behavior is pinned by `components/MarkdownEditor.embedPicker.test.ts`, the supported re-export by `components/MarkdownEditor.embedPicker.reexport.test.ts`, and the pure splice planner by `../core/embed-insert.test.ts`.

---

## Lazy renderers and eager entries (0.32.0)

Four modules that used to ride every document read for a host that bundles by route now load on demand: the Mermaid runtime, the Graphviz engine, KaTeX, and the username dictionary. Plannotator's own apps register KaTeX and the dictionary eagerly in both the plan editor and the review editor, and through 0.39.0 the plan editor also registered the Mermaid runtime eagerly (the review editor never renders a Mermaid block and deliberately does not), so every surface rendered exactly as before; the single-file builds were unchanged in size and first paint and the portal entry chunk kept Mermaid as on main (the built-HTML markers and the A/B proof live in `tests/entry-assets.test.ts` and the PR that shipped this). **Since 0.40.0 the plan editor takes the lazy Mermaid path too** — see "Mermaid 12 (0.40.0)" for why and for the host contract; the paragraph below describes the slot, which is unchanged.

1. **Graphviz: no seam, nothing to do.** `GraphvizBlock` imports `@viz-js/viz` inside its render effect. It already showed the source fence until the SVG landed, so the only change for a chunking host is that the first dot fence on a page fetches the engine. A failed import is dropped from the memo and re-attempted once with a fresh `import()` after a short delay; a persistently failing chunk surfaces as the existing error panel with the source, plus a Retry button that issues another fresh attempt (a diagram syntax error shows the panel exactly as before, without Retry). Hosts that aliased the specifier to a lazy shim can delete the shim.

   **Mermaid: a runtime slot, filled eagerly by Plannotator.** `utils/mermaid` holds the slot (`getMermaidRuntime`, `setMermaidRuntime`, `getMermaidRuntimeSource`) and the one code path `MermaidBlock` uses, `loadMermaidRuntime()`: it resolves at once from a filled slot and otherwise imports `mermaid` lazily, initialized once with `MERMAID_CONFIG` (`securityLevel: 'strict'` pinned by test), with the same drop-on-rejection, one automatic re-attempt and Retry button as Graphviz. `utils/mermaid-eager` imports the runtime statically, initializes it at module evaluation (where the old module-scope `initialize` ran) and fills the slot; through 0.39.0 `packages/editor/App.tsx` imported it by policy, so Plannotator's plan surfaces kept Mermaid in their entry chunk and it could never fail separately from the app. Since 0.40.0 neither Plannotator app imports it (Mermaid 12's runtime is too large to ride every plan read; `tests/entry-assets.test.ts` now asserts the eager marker is ABSENT from both bundles). A host that wants startup registration adds `import '@plannotator/ui/utils/mermaid-eager'`; a host that omits it gets the lazy path, exactly like Plannotator.

   **Retry, honestly.** An in-page retry cannot recover a chunk whose first fetch failed: browsers record a failed module fetch in the module map for the page lifetime, so a fresh `import()` of the same URL rejects without a request, and package code cannot re-import under a new URL because Rollup minifies the chunk's export names. The retry therefore recovers failures after the fetch (engine instantiation, `initialize`) and hosts that version chunk URLs; a host that needs recovery from a failed first fetch uses versioned chunk URLs or a `vite:preloadError` reload at app level. The panel with the source is always shown, never a blank.

2. **KaTeX: a renderer slot, filled eagerly by Plannotator.** `utils/math` holds a synchronous slot (`getMathRenderer`, `setMathRenderer`, `subscribeMathRenderer`), an idempotent `loadMathRenderer()` whose default loader is `import('katex')` (JS only; stylesheet policy is unchanged, see "Math rendering"; since 0.33.0 that default lives in its own module, `utils/math-default-loader`, see the paragraph on dropping its chunk below), and `setMathRendererLoader`. `MathBlock` and inline math read the slot during render: filled, they typeset synchronously in the same render exactly as before; empty, they render the same wrapper (`math-block` / `math-inline`, `math-annotatable`, `data-math-tex`, `data-math-display`, `aria-label`, `data-block-id`) with the trimmed TeX as a text child, load the renderer from an effect, and re-render typeset when it lands. Annotation restore and block targeting key on those attributes, so a placeholder is addressable exactly like the typeset node. `throwOnError: false` and `trust: false` are applied to every renderer, including one you register.

   **This is the one place the pass-nothing law bends.** A host that renders `Viewer` and never imports the eager entry now gets lazy math: one frame of TeX text, then typeset. The one-line opt-back for the old behavior:

   ```ts
   import '@plannotator/ui/utils/math-eager';
   ```

   The seam for the lazy path: `configurePlannotatorUI({ mathRendererLoader: () => Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default) })` puts KaTeX and its CSS on one chunk; `loadMathRenderer()` can be awaited before mounting a body that carries math if you would rather gate first paint yourself.

   **Where the default `import('katex')` lives, and how to drop its chunk (0.33.0, from 0.32.0 adoption feedback).** The default loader is `utils/math-default-loader` (`loadDefaultMathRenderer`), the package's only runtime mention of `katex` outside `math-eager`; `utils/math` calls it only while no loader is registered (`loader === null`), and a registered loader is never backfilled by it, not even after the host's load rejects (pinned in `utils/math.test.ts`). So with a loader registered the default is never *requested*. One pre-existing ordering rule still applies: a default load already in flight when the host registers its loader keeps going and fills the slot when it lands (documented on `setMathRendererLoader`), so register the loader before the first math node renders, in your entry, not in an effect. It is still *emitted*: Rollup decides chunks statically and cannot see a runtime registration, so a host build that registers a loader still carries a `katex-*.js` chunk with an `import()` site pointing at it from the package. Measured on a two-entry Vite 6 consumer of this checkout (one entry registering a loader that is not KaTeX, one registering nothing): both builds emit one 484 KB chunk carrying the KaTeX body. A host that wants that chunk gone aliases the default module at a stub, which is why it is its own module:

   ```ts
   // vite.config.ts of a host that registers mathRendererLoader
   resolve: { alias: [{ find: /^(\.\/|@plannotator\/ui\/utils\/)math-default-loader$/, replacement: '/src/no-default-math.ts' }] }
   // src/no-default-math.ts
   export function loadDefaultMathRenderer(): Promise<never> { return Promise.reject(new Error('default math loader aliased out')); }
   ```

   With the alias the same consumer build emits zero chunks carrying the KaTeX body out of the package and the entry's only `import()` in that area is the host's own loader chunk. Do not alias without registering a loader: math would then render as TeX text forever. Plannotator's entries import `math-eager`, so the slot is filled before the first render and this branch is never reached there; the single-file builds inline the default through `inlineDynamicImports` as before (`tests/entry-assets.test.ts` pins the split: `utils/math` has no `import('katex')` site, `utils/math-default-loader` has the only one).

   **Mermaid's own KaTeX, and the last shared chunk (0.34.0, from 0.33.0 adoption feedback).** The alias above is not the whole story once a page can render a Mermaid diagram. The Mermaid runtime (11.15.0 when this was written; 12.0.0 since 0.40.0, same import) typesets `$$...$$` labels through its own `import("katex")`, inside `renderKatexUnsanitized`, and it offers nothing to turn that off: `legacyMathML` / `forceLegacyMathML` only choose the output mode, the guard around the import is the `@mermaid-js/tiny` build marker, and there is no hook to hand it a renderer. The import only *runs* for a label that matches Mermaid's `$$` test, but it is *emitted* regardless, so a host that registered a loader and aliased the default still built a `katex-*.js` chunk, and because that chunk then had two dynamic importers (the host's loader module and the Mermaid runtime) Rollup kept it separate from the host's loader chunk: a math document fetched two files, the 57-byte loader chunk plus the shared 261 KB KaTeX chunk. Measured on the scratch Vite 6 consumer of this checkout (loader registered, default aliased, a document with inline math, a display block and a flowchart with a `$$` label): one chunk carried the KaTeX body before, `katex-*.js`, imported by `mermaid.core-*.js` and by the host's loader chunk; 367 JS chunks in all.

   The fix is a bundler-facing redirect to a package module, `utils/mermaid-math-slot`, whose default export has the one method Mermaid calls (`renderToString`) and delegates to whatever fills the math slot, with Mermaid's own options (`throwOnError: true`, `displayMode: true`, the MathML `output` mode) passed through untouched, so a KaTeX renderer produces exactly the markup Mermaid produced from its direct import. Redirect the `katex` specifier for importers inside the `mermaid` package ONLY; a plain `resolve.alias` on `katex` would also rewrite your own loader's import and break math everywhere:

   ```ts
   // vite.config.ts of a host that registers mathRendererLoader (beside the math-default-loader alias)
   import { fileURLToPath } from 'node:url';
   const configFile = fileURLToPath(import.meta.url);
   const mermaidKatexToSlot: Plugin = {
     name: 'mermaid-katex-to-plannotator-slot',
     enforce: 'pre',
     resolveId(source, importer) {
       if (source !== 'katex' || !importer || !/[\\/]node_modules[\\/]mermaid[\\/]/.test(importer)) return null;
       return this.resolve('@plannotator/ui/utils/mermaid-math-slot', configFile, { skipSelf: true });
     },
   };
   // plugins: [mermaidKatexToSlot, react(), ...]
   ```

   Two details of that snippet are layout-proofing. The importer test is `node_modules/mermaid/` anywhere in the path, not a pattern for one install layout: a hoisted install puts the runtime at `node_modules/mermaid/`, Bun's isolated layout at `node_modules/.bun/mermaid@12.0.0/node_modules/mermaid/`, and pnpm's at `node_modules/.pnpm/mermaid@12.0.0/node_modules/mermaid/`; every one of them ends in that segment, and the trailing separator keeps `mermaid-something` packages out. The slot module is resolved from the host's own config file (`configFile`), not from the Mermaid importer: resolving from the importer walks up from Mermaid's location, which finds `@plannotator/ui` on hoisted and Bun-isolated installs but not under pnpm's strict `node_modules`, where the package is only visible from the host root. Resolving from the config file is the same lookup the host's own imports use; passing an absolute path to the file (`path.resolve(...)` of the installed `utils/mermaid-math-slot.ts`) works too.

   With the redirect the same consumer build emits one chunk carrying the KaTeX body, the host's own loader chunk (`host-katex-*.js`, 261 KB, reached only by the entry's `import()`), `mermaid.core-*.js` has no KaTeX import left, and the chunk count drops to 366: one KaTeX chunk, owned by the host, one file fetched. The slot must be filled by the time Mermaid asks, so `MermaidBlock` awaits `loadMathRenderer()` before rendering a diagram whose source carries a `$$` label (`hasMermaidMath`, Mermaid's own regex); on a filled slot that resolves at once, on the lazy path it runs your loader, and if that load fails the label throws a message naming the cause (`MERMAID_MATH_SLOT_EMPTY_MESSAGE`) which the block's error panel shows with the source. Do not import the module yourself; it exists to be resolved to. Plannotator does not redirect: its Mermaid keeps its direct KaTeX, inlined by the single-file builds with everything else, and the pre-render wait is a resolved promise there because `math-eager` filled the slot at startup. No test in the repo renders a real Mermaid diagram with a math label (Mermaid does not render under happy-dom), and nothing in Plannotator's own documents exercises `$$` labels; the bridge is pinned by `utils/mermaid-math-slot.test.ts` (delegation with Mermaid's exact options, KaTeX parity, the empty-slot error, the label regex) and the pre-render warm by the "Mermaid math labels warm the math slot" cases in `components/DiagramBlock.lazyRetry.test.tsx`.

   **`resetMathRenderer()` keeps the loader (0.34.0).** Through 0.33.0 the reset hook also nulled the registered loader, so a host test harness that reset the slot between cases silently fell back to the package default `import('katex')` on the next render. Reset now empties the renderer and its source, forgets a load in flight (its late result no longer fills the slot; the next `loadMathRenderer()` invokes the registered loader afresh) and leaves the loader registered. `setMathRendererLoader(null)` is the explicit way back to the package default, and `getMathRendererLoader()` reads the registration; `configurePlannotatorUI` cannot unregister a loader (a `null` or absent `mathRendererLoader` is a no-op there), so only a direct `setMathRendererLoader(null)` does. `setMathRendererLoader` itself is unchanged: a load already in flight at registration still fills the slot, because the component that started it is waiting on that result. The other reset-style helpers were reviewed and are consistent with their names: `resetIdentityProvider` and `resetIdentityGenerator` reset exactly the thing they name (the provider, the generator), and Mermaid's `__setMermaidRuntimeLoaderForTests` is a stand-in by name. Pinned in `utils/math.test.ts`.

3. **Identity: a generator slot, filled eagerly by Plannotator.** `utils/generateIdentity` no longer imports `unique-username-generator`. It holds a synchronous generator slot (`setIdentityGenerator`, `getIdentityGenerator`) with a built-in fallback that produces the same `adjective-noun-tater` shape from a 16 x 16 pool. `utils/identity-tater` registers the full dictionary as a side effect and is what Plannotator's entries import. A host with `identityProvider` never calls the generator and, with the static import gone, no longer ships the word lists; delete any dictionary shim. A host that wants the full dictionary without its own provider imports `@plannotator/ui/utils/identity-tater`, or passes its own `identityGenerator` to `configurePlannotatorUI`. The slot is synchronous on purpose: `configStore` persists the first generated name to the identity cookie during the first render-time settings read, so a name that arrived later would be a visible identity change.

4. **Scope, as of 0.34.0.** 0.32.0 shipped items 1 to 3 and deliberately left two things out of the design record's list: the raw-HTML bridge script as a separately served asset, and a lazy table popout. 0.33.0 ships the first (see "HTML viewer bridge as an asset" below) and, from adoption feedback, the `utils/math-default-loader` split in item 2. 0.34.0 adds the Mermaid KaTeX redirect and the `resetMathRenderer` fix in item 2, both from 0.33.0 adoption feedback. The lazy table popout is still not shipped and stays tracked in the design record for a follow-up.

Pinned by `utils/math.test.ts`, `utils/mermaid-math-slot.test.ts`, `components/MathBlock.firstPaint.test.tsx`, `utils/generateIdentity.test.ts`, `components/MermaidBlock.test.ts`, `components/DiagramBlock.lazyRetry.test.tsx`, and the eager-entry and built-HTML marker guards in `tests/entry-assets.test.ts`.

---

## HTML viewer bridge as an asset (0.33.0)

`HtmlViewer` injects a 185 KB bridge script (`BRIDGE_SCRIPT`, `components/html-viewer/bridge-script.ts`) into every srcdoc document it renders. For a host that bundles by route that literal rode in the viewer chunk and was re-parsed by the browser per document. This release adds an opt-in, `bridgeScriptUrl`, and leaves the default untouched: Plannotator passes nothing, every Plannotator surface (the annotate srcdoc path, the version diff, PR HTML artifacts, linked `.html` docs, the share portal) still inlines the string, the live-app proxy still serves the same inline bridge from its own `/__plannotator__/bridge.js` route, the Pi and OpenCode copies are built from the same code, and the single-file bundles carry the literal exactly once as before (`tests/entry-assets.test.ts` counts it; the A/B of a Plannotator HTML annotate session on a main build against this build found identical DOM, requests and console).

**What the package ships.** `prepack` now also runs `scripts/build-bridge-assets.ts`, which derives two gitignored files beside the source module, both deterministic and both verified against the module's exports by `components/html-viewer/bridgeAsset.test.ts`:

- `components/html-viewer/bridge-script.asset.js`: byte-for-byte `BRIDGE_SCRIPT`, the runnable IIFE. Export subpath `@plannotator/ui/components/html-viewer/bridge-script.asset.js`. The `.asset.js` name is deliberate: a plain `bridge-script.js` next to `bridge-script.ts` would be picked first by Vite's extension probe for the package's own `./bridge-script` imports and break every consumer build.
- `components/html-viewer/bridge-script.lite.ts`: the same `ANNOTATION_HIGHLIGHT_CSS`, `BRIDGE_PROTOCOL_VERSION` and `LIVE_BRIDGE_BOOTSTRAP` with `BRIDGE_SCRIPT = ""`. Export subpath `@plannotator/ui/components/html-viewer/bridge-script.lite`. An alias target only (below).

The TS module stays the source of truth because the Plannotator CLI and the Pi extension import its string exports under Bun.

**Host wiring (Workspaces).** Serve the asset same-origin as a hashed file through a Vite `?url` import and pass the URL to the viewer:

```ts
import bridgeScriptUrl from "@plannotator/ui/components/html-viewer/bridge-script.asset.js?url";

<HtmlViewer
  rawHtml={html}
  bridgeScriptUrl={bridgeScriptUrl}
  bridgeReadyTimeoutMs={5000}          // default; the wait for `ready` per document load
  onBridgeUnavailable={(info) => ...}  // { kind: 'timeout' | 'version-mismatch', url, ... }
  ...
/>
```

With the prop set, `buildSrcdocInjection` emits `<script src="…"></script>` in the exact position the inline `<script>` occupied (there is one injection point, `buildBridgeScriptTag` in `srcdoc.ts`, for both paths), so placement is unchanged: at the end of `<head>`, before the body, on both paths (the page's head scripts run before the bridge, its body scripts after). The URL is resolved against the PARENT document (`resolveBridgeScriptUrl(url, document.baseURI)`) before it is written into the srcdoc, never against the framed page: the injection follows any `<base href>` the page declares, so a relative URL left unresolved would let a hostile document point the viewer at an attacker-served bridge and defeat the version check. The srcdoc is rebuilt on `rawHtml`, theme and diff changes and the browser then re-fetches the asset from cache, so serve it with normal immutable-asset cache headers. An empty string counts as absent (inline). The prop is ignored in live (`src`) mode, where the proxy injects the bridge.

**CSP.** Confirmed by grep and pinned by test: the package never writes a CSP `<meta>` into the srcdoc document (the injection is one `<style>` and one `<script>`; an author-written CSP meta is still neutralized as before), and the bridge sets none at runtime. The srcdoc frame is an opaque origin, and a classic `<script src>` executes without CORS; no `crossorigin` attribute is set, so do not expect one. A `Content-Security-Policy` HTTP header on the host page IS inherited by the srcdoc document: a host with its own CSP must allow `script-src` for the origin the asset is served from (same-origin `'self'` in the wiring above). Note the asset form is easier under CSP than the inline form, which would need `'unsafe-inline'` or a nonce. One more header to check: an asset served with `Cross-Origin-Resource-Policy: same-origin` (common with COEP) is blocked for the opaque-origin frame; serve the bridge asset with a CORP that admits cross-origin loads (`cross-origin`) or without CORP.

**Protocol version.** `BRIDGE_PROTOCOL_VERSION` (exported from `components/html-viewer/bridge-script` and re-exported from `components/html-viewer`) is embedded in the bridge text and stamped on its `ready` message as `protocolVersion`. Note for the design record's "current state": `BRIDGE_SCRIPT` now carries its first `${}` interpolation (that constant, evaluated at module load); it remains a plain string export with no per-session values, so the CLI, Pi and the live proxy consume it exactly as before. The parent (`checkBridgeProtocolVersion`, `HtmlViewer`'s ready branch) compares it: on the inline path and in live sessions the two sides come from one bundle and always match; on the URL path a cached asset from a previous package version answers with an older stamp, or none, and the viewer logs one console warning naming both versions, shows a dismissible error banner over the top of the frame (`[data-bridge-error="version-mismatch"]`, `role="alert"`, a `[data-bridge-error-dismiss]` button; the page stays visible) and calls `onBridgeUnavailable` once. The ready is still honored (an older bridge answers every message shape it knows), so this is a loud diagnostic, not a refusal. Bump the constant whenever a bridge message shape changes in a way an older bridge or parent would misread; a bump forces a warning against any not-yet-redeployed asset, which is the point.

**Who renders the strip (`bridgeErrorDisplay`; 0.34.0, from 0.33.0 adoption feedback).** The package owns the failure strip by default: `bridgeErrorDisplay="banner"` renders the `[data-bridge-error]` element for both the mismatch and the timeout states exactly as 0.33.0 did, so Plannotator and every existing host are unchanged. A host that renders its own notice from `onBridgeUnavailable` passes `bridgeErrorDisplay="none"`: no strip and no dismiss button are rendered for either state, while `onBridgeUnavailable` fires exactly as before and a version mismatch still logs its one console warning. Through 0.33.0 the strip could not be suppressed, so such a host showed two banners. The prop is meaningless on the inline path, which never shows a strip. Pinned by the two `bridgeErrorDisplay` cases in `components/html-viewer/HtmlViewer.bridgeAsset.test.tsx`.

**Ready timeout.** On the URL path only, `bridgeReadyTimeoutMs` (default 5000) is armed once per document load (URL or srcdoc change), read through a ref, so changing the prop after the bridge is ready never re-arms it; with no `ready` in time the surface shows `[data-bridge-error="timeout"]` naming the URL and the wait (not dismissible: the surface is dead), and `onBridgeUnavailable({ kind: 'timeout', url, timeoutMs })` fires. A late `ready` clears it. The inline path arms no timer and can never show a banner.

**Dropping the literal from the host chunk (optional).** The URL path alone leaves the inline string in the chunk unused, because `srcdoc.ts` imports it statically (the default must stay synchronous). To remove it, alias the package's `./bridge-script` resolution to the generated lite module in your bundler; with Vite:

```ts
resolve: {
  alias: [{
    find: /^\.\/bridge-script$/,
    replacement: "@plannotator/ui/components/html-viewer/bridge-script.lite",
  }],
}
```

The `find` is anchored on purpose (0.34.0; 0.33.0 documented `/\/bridge-script$/`). Every import of the module inside the package is the relative sibling form, `./bridge-script` (`srcdoc.ts`, `useHtmlAnnotation.ts`, `index.ts`), so `/^\.\/bridge-script$/` matches exactly those. The unanchored form matched any specifier ENDING in `/bridge-script`, which is also the shape of another package's entry point (`some-dependency/bridge-script`) or of a deeper import in your own tree (`../vendor/bridge-script`), and would have silently swapped those for the lite module too. If your own source has a sibling module named `bridge-script`, add an importer check (a `customResolver` on the alias entry, or a `resolveId` plugin that tests `importer` for `@plannotator/ui/components/html-viewer/`) rather than widening the pattern.

Under that alias an `HtmlViewer` rendered WITHOUT `bridgeScriptUrl` throws at render (`buildBridgeScriptTag` refuses to emit an empty inline script), so the misconfiguration cannot ship as a silently dead surface. Measured on the proof harness (PR #1398's description): the viewer chunk shrinks by the size of the literal, 557 kB to 371 kB (168 kB to 118 kB gzip).

**Live app annotation is unaffected.** `packages/shared/live-proxy-bridge-inline.test.ts` pins at source level that both proxy transports and both runtimes' composers still ship the inline bridge from the proxy route and never reference `bridgeScriptUrl` or the generated files.

Pinned by `components/html-viewer/bridgeAsset.test.ts` (generator bytes, manifest wiring, the single injection point, no CSP meta, the real bridge's stamped ready), `components/html-viewer/HtmlViewer.bridgeAsset.test.tsx` (URL srcdoc, stale-asset warning and banner, timeout and late ready, inline path unchanged), `packages/shared/live-proxy-bridge-inline.test.ts` and the bridge marker count in `tests/entry-assets.test.ts`.

---

## Frozen markdown diff (0.28.0)

One additive component for the Workspaces versions/approvals surface: `components/MarkdownDiff`, a theme-bridging shim over `@plannotator/markdown-editor@0.4.0`'s `MarkdownDiff` — a **frozen two-revision markdown comparison**. The newer revision renders as the real document (uncollapsed, full length); deletions are projected struck-through at their original positions; changed spans get character/word emphasis; a toolbar shows the change count with prev/next navigation; a clickable, keyboard-accessible overview rail and a changed-line gutter complete the review chrome. Every 0.27.0 surface is unchanged.

1. **Same shim pattern as `MarkdownEditor`.** Import from `@plannotator/ui/components/MarkdownDiff` — never `AtomicDiffEditor` or `@plannotator/atomic-editor` directly (outside the import allowlist). The shim resolves the color mode from `ThemeProvider` (hosts without the provider pass `mode` directly), imports the same `@plannotator/markdown-editor/themes/plannotator.css` theme the editor shim imports, and maps `gridEnabled` to the identical design-system card chrome — so toggling editor ↔ diff over the same document doesn't jump.

2. **The byte contract lives on the handle.** `editorHandleRef` receives a `MarkdownDiffHandle`: `getMarkdown()` returns the exact `modifiedMarkdown` supplied and `getOriginalMarkdown()` the exact `originalMarkdown` — **byte-identical, including CRLF and trailing whitespace** (the handle returns the caller's strings, not a CM6 read-back). Navigation rides the same handle: `getChangeCount()`, `goToNextChange()`, `goToPreviousChange()`, plus `getContentDOM()` for host-level inspection.

3. **Frozen means frozen.** The surface is never editable: document-changing transactions are rejected at both the state and view dispatch boundaries, and the content DOM is `contenteditable="false"`. Rendered links still work (`onLinkClick`).

4. **`extensions` composes like the editor's.** Same seam, same calling convention: build `wikiLinks(config)` (still re-exported from `components/MarkdownEditor`) and pass it through `extensions` — wiki-links render inside the frozen view. Captured ONCE per mounted comparison (keyed on `documentId` + both document strings): pass a stable array, feed changing data through callbacks that close over live state, and build against your own `@codemirror/*` copies (one shared `@codemirror/state`, as ever).

Seam pinned end-to-end by `components/MarkdownDiff.reexport.test.tsx` (public surface + types) and `components/MarkdownDiff.frozen.test.tsx` (byte preservation incl. CRLF/trailing-space fixtures, `contenteditable="false"`, change navigation, wiki-link composition through the shim, theme/host-class forwarding).

**Dependency note:** 0.28.0 requires `@plannotator/markdown-editor ^0.4.0` (adds `MarkdownDiff`) and `@plannotator/atomic-editor ^0.8.0` (adds the frozen diff engine; new required peer `@codemirror/merge`, which `@plannotator/ui` now declares — single-copy discipline unchanged).

---

## Raw-HTML annotation viewer + syntax-highlighting migration (0.29.0)

0.29.0 blesses the rebuilt raw-HTML annotation viewer as supported host surface and carries one **breaking** migration inherited from the diff-pane highlighter unification. Read both parts before upgrading from 0.28.0.

### BREAKING: `.hljs` is gone — style code via `pn-code`

highlight.js was removed from the package; the single highlighter is now Shiki via `@pierre/diffs` (new dependency, pinned `1.3.2`). Consumer impact:

1. **Any host CSS targeting `.hljs` or `.hljs-*` token classes is inert.** Fenced code blocks now carry `pn-code font-mono language-{lang}` — import `CODE_BLOCK_CLASS` from `utils/codeHighlight` instead of hardcoding class strings.
2. **Per-theme token CSS is the wrong layer now.** Fences resolve a real Shiki theme from the active palette (`utils/syntaxTheme`, `hooks/useFenceTheme`); to change code colors, map the palette to a different Shiki theme — don't write token-class CSS.
3. **New supported utils:** `utils/codeHighlight` (`applyHighlight`, `highlightToHtml`, `codeBlockClassName`, `onCodeHighlightSwap`), `utils/codeBlockMark` (annotation marks that survive highlight swaps), `utils/syntaxTheme`. All pure/browser-safe.
4. **Language-less fences render as plain text — there is no auto-detection anywhere.** Don't reintroduce it host-side; it breaks the byte-identity contract the annotation layer depends on.
5. **Remove any bundler alias on `highlight.js`.** A host that aliased `highlight.js/lib/common` (or any hljs path) while consuming ≤0.28.0 will now **fail at config load** — the module no longer exists in the dependency tree. Delete the alias along with the `.hljs` CSS. (Reported by the first 0.29.0 adopter.)
6. **Known cosmetic install warning:** `@pierre/diffs@1.3.2` → `@pierre/theming@1.0.0` declares a peer of `@pierre/theme@^1.1.0` while `2.0.0` resolves. Upstream ranges we don't control; harmless, appears in every consumer's install output.

### Blessed: `components/html-viewer` (`HtmlViewer`)

The overlay-projection annotation viewer for raw HTML (placed comment markers, pinpoint element anchors, shift-click multi-target, drag selection) is now on the supported allowlist, same standing as `components/Viewer`. The full architecture handoff (anchor model, reconcile loop, message protocol, test map) is a separate document — ask the maintainer for `HANDOFF_HTML_ANNOTATION_v0.26.8.md`. The contract summary:

1. **The contract is props + the validated message protocol — not `configurePlannotatorUI`.** `HtmlViewer` is driven by its props (`rawHtml`, `annotations`, `onAddAnnotation`, `onSelectAnnotation`, `selectedAnnotationId`, `mode`, `inputMethod`, `readOnly`, …) and adapts the sandboxed iframe's validated bridge messages to the same annotation controls the markdown `Viewer` uses. The `configure()` seams still govern what surrounds it (storage, drafts, images, AI), but nothing about the viewer itself routes through `configure()`. Integrate on props; that is the path we maintain.
2. **Numbering derives from the `annotations` prop — drive the prop.** Marker numbers are computed from the prop's array order (matching `exportAnnotations` numbering, globals occupying slots) and synced to the iframe on every prop change. Mounting with an empty prop and driving the viewer imperatively is NOT supported and will leave bubbles unnumbered; the imperative handle (`applySharedAnnotations`, `removeHighlight`, `clearAllHighlights`) exists for repaint scenarios on top of a prop-driven mount, not as a substitute for it. If your host architecture truly cannot supply the prop, ask for a numbering seam rather than working around it.
3. **`readOnly` is view-only, not blank.** With `readOnly`, committed annotations still restore, markers still paint with correct numbers, and clicking a marker still fires `onSelectAnnotation`; every authoring entry point (composer, toolbar, quick label, vim) is disabled. Pinned by the "readOnly view-only contract" tests in `components/html-viewer/htmlPinpointProtocol.test.tsx`.
4. **Security envelope: opaque-origin `srcdoc` sandbox only.** The iframe is `sandbox="allow-scripts"` (no `allow-same-origin`) and both sides authenticate messages by source identity with `targetOrigin: "*"`. That pattern is safe **only** because a `srcdoc` sandbox has an opaque origin. If a host serves annotated content from a real origin (a proxy, a hosted iframe), it must add strict `targetOrigin` and origin checks — do not reuse the `"*"` pattern there.
5. **Multi-target cap is 16 on our side.** `htmlAdditionalTargets` accepts up to 16 additional anchors per comment; a host enforcing a smaller product cap (e.g. 7) should cap at composer level before submit — the stored schema is unchanged either way. As with every anchor field, persist `htmlAnchor`/`htmlAdditionalTargets` as opaque JSON and round-trip them unchanged (see "The annotation anchor schema").

### `@plannotator/core` 0.23.0

Additive only, but required: `@plannotator/ui` 0.29.0 imports the new `@plannotator/core/annotatable` subpath (absent from published core 0.22.0), so core 0.23.0 must be installed/published first. Also picks up additive exports in `agent-jobs`, `config-types`, `favicon`, `feedback-templates`, and an external-annotation PATCH-merge fix (tool-submitted `source` markers are no longer clearable via PATCH).

---

## Unanchored-annotation reporting + readOnly footer fix (0.30.0)

Two consumer-driven changes: the `onUnanchoredChange` callback (the accepted ask from the 0.29.0 adoption) and a behavior fix to `AnnotationPanel`'s readOnly mode.

### `HtmlViewer` `onUnanchoredChange?: (ids: string[]) => void`

Fail-closed anchors hide markers rather than guess, which previously meant an annotation whose content vanished from the page disappeared silently. The viewer now reports it:

1. **The callback receives the complete current set** of annotation ids with no live representation on the page — every target dead (element disconnected AND text unfindable), or the restore never resolved anything. It fires only when the set changes, including back to `[]` on recovery. An id being merely offscreen, clipped, or style-hidden is NOT unanchored: its content exists, so no report.
2. **It fires in readOnly mode too** — view-only surfaces are exactly where silently missing markers go unnoticed.
3. **Bounded like every bridge message:** at most 512 ids of at most 256 chars; an out-of-contract report is rejected whole at the parent trust boundary.
4. **Timing:** reports ride the overlay reconcile (rAF-coalesced), so expect them shortly after load, after page mutations, and after your own `annotations` prop changes — not synchronously with them.

Pinned by "unanchored ids are reported on change" in `components/html-viewer/srcdoc.test.ts` (bridge behavior) and the "unanchored report" suite in `components/html-viewer/htmlPinpointProtocol.test.tsx` (trust boundary + readOnly delivery).

### `AnnotationPanel` readOnly no longer suppresses the host footer slot

**Behavior change.** Through 0.29.1, `readOnly` dropped the `renderCardFooter` slot entirely, which threw away host READ affordances (a replies list, a copy link) along with mutations — view-only panels lost their replies. As of 0.30.0 the footer slot always renders; `readOnly` hides only the built-in mutation affordances (delete/edit, direct-edit discard). **The host gates its own footer contents:** if you render mutation UI in the footer, gate it on your own view-only state. A host that relied on the automatic suppression must add that gate when upgrading.

---

## HTML annotation parity seams (0.32.0)

Nine additive seams so a host can run the raw-HTML annotation surface with the same experience Plannotator ships, without app-local code around `HtmlViewer`. Every default reproduces 0.31.0 behavior; Plannotator's own app passes the same defaults and renders the same DOM (proven by a real-browser A/B of the header, the overlay markers and the annotations panel on a main build versus this build).

1. **`projectHostThreads(threads, { openOnly?, documentLevel?, maxTargets? })`** and **`buildPersistedHtmlAnchor(source, { maxBytes = 16384, maxTargets = 16 })`** are exported from `components/html-viewer` (pure, from `@plannotator/core/html-anchor`). The first projects a host's stored rows (`{ id, originalText, htmlAnchor?, htmlAdditionalTargets?, state?, text?, author?, createdA?, images? }`) onto the `annotations` prop **in the host's order, which is the marker numbering**; an element anchor without quoted text stays a page `COMMENT`, anchors validate fail-closed, and `maxTargets` caps additional targets on read (default: the viewer's 16). A row with nothing restorable (no quote, no element anchor) projects by `documentLevel`: **`'global'` (the default, Plannotator's model)** makes it a `GLOBAL_COMMENT`, a document-level comment the panel renders without a quote line and the unanchored report never names; **`'unanchored'`** keeps it a page `COMMENT` with an empty quote and no anchor, which the unanchored report names (the panel shows an empty quote line), for hosts that treat such rows as comments that lost their place. The second trims a composed comment's anchor for persistence: product cap first, then a byte budget that truncates the quote down to its 400-char floor before shedding targets from the end, with `droppedTargets` (the total), `capDroppedTargets` and `sizeDroppedTargets` reported (a size drop must never be announced as the product cap). Kept targets serialize with keys in `text, label, anchor` order, the reference host's wire order, so stored anchors and fingerprints over them are stable on adoption. An input already in that order and within every bound round-trips byte-identical. **`projectHostThreads` is HTML-only.** The projection carries exactly what the raw-HTML surface reads (`originalText`, `htmlAnchor`, `htmlAdditionalTargets`, the type, the presentational fields) and pins `blockId` to `""`, `startOffset` / `endOffset` to `0`, with no `startMeta` / `endMeta`. On the markdown `Viewer` a projected `COMMENT` with quoted text still re-anchors: `hooks/useAnnotationHighlighter` requires `blockId` only on the math path and for a metas restore, and with no metas it falls to `findTextInDOM(originalText)`, a whole-container text search never scoped by block. What such a row loses with `blockId` `""` and offsets `0`: export ordering (`exportAnnotations` sorts by block index, which is `-1` for every such row, so they all sort first and tie), the "lines N-M" location label (`null` without a block), disambiguation when the same text appears more than once (first match wins), and the no-flash meta restore. A host that needs any of those carries `blockId`, the offsets and the web-highlighter metas in its own projection; a markdown-aware projection is more than a metas passthrough (the block id and offsets are the anchor) and is deliberately not attempted here.

2. **`onUnanchoredChange` is complete over the `annotations` prop and keyed to the bridge's restore.** On every bridge `ready` (a fresh document, a srcdoc reload) the viewer posts its restore batch and then asks the bridge for one complete report (`report-unanchored`); the bridge answers after its next complete overlay pass **even when the set is unchanged, the empty set included**, and that answer is the first delivery for that document. Nothing is delivered before it, per document and per reload generation: a prop-side change that lands before the bridge's first post-restore report is folded into that report, not delivered on its own, so a host must not wait on a prop-side set arriving before the restore (a "no callback yet" state until then is the contract, not a missed event). Later bridge reports deliver as they arrive; a prop-side change delivers only when the union actually changes. The union adds what the bridge cannot see: page rows with no quoted text and no element anchor are reported without being posted (a `GLOBAL_COMMENT` is not, by design), and an id the viewer minted for a locally created comment that the host swapped out of `annotations` for its own id is dropped. What this replaces on the host side: the `mark-applied` bookkeeping that fed an unanchored set (failed verdicts, textless rows, the swapped-out local id). It does not replace `mark-applied` for the local-to-server mark swap itself: the package still does not parse that message, and a host that wants the no-flash swap keeps removing its local mark with `removeHighlight` on its own refetch (a host content with one frame of no mark removes it on the prop change instead).

3. **`hooks/useHtmlRefresh({ enabled?, documentKey?, fetchSnapshot, onSnapshot, onUnanchored?, onResult? })`** returns `{ canRefresh, isRefreshing, reloadGeneration, refresh, reportAnnotationRestore }`. `fetchSnapshot(documentKey)` resolves `{ status: 'ok', rawHtml } | { status: 'missing' } | { status: 'unavailable' }`; a rejection counts as `unavailable`. Key the viewer on `reloadGeneration` and wire its `onUnanchoredChange` to `reportAnnotationRestore`. The hook owns the guards: a fetch superseded by a newer refresh or by a `documentKey` change never applies, and the restore acknowledgement fires once per reload generation with the viewer's first report for the remounted document, which by item 2 is the bridge's post-restore set, the empty set included, so a host clears its chip when a previous orphan re-anchors. Notifications are the host's, through `onResult`.

4. **`components/HtmlSurfaceControls({ armed, onToggleArmed?, toolsHidden?, onToggleTools?, canRefresh?, onRefresh?, isRefreshing?, compact?, labels? })`**: the eye, the refresh and the pen with the exact markup, data attributes (`data-html-tools-toggle`, `data-html-refresh`, `data-html-annotate-toggle`), `aria-pressed` on the pen and the eye, `aria-disabled` on an in-flight refresh (focus is kept), and the pen's pixel-stable border. Descriptions ride the package's `Tooltip` (hover AND focus-visible) instead of a native `title`, with the control's shortcut under it as keycaps; `shortcuts` (`{ annotate?, tools?, refresh? }`, normalized bindings, `null` for none) overrides them and defaults to the `html-annotate` scope. Each control renders only when its handler is passed; `compact` renders nothing. `labels` overrides any string per key (`annotateTitle`, `interactTitle`, `annotateLabel`, `interactLabel`, `hideTools`, `showTools`, `refresh`, `refreshing`, `refreshTitle`, `refreshingTitle`); the defaults are Plannotator's pen and eye strings, the refresh default is the neutral "Refresh document", and no pen `aria-label` is emitted unless a label is passed. Pin the armed state to `annotateModeActive` and pass `onAnnotateModeExit` / `onAnnotateModeToggle` / `onToolsToggle` to the viewer so Esc, Mod+Shift+A and Mod+Shift+X work with focus inside the frame.

5. **`AnnotationPanel` `unanchoredIds?: ReadonlySet<string>`** renders a small "Unanchored" chip (`data-annotation-unanchored`) on matching cards. Absent, the DOM is unchanged (pinned by comparing the markup against an explicit empty set).

6. **`HtmlViewer` `scrollBehavior?: 'smooth' | 'auto'`** rides `scroll-to { id, behavior? }` so a host can carry its `prefers-reduced-motion` across the iframe boundary. Absent means smooth, as before; anything else fails closed to smooth.

7. **`HtmlViewer` `maxAdditionalTargets?: number`** (0..16, default 16) is the host's product cap on shift-click targets per comment: enforced at the parent trust boundary, on submit and on restore, and carried on `arm-multi-select { key, max }` so the bridge's toggle stops at the same number for that draft (reset with the arm on every draft; a value above 16 never raises the package cap). Absent leaves the arm message unchanged. A host that adopts the package's 16 needs neither this prop nor a message-counting listener. Consequence for a host that passes a smaller cap: because it is enforced upstream at every step (the bridge stops the toggle, the parent boundary trims on submit and on restore, `projectHostThreads` `maxTargets` trims on read), a composed comment never reaches host code with more targets than the cap, so the host's own cap-dropped handling (`capDroppedTargets` from `buildPersistedHtmlAnchor`, or a counting listener) is unreachable in normal operation. Keep it only as a backstop for rows written by an older host build or another writer; the byte-budget drop (`sizeDroppedTargets`) is a different path and remains reachable.

8. **`ExternalAnnotationTransport.subscribe` may emit `snapshot` from a host push.** `useExternalAnnotations` falls back to 500 ms version-gated polling only when the stream errors before its first event. A transport whose `subscribe` delivers a `{ type: 'snapshot', annotations, version }` event whenever the host's realtime layer signals a change (a Durable Object poke, a socket message) keeps the hook on the push path and the fallback poll is never entered. No package change; this is the sanctioned shape.

9. **Blessed imports:** `shortcuts` (`useHtmlAnnotateShortcuts` and the scope registry) and `utils/inputMethod` join the supported table above. Both are fetch-free and `/api`-free (verified by grep over the modules and everything they import); `utils/inputMethod` persists through the `storageBackend` seam.

Behavior is pinned by `../core/html-anchor.test.ts`, `components/html-viewer/unanchored.test.ts` and the "unanchored report" suite in `components/html-viewer/htmlPinpointProtocol.test.tsx`, `hooks/useHtmlRefresh.test.tsx`, `components/HtmlSurfaceControls.test.tsx`, `components/AnnotationPanel.unanchored.test.tsx`, and the cap and scroll-to cases in `components/html-viewer/srcdoc.test.ts` and `htmlPinpointProtocol.test.tsx`.

### `@plannotator/core` 0.25.0

Additive only, but required: `@plannotator/ui` 0.32.0 imports the new `@plannotator/core/html-anchor` subpath (`projectHostThreads`, `buildPersistedHtmlAnchor`), absent from published core 0.24.0, so core 0.25.0 must be installed/published first. Also carries the regenerated `guide-viewer-manifest` that pins the guides.show stylesheet with the `HtmlSurfaceControls` rules (see "Publishing & versioning").

0.32.0 also ships the WebMCP provider engine (`@plannotator/ui/webmcp`, the `webmcp` seam on `configurePlannotatorUI`, and the additive `Annotation.inReplyTo` field); see README.md "WebMCP provider".

---

## Theme-aware Mermaid diagrams (0.40.0)

Mermaid diagrams used to render from one static config in every palette and both modes: `MERMAID_CONFIG` pinned Mermaid's `dark` base theme plus a slate `themeVariables` palette, so a diagram was blue-on-slate under GitHub Light and Catppuccin alike. Diagrams now follow the active colour theme and mode the way code fences already do (`resolveFenceTheme` / `useFenceTheme`), through ONE dynamic mapping rather than per-palette themes.

**How it works.** `utils/mermaidTheme` has three layers. `readThemeTokens(el?)` reads the theme custom properties off the document element (`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--border`, `--muted`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--accent`, `--destructive`, `--success`, `--warning`, `--font-sans`) via `getComputedStyle`, resolving anything the pure parser cannot read as written (`color-mix()`, a `var()` chain) through a throwaway probe element, and returns `undefined` when neither `--background` nor `--foreground` resolves. `buildMermaidThemeVariables(tokens, mode)` is pure: it parses the tokens (hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`, `lab()`, `lch()`, `color()`; alpha composited over the background, output always opaque hex because Mermaid's colour library does not read `oklch()`), fills any missing optional token from the two required ones, and returns `{ theme, themeVariables }` — base theme `dark` when the resolved mode is dark, `default` when light, with a complete override for every documented family: general, flowchart, sequence (`actor*`, `signal*`, `note*`, `activation*`, `labelBox*`, `sequenceNumberColor`), state, class, ER (`attributeBackgroundColor*`, `rowOdd/Even`), requirement, gitGraph (`git0..7`, `gitInv*`, `gitBranchLabel*`, `commitLabel*`, `tagLabel*`), gantt, pie (`pie1..12`, `pieOpacity: 1`), the `cScale*` scale behind mindmap/timeline, journey (`fillType0..7`), quadrant, venn, architecture, C4, plus the nested `xyChart`, `packet`, `radar`, `wardley`, `cynefin` objects. `applyMermaidTheme(mermaid, key, root?)` is the runtime step `MermaidBlock` runs before every render: `mermaid.initialize` is global, so it runs only when the `(palette, mode)` key (`mermaidThemeKey(colorTheme, mode)`, from `useTheme()`) or the runtime object changed since the last apply; a key change also re-runs the block's render effect, which is what re-themes an already rendered diagram (the fence re-highlight pattern).

**Token → variable mapping** (the canvas is `muted` at 30% over `card`, matching the block container's `bg-muted/30`; the same mix over `background` is also checked as a surface, since the container can sit on either): `background`/`labelBackground`/`edgeLabelBackground`/`commitLabelBackground`/`relationLabelBackground`/`altSectionBkgColor` ← canvas; node/actor/state/entity/requirement/person fills (`primaryColor`, `mainBkg`, `nodeBkg`, `actorBkg`, `stateBkg`, `requirementBackground`, `tagLabelBackground`, `attributeBackgroundColorOdd`, `rowOdd`) ← `card`; their text (`primaryTextColor`, `nodeTextColor`, `actorTextColor`, `stateLabelColor`, `classText`, `requirementTextColor`, `tagLabelColor`) ← `card-foreground`; borders (`primaryBorderColor`, `nodeBorder`, `border1`, `actorBorder`, `activationBorderColor`, `compositeBorder`, `taskBorderColor`, `gridColor`, `pieOuterStrokeColor`, `archGroupBorderColor`, `quadrant*BorderStrokeFill`) ← `border`; edges and arrowheads (`lineColor`, `arrowheadColor`, `defaultLinkColor`, `signalColor`, `actorLineColor`, `labelBoxBorderColor`, `transitionColor`, `relationColor`, `archEdge*`, `innerEndBackground`, `specialStateColor`) ← `muted-foreground`; page text (`textColor`, `titleColor`, `labelColor`, `signalTextColor`, `transitionLabelColor`, `commitLabelColor`, `pieTitleTextColor`, `pieLegendTextColor`, `taskTextOutsideColor`, quadrant/xyChart/wardley text) ← `foreground`; cluster/subgraph, composite state, label box, activation and gantt section fills (`clusterBkg`, `secondaryColor`, `secondBkg`, `compositeBackground`, `labelBoxBkgColor`, `activationBkgColor`, `sectionBkgColor`, `doneTaskBkgColor`) ← `muted`; `tertiaryColor` ← `popover`; notes ← `card` tinted 18% toward `warning` with a `warning` border; error fills ← `card` tinted toward `destructive`; accents (`activeTaskBorderColor`, `vertLineColor`, `quadrantPointFill`, `taskTextClickableColor`) ← `primary`; `todayLineColor`/`critBorderColor` ← `destructive`. The twelve categorical fills (`cScale0..11`, `pie1..12`, `git0..7`, `fillType0..7`, `venn1..8`, `taskBkgColor`, `activeTaskBkgColor`, `xyChart.plotColorPalette`) are seeded from the palette's own accent tokens in the order `primary`, `accent`, `success`, `warning`, `destructive`, `secondary` (greys skipped, hues closer than 18° merged) and completed with hue rotations of the first seed, all normalized to one OKLCH lightness per page polarity (0.74 on a dark page, 0.50 on a light one; chroma clamped to 0.06..0.15) so one ink — the `background` token — reads on all of them (`cScaleLabel*`, `gitBranchLabel*`, `gitInv*`, `pieSectionTextColor`). `fontFamily` ← `--font-sans` when present. `darkMode` follows the mode.

**Contrast rule.** Every text-on-fill pair the mapping produces must reach WCAG 4.5:1 and every line-on-canvas pair 3:1 (`ensureContrast`; the mapping adds 0.1 of headroom because a browser composites the container tint in its own space). Page-level text and lines are guarded against every surface they can cross rather than one: the canvas (the block's `bg-muted/30` tint over the document card, which is where Plannotator's article puts it, and over the bare page for a host that mounts the block there), node fills (`card`), cluster and composite-state fills (`muted`), popovers and ER rows — the first sweep found edges at 2.4–2.9:1 and cluster titles at 4.0:1 in 20 palettes precisely because they had been guarded against the page background alone. A pair that falls short is repaired by moving the text or line colour toward the mode's `foreground` token by the smallest OKLab step that satisfies the ratio (hue is kept where possible); when `foreground` cannot reach the ratio on that fill, the `background` token is used as the ink; when neither token can, pure black or white is the last resort (a mid-luminance fill such as the line colour under a sequence number); ratios are measured on the 8-bit colour Mermaid receives. Categorical fills are additionally pushed in lightness until the `background` ink reaches 4.5:1 on each. Structural strokes (node, cluster, actor borders) are guaranteed 1.5:1 against the canvas, nudged toward `muted-foreground`, so a palette with a near-invisible `border` still draws outlines. Page polarity (which lightness the fills are normalized to) is decided from the measured luminance of the `background` token, not from the mode label, so a dark-only palette rendered under a light label still gets fills its ink can carry; the label only picks the Mermaid base theme. `packages/ui/utils/mermaidTheme.test.ts` sweeps every palette in `packages/ui/themes` in both modes against these pairs, so a new palette cannot regress the guard.

**Fallback contract for hosts.** Nothing changes for a host that does not use the tokens: with no `--background`/`--foreground` on the document (no `ThemeProvider`, no `theme.css`), `readThemeTokens` returns `undefined`, `buildMermaidThemeVariables` returns `null`, `buildMermaidConfig(null)` is `MERMAID_CONFIG` itself, and `applyMermaidTheme` records the key without calling `initialize` at all, so the runtime keeps the static config the loader or the eager entry initialized it with and renders byte-identically to 0.39.0 (pinned by `utils/mermaidTheme.test.ts` and `components/MermaidBlock.theme.test.tsx`). Outside a `ThemeProvider`, `useTheme()` yields the default context (Plannotator dark), which only names the key. `MERMAID_CONFIG` keeps its value and meaning (`securityLevel: 'strict'` still pinned by `components/MermaidBlock.test.ts`; `flowchart.htmlLabels` and `curve` are carried into the dynamic config unchanged) and `loadMermaidRuntime` / the eager entry are untouched: the runtime is still initialized once at registration, and the theme apply is a second, cached `initialize` on top. A host that ships its own tokens under the same names gets themed diagrams for free; a host that wants the old slate look in a themed document can keep the tokens off the diagram's ancestors, since `readThemeTokens` reads the document element by default. New exports are additive; the only behaviour change is for documents that carry the tokens, where diagrams now follow them.

**Node shadow (the one thing that is not a colour).** Mermaid 12's neo look paints a drop shadow on every node, cluster and actor, from its own fixed `drop-shadow(1px 2px 2px rgba(185,185,185,1))` — a grey that reads as a halo on a themed page and follows no palette. The look is kept and that one filter is replaced: `buildMermaidThemeVariables(tokens, mode, options?)` takes an optional **`options.shadowAmount`, 0..1, default `DEFAULT_MERMAID_SHADOW_AMOUNT` (0.7)**, and publishes `themeVariables.dropShadow` from the new pure `buildMermaidShadow(ground, amount)`; the returned `MermaidThemeSpec` carries the resolved `shadowAmount`. Geometry scales over a small floor — `x = 0.3 + 0.7a`, `y = blur = 0.6 + 1.4a` — so **1 reproduces Mermaid's `1px 2px 2px` exactly** and **0 publishes `dropShadow: false`** (plus `nodeShadow: false`, the only thing that reaches the inline `filter:url(#…-drop-shadow-small)` on a state diagram's small start/end dots), which the neo rules render as `filter: none`. The colour comes from the palette's own ground and its POLARITY follows the page, the same rule Mermaid's `insertLookDefs` uses (`floodColor = theme.includes('dark') ? '#FFFFFF' : '#000000'`): on a dark page the ground lifted 82% toward white at alpha `0.18 + 0.72a`, on a light page darkened 40% toward black at `0.25 + 0.3a`, each asserted to differ from the ground in the direction that reads (falling back to plain white or black; to Mermaid's own grey when the ground is not a usable colour at all). Polarity, not just alpha, is the point: a black shadow on a near-black ground is a valid filter that paints nothing.

`mermaidThemeKey(colorTheme, mode, shadowAmount?)` takes the amount as a third argument and appends `#s<amount>` to the key **only when it is not the default**, so the cache key for a host that never names an amount is byte-identical to the `(palette, mode)` key of 0.40.0 and no extra `initialize` happens. `DiagramTheme` (`utils/diagram-render`) gains an optional `shadowAmount`, which `DiagramBlock` fills from Plannotator's cookie-only `diagramShadow` setting (Settings → Display → "Diagram Shadow": 0 / 40 / 70 / 100 on a 0-100 percent scale; `utils/diagramShadow` exports `DEFAULT_DIAGRAM_SHADOW`, `DIAGRAM_SHADOW_OPTIONS`, `isDiagramShadow` and `diagramShadowAmount`, and is deliberately import-free so the settings registry can read it without pulling the diagram mapping into every surface's module graph).

**What a host does.** Nothing, to get the toned-down default. To keep **Mermaid's own grey**, pass your own `themeVariables.dropShadow` after ours (`{ ...buildMermaidConfig(spec), themeVariables: { ...spec.themeVariables, dropShadow: 'drop-shadow(1px 2px 2px rgba(185,185,185,1))' } }`) — or simply `buildMermaidThemeVariables(tokens, mode, { shadowAmount: 1 })` for the same geometry in your palette's own colour. To ship **no shadow**, pass `{ shadowAmount: 0 }`, or build the key with `mermaidThemeKey(palette, mode, 0)` if you drive `applyMermaidTheme` yourself. The static `MERMAID_CONFIG` a token-less host renders with carries the same 0.7 geometry with one fixed light colour (its own slate palette is dark) — that is the ONE byte that changed in the fallback config; `securityLevel: 'strict'`, `startOnLoad`, `flowchart.htmlLabels` and `curve` are untouched. The shadow is paint-time only: at every amount the fills and label colours the mapping produces are identical (pinned in `utils/mermaidTheme.test.ts`, which also sweeps every shipped palette in both modes for a default shadow in the readable direction).

**Known limits.** `GraphvizBlock` already maps its output to `var(--foreground)` / `var(--muted-foreground)` / `var(--muted)` and needs nothing. Mermaid hardcodes a `#000000` stroke on the sequence `crosshead` marker (lost messages, `-x`), which no theme variable reaches; it stays as in every Mermaid theme. The Mermaid 12 upgrade shipped in the same 0.40.0 publish and reuses this mapping unchanged; the re-sweep on 12 is in "Mermaid 12 (0.40.0)".

## Element context through the host seam (0.40.0)

`@plannotator/ui` 0.39.0 captured **element context** on raw-HTML and live-app pinpoints but deliberately left `@plannotator/core/html-anchor` untouched, so a host persisting through `buildPersistedHtmlAnchor` and reading through `projectHostThreads` dropped the field on save and never got it back on projection. That gap (#1521) is closed: the field now survives the whole host round trip.

**The validator lives in core.** `parseHtmlElementContext` is exported by **`@plannotator/core/html-anchor`**, beside `parseHtmlElementAnchor`, along with `MAX_ELEMENT_CONTEXT_BYTES` (2048) and `MAX_PAGE_URL_LENGTH` (2048). `@plannotator/ui/components/html-viewer` imports it and **re-exports it unchanged**, so the 0.39.0 import site keeps working and no host code has to move; what is gone is the hand-mirrored copy that used to live in `components/html-viewer/useHtmlAnnotation.ts` (the rule since core 0.25.0: no mirror validators). Behavior is byte-faithful to 0.39.0 — the same scalar bounds, the same `CONTEXT_ATTR_ALLOWLIST` with href/src scrubbed of query and fragment, the same `outline → text → attrs → classes → path → heading → landmark → component` shed order inside the 2 KiB serialized bound, and the same fail-closed `undefined` for anything that is not a record or carries no `tag`. A host that calls the validator directly gets identical output for identical input.

**What a host passes.** `buildPersistedHtmlAnchor(source, options)` now accepts `elementContext?: HtmlElementContext | null` on `source`, and each entry of `source.htmlAdditionalTargets` accepts `context?`. Both go through the same fail-closed parser the read path uses, so nothing is persisted that would be refused on read back. `HostThread` (the `projectHostThreads` input) accepts `elementContext?` the same way.

**What a host gets back.** `PersistedHtmlAnchor` gains `elementContext?` and `HtmlAnnotationTarget` gains `context?`. **Key order is fixed and matters:** `elementContext` serializes strictly AFTER `htmlAdditionalTargets`, and a target's `context` after its `anchor` (so a kept target's key order is `text, label, anchor, context`). A row that carries no context serializes byte-identically to what 0.39.0 wrote — the key is absent, not `undefined` — so a wire fingerprint over stored anchors does not move when you adopt this. `projectHostThreads` returns `elementContext` on the projection and `context` on each projected target, so a host's panel and its per-row Copy (which calls `exportAnnotationEntry`) see the field. Paint never reads it: the repaint path still posts only anchors to the bridge.

**The 16 KiB budget is unchanged, and contexts are the first thing it sheds.** `DEFAULT_HTML_ANCHOR_MAX_BYTES` stays 16384: one primary context at 2 KiB plus 16 extras at 1 KiB each already exceeds it, and raising the default is not the answer (the 48 KiB figure that appeared in the design write-up was never shipped). Under `maxBytes` the stages are now: the quote down to its 400-char floor → **per-target contexts, from the end** → **the primary context** → targets from the end → the rest of the quote. Shedding context before targets is deliberate: a context is descriptive and re-derivable on the next click, while a dropped target loses a marker the reviewer placed. Context shedding is silent — `droppedTargets`, `capDroppedTargets` and `sizeDroppedTargets` count targets only and keep their exact 0.39.0 meanings, so a host notice that distinguishes a product-cap drop from a size drop is unaffected.

**The field stays descriptive.** Restore never reads it, `HtmlElementAnchor` and the restore path are untouched, there is no `BRIDGE_PROTOCOL_VERSION` bump, and share links still drop it exactly as they drop anchors.

### Export without the outline

`elementContextExportBlock(ann, opts)` and `exportAnnotationEntry(ann, opts)` on `@plannotator/ui/utils/parser` take a new **`includeOutline?: boolean`, default `true`**. Pass `false` to print the identity lines (`selector`, `path`, `role · name · component`, `attrs`, `text`, `route`, `box`, `near`) WITHOUT the fenced HTML skeleton: in a model turn the 600-char outline is the expensive part per annotation, and the identity lines are what an agent greps. Defaulting to true keeps every existing caller's bytes unchanged.

**Default change to know about before you upgrade:** `exportAnnotationEntry`'s **`includeRoute` now defaults to `true` per field**, not only when `opts` is omitted. In 0.39.0 the default lived on the parameter (`opts = { includeRoute: true }`), so passing any explicit options object replaced it and `exportAnnotationEntry(ann, {})` silently dropped the live-app `route` line. A host that was passing an options object in order to suppress the route must now pass `includeRoute: false` explicitly. Callers that pass nothing, or that already pass `{ includeRoute: true }` or `{ includeRoute: false }`, are unaffected. `elementContextExportBlock`'s own default is unchanged (route off unless asked, because the grouped export prints a `## Page:` heading above the entries).

Behavior is pinned by `../core/html-anchor.test.ts` (the wire fingerprint of a context-less row, the shed order, and the projection) and the element-context cases in `utils/parser.test.ts`.

---

## Mermaid 12 (0.40.0)

`@plannotator/ui` 0.40.0 moves the diagram runtime from `mermaid` `^11.17.2` to an exact `mermaid` `12.0.0` and, in the same release, stops registering it eagerly in Plannotator's own plan editor. The theme mapping from 0.39.x (see "Theme-aware Mermaid diagrams") is unchanged and was re-swept on 12: all 52 palettes in `packages/ui/themes` in every mode they define (78 combinations — 26 palette halves do not exist, 22 palettes being dark-only and 4 light-only — 15 diagrams each), 12,870 text-on-fill pairs and 7,410 line-on-canvas pairs measured from the rendered SVG in Chromium, **0 failures** against the 4.5:1 / 3:1 rule and 0 render errors. This section is the contract a host needs to adopt 0.40.0; the publish order is at the end.

**What Mermaid 12 changes, and what we took.** We take 12's defaults rather than pinning the 11 ones (owner ruling). Concretely:

- **ELK is the effective default layout** for flowchart (`graph`, `flowchart`), state, class, ER and requirement diagrams — through Mermaid 12's per-diagram defaults, while the top-level `config.layout` still reads `dagre` (so do not infer the renderer from that key): orthogonal right-angle edge routing, tighter node boxes with more label wrapping, different subgraph packing, and a different rendered `viewBox` for the same source. ELK is now part of `mermaid` itself (`elkjs` is a dependency; the separate `@mermaid-js/layout-elk` package is gone) and is loaded by Mermaid's own internal `import()` on the first ELK layout, so in a chunked host build it is a separate `elk-*.js` chunk (1,435 KB, 438 KB gzip) whether or not you import `mermaid-eager`. `flowchart-elk` as a diagram id still parses and renders (`aria-roledescription="flowchart-elk"`). The `defaultRenderer` option under `flowchart` / `class` / `state` config is removed upstream; use the top-level `layout` option if you need dagre back (`mermaid.initialize({ ..., layout: 'dagre' })` on the runtime after ours; `MERMAID_CONFIG` does not set `layout`).
- **Per-diagram default theme/look** (`redux-color` theme and the `neo` look for flowchart, class, state, ER, requirement, sequence, use case, swimlane, Venn and agentflow) does not reach a Plannotator-themed document: `applyMermaidTheme` passes an explicit base theme (`dark` / `default`) and a complete `themeVariables` set, and `MERMAID_CONFIG` passes `theme: 'dark'`, so the rendered look is the classic one in the 0.39 sweep and in the 0.40 sweep alike. A host that renders with no theme tokens keeps `MERMAID_CONFIG` (still `theme: 'dark'`, still `securityLevel: 'strict'`, pinned by `components/MermaidBlock.test.ts`).
- **Legacy diagram ids** `flowchart`, `class`, `state` are gone from `detectType`; `flowchart-v2`, `classDiagram`, `stateDiagram` are what 11 already returned for the same sources, and every `aria-roledescription` in the sweep is identical 11 → 12.
- **Removed public exports** (`clearLayoutRenderState`, `createCommonLayoutRenderer`, `defaultMeasureLayout`, `paintLayoutData`, the `CommonLayout*` types) are internal layout helpers that nothing in `@plannotator/ui` used or re-exported.
- **`lodash-es` override does not travel.** This repo pins `lodash-es` to `4.18.1` through a root `overrides` entry (the Mermaid 12 dependency tree pulls an older range); npm does not apply a dependency's `overrides`, so a consumer adds its own root `"overrides": { "lodash-es": "4.18.1" }` (pnpm: `pnpm.overrides`) to get the same tree.
- **Browser floor: Safari 17.4+ and ES2024.** Mermaid 12 is built to that target ("Mermaid is now built to target Safari 17.4+ and ES2024"; Node 22.12+ for anything that imports it server-side, e.g. a test harness). A host that must render diagrams on an older Safari stays on ui 0.39.x. Nothing else in `@plannotator/ui` moved its floor.

**SVG ids are byte-identical 11 → 12** (measured from the real rendered SVG in the plan editor across 15 diagrams in 7 families, all 12 ids per diagram matched). `MermaidBlock` renders with `mermaid.render("mermaid-" + block.id, source)`, so every id below is prefixed by that render id (`{renderId}`), and a host that anchors on these keeps working:

| Family | Anchor | Pattern (11 and 12) |
|---|---|---|
| flowchart / `graph` / `flowchart-elk` | node | `<g id="{renderId}-flowchart-{nodeId}-{n}" class="node default">` |
|  | edge | `<path id="{renderId}-L_{from}_{to}_{n}" class="flowchart-link">` |
|  | subgraph | `<g id="{renderId}-{subgraphId}" class="cluster">` under `g.clusters` |
|  | markers | `<marker id="{renderId}_flowchart-v2-{pointEnd\|pointStart\|circleEnd\|circleStart\|crossEnd\|crossStart}[-margin]">` |
| state (`stateDiagram-v2`) | state | `{renderId}-state-{stateId}-{n}` (`.node.default.statediagram-state`); pseudo-states `{renderId}-state-{scope}_start-{n}` / `_end-{n}`; composite cluster `{renderId}-state-{stateId}-{n}` (`.statediagram-cluster`) |
|  | transition | `<path id="{renderId}-edge{n}" class="transition">` (note `edge{n}`, not `L_a_b_0`); markers `{renderId}_stateDiagram-barbEnd` and, new under 12, `{renderId}_stateDiagram-barbEnd-margin` |
| class | class box | `{renderId}-classId-{ClassName}-{n}` |
|  | relation | `<path id="{renderId}-id_{From}_{To}_{n}" class="relation">`; markers `{renderId}_classDiagram-{kind}[-margin]` |
| ER | entity | `{renderId}-entity-{ENTITY}-{n}` |
|  | relationship | `<path id="{renderId}-id_entity-{A}-{i}_entity-{B}-{j}_{n}" class="relationshipLine">`; attribute cells are class-only (`.attribute-type`, `.attribute-name`, `.attribute-keys`, `.row-rect-odd/even`) |
| requirement | node / relation | `{renderId}-{reqId}` / `<path id="{renderId}-{a}-{b}-{n}">` |
| sequence | lifeline / root | `line#actor{n}`, `g#root-{n}` — **global, un-prefixed**; messages, notes, activations and loops carry classes only (`.messageLine0/1`, `.messageText`, `.sequenceNumber`, `.note`, `.activation0`, `.loopLine`) and no ids |
| gitGraph / pie | — | no ids at all (`.commit`, `.commit{n}`, `.branch{n}`, `.pieCircle`, `.slice`); the per-commit hash class on gitGraph circles is derived from generated commit ids and was never stable |
| every family | gradient | one `<linearGradient id="{renderId}-gradient">` |

Three class-level deltas, none of which breaks an id- or class-based selector: `g.edgePaths` gains a second class (`<g class="edges edgePaths">`, additive, same element); empty `g.edgeLabel > g.label > div.labelBkg` placeholder groups are no longer emitted for edges without a label (a host that assumed one `.edgeLabel` per edge must count labeled edges only); and the gitGraph auto-hash class differs, as it always could.

**One DOM-order change a host must know about.** Children of `g.edgePaths` are now in **declaration order**. Under 11/dagre the eval's state diagram emitted `edge0, edge1, edge5, edge6, edge10, edge2, edge3, edge4`; under 12/ELK it emits `edge0 … edge10` in source order. Anything that indexes edges by DOM position (`edgePaths.children[i]`, `:nth-child`, walking siblings to pair an edge with a label) breaks; anything that selects by id (`{renderId}-L_{from}_{to}_{n}`, `{renderId}-edge{n}`, `{renderId}-id_{From}_{To}_{n}`) does not. If you need a stable order, sort by id or by the numeric suffix, never by position.

**Lazy-load contract.** Since 0.32.0 `utils/mermaid` has loaded the runtime through a slot: filled, it resolves at once; empty, `loadMermaidRuntime()` runs `import('mermaid')` on the first diagram, memoized, with a rejected load dropped so the block's automatic re-attempt and its Retry issue a fresh import (`utils/mermaid.test.ts`, `components/DiagramBlock.lazyRetry.test.tsx`). Through 0.39.0 Plannotator's plan editor filled the slot eagerly by importing `utils/mermaid-eager`, so a host copying its entry got the same. **0.40.0 removes that import**: with 12's runtime ~1.8 MB larger, a plan with no diagram must not pay for it, so Plannotator itself now takes the lazy path, and `tests/entry-assets.test.ts` fails if the eager import comes back into either app. What that means for a host:

- Nothing to change to get the lazy behaviour: it is the default of the package and always was. The first diagram on a page fetches `mermaid.core-*.js` (625 KB, 148 KB gzip on this checkout's portal build) and, for an ELK family, Mermaid then fetches `elk-*.js` (1,435 KB, 438 KB gzip); until the SVG lands the block shows the source fence under a quiet `role="status"` line ("Rendering diagram…", `data-mermaid-pending`), never the error panel, and the panel with the source plus Retry appears only for a failure (pinned by the "Mermaid pending state" case in `DiagramBlock.lazyRetry.test.tsx`).
- To keep the 0.39 behaviour — runtime registered and initialized at startup, in your entry chunk, unable to fail separately from the app — add the one line Plannotator used to have, before the first render: `import '@plannotator/ui/utils/mermaid-eager';`. It statically imports `mermaid`, runs `mermaid.initialize(MERMAID_CONFIG)` at module evaluation and fills the slot (`setMermaidRuntime(mermaid, 'plannotator-mermaid-eager')`); the ELK chunk is still Mermaid's own lazy import and is not hoisted by this.
- Own loader: `setMermaidRuntime(runtime, 'host')` after your own `import('mermaid')` + `initialize(MERMAID_CONFIG)` fills the slot the same way; there is no `mermaidRuntimeLoader` seam on `configurePlannotatorUI` (the test hook `__setMermaidRuntimeLoaderForTests` is not host surface).
- `applyMermaidTheme(mermaid, key)` is keyed on the **runtime object** as well as the `(palette, mode)` key, so a lazily loaded runtime is themed on its first render exactly like an eagerly registered one, and a host that swaps runtimes gets a fresh `initialize` (pinned by `components/MermaidBlock.theme.test.tsx`).
- Single-file builds gain nothing from the lazy import: `inlineDynamicImports` inlines the `import('mermaid')` target (and ELK) into the one HTML file, and the import resolves from the bundle. Plannotator's own hook bundle is 21.74 MB → 23.50 MB (+1.76 MB, +8.1%; gzip 6.66 MB → 7.19 MB); that delta is Mermaid 12's own size, not the loading strategy, and the review bundle is unchanged (17.43 MB, byte-identical to main) because it never carried Mermaid. On the chunked share portal the entry chunk goes 4,688 KB → 4,044 KB (-645 KB, -13.7%) with `mermaid.core` moving to its own chunk.

**Theming contract, restated for 12.** `MermaidBlock` calls `applyMermaidTheme(runtime, mermaidThemeKey(colorTheme, mode))` before every render. `readThemeTokens()` reads `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--border`, `--muted`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--accent`, `--destructive`, `--success`, `--warning` and `--font-sans` off the document element (resolving `color-mix()` / `var()` chains through a probe element); `buildMermaidThemeVariables(tokens, mode)` turns them into the base theme (`dark` / `default`) plus a complete `themeVariables` set for every family (node fills ← `card`, text ← `foreground` / `card-foreground`, borders ← `border`, edges and arrowheads ← `muted-foreground`, clusters ← `muted`, twelve categorical fills seeded from `primary`, `accent`, `success`, `warning`, `destructive`, `secondary`; every colour opaque hex, every text-on-fill pair guarded to 4.5:1 and every line 3:1 against every surface it can cross), and `mermaid.initialize(buildMermaidConfig(spec))` runs once per key change. **Without tokens** (no `ThemeProvider`, no `theme.css`, or the tokens kept off the document element) `readThemeTokens` returns `undefined`, `buildMermaidThemeVariables` returns `null`, nothing is re-initialized, and the runtime keeps the static `MERMAID_CONFIG` it was initialized with (12's own `dark` base theme with the slate `themeVariables`, ELK layout). None of the variable names changed between 11 and 12; the 0.40 sweep (78 combinations, 12,870 text pairs, 7,410 line pairs, 0 failures) is the proof that the mapping holds under ELK's re-laid-out geometry.

**Publish order.** `@plannotator/ui` 0.40.0 pins `@plannotator/core` `0.25.3` exactly, so **publish `core` 0.25.3 first, then `ui` 0.40.0** (`npm publish` in `packages/core`, then in `packages/ui`; both by hand from `main` after merge — CI never publishes these packages). Nothing under `packages/core` changed for Mermaid 12 itself. Core 0.25.3 also carries #1549 (`parseHtmlElementContext`, `MAX_ELEMENT_CONTEXT_BYTES`, `MAX_PAGE_URL_LENGTH` on `@plannotator/core/html-anchor`, and the element-context round trip; see "Element context through the host seam"), which is why the ui pin moves: a ui 0.40.0 on a published core 0.25.2 would fail to compile in a consumer.

---

## Diagram engine (0.41.0)

`@plannotator/ui` 0.41.0 makes the Workspaces diagram viewer THE diagram engine of the package (owner ruling: "the new engine, not an option"). `MermaidBlock` and `GraphvizBlock` keep fence parsing, `diagramLanguages.ts` and the lazy-retry contract, and render through ONE renderer slot and ONE canvas: their own viewBox math, `applyView` and per-block zoom controls are gone, and the popout is the same `DiagramViewer` at full size over the document (the `TablePopout` chrome). A host that installs 0.41.0 gets the viewer, its overlay and Source pane, the anchor codecs and the runtime slots as supported surface; a host that already renders the copies Workspaces carried re-pins onto these exports and deletes the copies. Requires `@plannotator/core` 0.25.4 (the `diagram-anchor` subpath), so **publish core 0.25.4 first, then ui 0.41.0**.

**New exports.**

- `@plannotator/ui/components/diagram` (barrel; the components also resolve as `components/diagram/<Name>`): `DiagramViewer` (+ `DiagramViewerProps`), `DiagramPopout`, `DiagramCanvas` (+ `DiagramCanvasHandle`, `DiagramEscapeOutcome`, `svgContentSize`, `KEY_PAN_PX`; props `pickTarget`, `className`), `DiagramOverlay`, `DiagramComposer`, `DiagramSourcePane`, `useDiagramComments` (+ `DiagramComment`, `DiagramCreateComment`, `DiagramComposerDraft`, `DiagramHover`, `ResolvedDiagramComment`), `useDiagramRender` (+ `DiagramRenderState`), `useDiagramSourceDraft` (+ `DiagramSourceDraft`, `SaveResult`, `PREVIEW_DEBOUNCE_MS`), `useDiagramViewport` (+ `Viewport`, `ContentSize`, `ZOOM_MIN`, `ZOOM_MAX`, `ZOOM_STEP`, `WHEEL_ZOOM_SENSITIVITY`, `DRAG_THRESHOLD_PX`, `TOUCH_DRAG_THRESHOLD_PX`, `FIT_PADDING_PX`). Also `components/diagram/anchorClaims`: `DiagramAnchorClaims`, `DiagramAnchorClaimsContext`.
- `@plannotator/ui/utils/diagram-render`: `renderDiagram(kind, renderId, source, theme)`, `diagramFinder(kind)`, `sanitizeDiagramSvg`, `parseDiagramSvg`, `scrubDiagramSvg`, `scopeDiagramCss`, `widenEdgeHitAreas`, `diagramHitSource`, `DIAGRAM_HIT_ATTR`, `DIAGRAM_HIT_LAYER_ATTR`, `EDGE_HIT_STROKE_WIDTH`, `themeGraphvizSvg`, types `DiagramTheme`, `DiagramRenderResult`, `DiagramRenderError`, `DiagramKind`; test hook `__setDiagramSvgParserForTests`.
- `@plannotator/ui/utils/graphviz`: the Graphviz runtime slot, the same shape as `utils/mermaid` — `loadGraphvizRuntime`, `setGraphvizRuntime`, `getGraphvizRuntime`, `getGraphvizRuntimeSource`, `getGraphvizRetryDelayMs`, `__setGraphvizRuntimeLoaderForTests`, types `GraphvizRuntime`, `GraphvizRuntimeSource`, `GraphvizRuntimeLoader`. `@viz-js/viz` is pinned exactly at `3.30.0`; the only runtime spelling of the package is the slot's `import('@viz-js/viz')`.
- `@plannotator/ui/utils/diagram-anchor`: the Mermaid finder over a rendered svg — `DiagramFinder` (the seam: `targetSelector`, `targetFromElement`, `findTarget`, `sourceLine`), `MERMAID_FINDER`, `DIAGRAM_TARGET_SELECTOR`, `diagramFamilyOf`, `nodeIdsOf`, `splitEdgeStem`, `targetFromElement`, `findDiagramTarget`; it re-exports everything from `@plannotator/core/diagram-anchor` so a host imports one module.
- `@plannotator/ui/utils/diagram-anchor-graphviz`: `GRAPHVIZ_FINDER`, `GRAPHVIZ_TARGET_SELECTOR`, `graphvizTargetFromElement`, `graphvizFindTarget`, `graphvizSourceLine`.
- `@plannotator/ui/utils/diagram-projection`: `projectElement(el, hostRect)` (+ `ScreenRect`).
- `@plannotator/core/diagram-anchor` (core 0.25.4): types `DiagramFamily`, `DiagramTargetKind`, `DiagramTarget`, `DiagramAnchor`, `DiagramKind`; `parseDiagramAnchor`, `parseDiagramTarget`, `parseDiagramAdditionalTargets`, `buildDiagramAnchorValue`, `buildDiagramAnchor` (the opaque-blob shape a host that stores every anchor kind in one JSON column writes), `sameTarget`, `diagramTargetText`, `diagramTargetName`, `diagramAnchorLocationLine`, `lineMentions`, `diagramSourceLine`, `diagramWholeSourceLines`, `diagramFirstSourceLine`, `DIAGRAM_ANCHOR_KEY`, `DIAGRAM_ADDITIONAL_TARGETS_KEY`, `MAX_DIAGRAM_ANCHOR_STRING_LENGTH`.
- `Annotation.diagramAnchor?: DiagramAnchor` on `@plannotator/ui/types` (also re-exported there as a type), and additive `annotations`, `selectedAnnotationId`, `onSelectAnnotation`, `onAddAnnotation`, `readOnly`, `onRestoreReport` props on `MermaidBlock` / `GraphvizBlock` (`DiagramBlockProps`; `Viewer` passes its own).

**Removed.** `components/mermaidSvg` (`normalizeMermaidSvgMarkup`) is gone: it never sanitized anything (it baked `max-width: none`, `preserveAspectRatio` and `height="100%"` into the root tag for the old innerHTML mount), and the canvas now sizes the mounted node itself. A host that imported it drops the import. `GraphvizBlock` no longer exports `__setVizLoaderForTests` as its own function; the name is kept as an alias of `__setGraphvizRuntimeLoaderForTests`.

**The adapter (`DiagramViewer` props).** `kind: 'mermaid' | 'graphviz'`, `source: string`, `theme: { colorTheme, mode: 'dark' | 'light' }` (the pair `useTheme()` resolves; a host without `ThemeProvider` passes any palette id with the mode it renders in — with no tokens on the document the Mermaid entry keeps the static `MERMAID_CONFIG`), `comments: DiagramComment[]` (`{ id, anchor: DiagramAnchor, additionalTargets?, text, author?, resolved? }`; array order is the badge numbering), `onCreateComment?(anchor, text, additionalTargets)` (absent: clicks open nothing; `anchor.sourceLine` already carries `sourceLineOffset`), `onSave?(source) => Promise<SaveResult>` with `SaveResult = { status: 'ok' } | { status: 'stale', currentSource }` (absent: no Source pane; a thrown error is the save error shown in the pane; `stale` shows the Reload strip, holds Save and keeps the draft, and Reload adopts `currentSource` as the baseline), `readOnlySource?` (pane shown, no Save), `sourceOpen?` (the host owns the toggle; `DiagramPopout` renders one), `selectedCommentId?` / `onSelectComment?`, `onUnanchoredChange?(ids)` (once per membership change after every render, the `HtmlViewer` contract), `onResolutionChange?(map)` (every comment's verdict, whenever one changes or the list does), `canvasClassName?` (the canvas is `touch-action: pan-y` so a finger can scroll the page past an inline diagram; a viewer that owns the screen passes `touch-none`, as `DiagramPopout` does), `onDismiss?` (Escape with nothing left to close), `renderId?` (two viewers over one document need two), `sourceLineOffset?` (0 when the document IS the diagram; a fence's opening line for a fence, so `sourceLine` names document lines), `maxAdditionalTargets?` (default 0: a comment covers one part; pass 16 to keep shift-click multi-select — Workspaces' `MAX_PERSISTED_ADDITIONAL_TARGETS`), `commentingDisabledReason?` (the composer shows the reason and a Close instead of a textarea — what `CommentingPolicy.reason` was), `retryToken?`, `onRenderState?`, `renderFallback?` (what to show while there is no svg yet), `autoFocus?`, `className?`. Nothing else reaches the viewer: identity, storage, the comments rail and the save transport are the host's.

**The anchor shape** (`DiagramAnchor`; Workspaces' `diagram` value plus two additive members within `v: 1`, the `sequence` family and the `diagram` kind): `{ v: 1, family: 'flowchart' | 'state' | 'class' | 'er' | 'requirement' | 'sequence' | 'other' | 'graphviz', kind: 'node' | 'edge' | 'cluster' | 'diagram', id?, from?, to?, label, sourceLine: [first, last] | null }` — the diagram's own id for the part (never the rendered element id with its counter, never geometry), the label at write time, and 1-based DOCUMENT lines. Restore order: id, label, source line (the pane's gutter mark), unanchored but listed. `parseDiagramAnchor` is the one fail-closed validator (strings capped at 400, a bad `sourceLine` drops to null while the target survives); the external-annotations POST (both runtimes), the feedback archive and the export all run it. Share links drop the anchor exactly like `htmlAnchor` (pinned by `sharing.multiTarget.test.ts`).

**Codec families.** Flowchart, state, class, ER and requirement parts are addressed by Mermaid's own ids (table in "Mermaid 12"). **Sequence** diagrams carry classes, not ids, so the ids are the codec's: an actor is a `node` whose id is the actor's `name` attribute (`rect.actor`, `text.actor`, `line.actor-line`; the top and bottom boxes of one actor are the same target, and the element is the top box); a message is an `edge` `msg-<n>` by document order (`.messageLine0/1`, and its `text.messageText` resolves to the same message; `from` / `to` come from the line's `data-from` / `data-to` when the renderer wrote them; the label is the message text); a note is a `node` `note-<n>` (`rect.note` + `text.noteText`); a loop / alt / opt frame is a `cluster` `frame-<n>` (the group that holds its `line.loopLine`s, label from `text.labelText` + `text.loopText`). `sourceLine` for an ordinal is the n-th statement of its kind in the text (`diagramSourceLine`). Because an ordinal moves when a statement is inserted above it, sequence restore checks the label too: the part at the ordinal when its label still matches, else the ONE part that carries the stored label, else the part at the ordinal (its text was edited in place). Everywhere, the label fallback (restore step 2) applies only while the label names exactly one part; with duplicates it is skipped and the comment falls through to the source line. gitGraph and pie carry neither ids nor stable classes: a comment there is a whole-diagram comment.

**Comments that name no diagram block.** A comment composed in a block carries that block's `blockId`. One posted through `POST /api/external-annotations` carries `blockId: "external"`, and one whose fence was deleted carries a dead id. `Viewer` provides `DiagramAnchorClaimsContext` (`components/diagram/anchorClaims`, a `DiagramAnchorClaims` over the document's diagram block ids in order); every diagram block tries such a comment against its own render (`onResolutionChange`, the per-comment verdict map the viewer reports whenever a verdict or the list changes) and reports to the coordinator; the FIRST block in document order whose finder resolves it shows it, and when every block has answered and none did, the first block reports it unanchored (a document with no diagram at all: `Viewer` reports it). A block rendered without the context coordinates with itself only. A Graphviz-family anchor is only ever tried against dot fences.

**The runtime slots.** Mermaid: `utils/mermaid` as before (`loadMermaidRuntime`, `setMermaidRuntime`; the eager entry unchanged), with `applyMermaidTheme(runtime, mermaidThemeKey(colorTheme, mode))` still called per (palette, mode) before every render — `MermaidBlock.theme.test.tsx` and the `securityLevel: 'strict'` pin are unchanged. Graphviz: `utils/graphviz`, the same shape, filled lazily on the first dot fence or by a host through `setGraphvizRuntime(await import('@viz-js/viz').then((m) => m.instance()), 'host')`. Both are loaded with ONE automatic re-attempt after the slot's retry delay; a load failure resolves the render to `{ ok: false, runtimeUnavailable: true }`, which is the one failure the block's Retry (a shared epoch per engine, so one Retry re-attempts every failed sibling) can change.

**The sanitizer, and the delta.** `sanitizeDiagramSvg` = `parseDiagramSvg` (DOMPurify under the svg, svg-filter and html profiles with `foreignobject` added back the way Mermaid's own pass adds it, `RETURN_DOM_FRAGMENT`, the root adopted into the page document) + `scrubDiagramSvg` (in place on the tree about to be mounted: `script`/`iframe`/`object`/`embed`/`link`/`meta` removed, every `<style>` reduced by `scopeDiagramCss(css, rootId)` to the rules scoped under the svg's own root id plus `@keyframes` — `@import` and every other statement at-rule dropped, any rule that fetches dropped (`url(` that is not a `#fragment`, `image-set(`, `image(`, `src(`, `cross-fade(`, `paint(`, `element(`; CSS escapes are decoded first, so `u\72l(` is caught), any rule with a selector NOT starting at `#<rootId>` dropped (it could restyle the page around the diagram), `@media` / `@supports` / `@container` / `@layer` filtered recursively, `@font-face` and the rest dropped; a style element left empty is removed. Mermaid scopes every rule it emits under the render id, so all of its rules survive: pinned over six captured families, and in Chromium the computed node, label and edge styles equal main's on three palettes with identical rule counts, every `<a>` loses `href`/`xlink:href` so a `click A "https://…"` binding cannot turn a pinpoint click into a navigation, every `on*` attribute removed, `href`/`xlink:href`/`src` kept only for `#fragment` or `http(s)` values). No markup string ever reaches the app DOM: the canvas mounts the node with `replaceChildren`. Delta against what Plannotator had: nothing to merge in the security direction (the old `normalizeMermaidSvgMarkup` and the old Graphviz regex rewrite did no sanitizing); the one case ours covered that the moved code did not — a Graphviz root whose size is only `width="206pt" height="188pt"` with no `viewBox` — is now handled in `svgContentSize`, which accepts `pt`/`px`-suffixed lengths as the fallback. Also consolidated: the old Graphviz stroke color `var(--muted-foreground)` becomes `var(--foreground)` (the moved `themeGraphvizSvg`), so dot fences and Workspaces' `.dot` documents draw the same line. **Test note:** happy-dom cannot host DOMPurify (its `DOMParser` lands the fragment in a foreign realm and mislabels svg namespaces; in-place mode reads `nodeName` through a cached `Node.prototype` getter happy-dom overrides on `Element`), so DOM tests parse through an inert XML/`<template>` parse via `__setDiagramSvgParserForTests` (`test-setup/diagramSvg.ts`) while `scrubDiagramSvg` still runs on every test render; the DOMPurify parse is proven in Chromium.

**Interaction (owner feedback, twice: watching the first runs, then testing the build by hand).** Click-to-select, drag-to-pan: a press that travels under the drag threshold is a click and opens the composer (so a slightly moving click still selects); one that travels further is a pan and never opens it. The threshold is pointer-type aware: `DRAG_THRESHOLD_PX` (4 px) for a mouse or pen, `TOUCH_DRAG_THRESHOLD_PX` (10 px) for a finger. **Hover targeting was removed at the owner's request** — it read as messy and fought the pan hand — so nothing highlights on a plain mouse-over; the one pre-click affordance left is the ring and label chip under the pointer while the platform modifier is held (Cmd on macOS, Ctrl elsewhere; `isModKeyHeld`), and it disarms on the modifier's release, on any other key while it is held, and on window blur, like the code review's token cards. Canvas keys (`+` `-` `0`, arrows) ignore events carrying Meta, Ctrl or Alt, so `Mod+0`, `Mod+-` and `Alt+Arrow` stay the browser's. The wheel ignores `|deltaY| < 0.1`.

**The hit layer and the priority rule.** Edges were nearly impossible to click. Measured cause (headless Chromium, `elementsFromPoint` at 20 points along every edge of a flowchart with nested subgraphs, a state, a class and an ER diagram): the ONLY thing painted over an edge is that edge's **own label** (`g.edgeLabel > foreignObject > … > p`), which covers 5–40% of every labelled edge, centred on its midpoint — exactly where a person clicks an edge; unlabelled edges were reachable at 20 of 20 points. Mermaid 12 + ELK emits ONE `g.root` even with nested subgraphs, and clusters are painted before the edge paths, so nested roots and cluster rects cover nothing. The fix is structural anyway, so it also holds for a renderer that does nest: `widenEdgeHitAreas(svg)` (exported from `utils/diagram-render`, with `DIAGRAM_HIT_ATTR`, `DIAGRAM_HIT_LAYER_ATTR`, `EDGE_HIT_STROKE_WIDTH`, `diagramHitSource`) collects one invisible hit path per edge into ONE `<g data-diagram-hit-layer>` appended LAST in the svg root. Each hit path is a bare element of the edge's tag carrying only its geometry (`d` / `x1 y1 x2 y2` / `points`), a `transform` that re-creates the ancestors' placement (every ancestor's `transform` attribute joined outermost first, plus the edge's own: an svg transform list composes left to right, so this needs no layout and runs on the detached node), `data-diagram-hit="<index>"`, `stroke: transparent`, `fill: none`, `stroke-width: 14`, `pointer-events: stroke`, the width, stroke, dash pattern and markers also set `!important` inline. It keeps NO `id`, `class`, marker, inline style or `data-*` of the edge, so a host's `[data-id="L_A_B_0"]` still matches exactly what it matched before. `diagramHitSource(hitEl)` (a WeakMap) maps one back to its visible edge. Covered: Mermaid `g.edgePaths > path`, `path.flowchart-link`, `path.transition`, `path.relation`, `path.relationshipLine`, the sequence `.messageLine0/1`; Graphviz `g.edge > path`. Because the layer sits over the nodes too, `DiagramCanvas` never trusts the topmost element: it takes `document.elementsFromPoint` at the pointer, maps hit paths to their edges, reduces each element to its addressable ancestor, and hands the candidates (topmost first) to `pickTarget`, which the viewer implements as **node, then edge, then cluster** (`useDiagramComments.pickTarget`). An edge LABEL is a target too and resolves to its edge (`g.edgeLabel` → the edge whose id its `data-id` names); the composer and the ring always land on the part's ONE element (`finder.findTarget` canonicalizes). Numbered badges and rings for existing comments are unchanged.

**A click never does nothing: the `diagram` kind.** A click that resolves no part opens the composer on the WHOLE diagram (with a draft already open it closes the draft instead): `{ kind: 'diagram', family, label: <the diagram's first source line>, sourceLine: <the source's full range, offset into the document> }`, no `id`. This covers gitGraph, pie, and any family the codec does not address. Its ring is the svg's content bounds and its badge sits top-left; it is never unanchored while the diagram renders (`findTarget` returns the svg root). The export line reads `Diagram (<family>), lines a–b`.

### 0.41.1 — the engine is lazy, and the controls are not part of the diagram

Two fixes, no API change: every export named in this section still resolves
from the same path, and a host upgrading from 0.41.0 changes nothing.

**Lazy.** 0.41.0 reached the whole engine through STATIC imports from
`components/Viewer`: `Viewer` → `MermaidBlock` / `GraphvizBlock` →
`DiagramBlock` → `DiagramPopout` and `DiagramViewer` → `DiagramSourcePane` →
CodeMirror. Any host that statically imports `Viewer` therefore shipped the
canvas, the overlay, the finders, the popout and the editor on EVERY document
read, including a markdown document with no diagram and — since no host passes
`onSave` for a fence — an editor that could never open. Three edges are now
`React.lazy`: the two block wrappers in `Viewer` (one chunk each over a shared
`DiagramBlock` chunk), `DiagramPopout` in `DiagramBlock` (loaded when Expand
is pressed, fallback `null`), and `DiagramSourcePane` in `DiagramViewer`
(loaded when the pane first opens, fallback a box with the pane's own class
list so the split never collapses). A host that imports `DiagramViewer`
directly still gets a working viewer; its pane simply arrives one chunk later.
`svgContentSize` moved to its own dependency-free module and is re-exported
from `DiagramCanvas` and the barrel, so both published paths are unchanged.
The Suspense fallback for a fence is the block's own pending state
(`components/diagram/DiagramPending`, new, exported for hosts that render
their own fence chrome), so the source fence under "Rendering diagram…" paints
once and neither wait flashes. Measured on `Viewer`'s own document-read
closure (minified, gzip): 980.3 KB → 829.4 KB, -150.9 KB. Single-file builds
inline everything and are unchanged, which is why
`components/Viewer.diagramClosure.test.ts` bundles the entry and walks its
static imports.

**Controls.** The canvas resolves a click over everything under the pointer
(`elementsFromPoint`, node → edge → cluster) because the edge hit layer sits
above the nodes. The chrome painted over the canvas is not in the svg, so that
walk stepped past it to the part behind: pressing Zoom out over a node opened
the composer on that node, and a press on the strip could start a pan. A
pointer event whose composed path contains a control surface now resolves no
target, opens no composer and starts no pan. Mark host chrome inside the
canvas with `data-diagram-control`; `button`, `[role=toolbar]`, inputs, the
composer and the source pane count without marking
(`components/diagram/diagramControls`).

**A diagram comment restored before its diagram mounts.** Making the two
block wrappers lazy opens a window in which the document has painted and a
draft has restored but no diagram exists in the DOM yet. That window was
investigated after a report of diagram comments being lost across a reload;
the report did not hold (the probe behind it never answered the "Draft
Recovered" modal and then counted an un-restored session), and the three
properties that make the window safe were already in place. They are now
pinned, because every one of them is a way to lose a comment that has no text
to fall back on:

- the highlighter skips a row carrying `diagramAnchor` outright — it is
  neither painted, attempted nor reported unanchored — including the shape
  with no quote and no `blockId` that a whole-diagram or label-less anchor
  produces (`hooks/useAnnotationHighlighter.diagramSkip.test.tsx`);
- `Viewer`'s "this document has no diagram, so nobody can resolve this row"
  report keys on the PARSE, never on what has mounted, so a lazy load does
  not flash the "Unanchored" chip on a comment that restores fine;
- the row stays listed either way, and the block claims it and paints its
  badge whenever it mounts — no second restore pass, no reload
  (`components/Viewer.diagramLazyRestore.test.tsx`, which holds the engine
  open on a gated runtime loader and asserts the panel row, the absent chip,
  then the badge).

**Migration for a host that carried the copies.** `useDiagramRender(kind, documentId, source, theme, { retryToken })` now takes the `{ colorTheme, mode }` theme and reports `error.runtimeUnavailable`; `useDiagramAnnotations` becomes the host's projection of its rows onto `comments` plus its mutation behind `onCreateComment` (the viewer half is `useDiagramComments`); `useDiagramDraft`'s `preview`/`dirty`/`stale`/`reload` semantics live in `useDiagramSourceDraft` behind `onSave` (the PATCH, `If-Match`, the query cache and the fence slice stay host-side; answer `stale` on a 412); `DiagramComposer` takes `disabledReason`/`error` instead of a `CommentingPolicy`; the canvas's `onEscape` returns `'consumed' | 'pass'` so a popout can walk the Escape ladder; arrow keys pan (`KEY_PAN_PX`, Shift ×5) in addition to `+` `-` `0`. Icons come from `lucide-react` (already a dependency).

---

## Host toolbar seams (0.43.0)

Two additive props, ruled in together by Plannotator's owner **on one
condition: each is an opt-in host capability that changes nothing for
Plannotator's own users when it is not supplied.** Plannotator is the provider
of these capabilities; it is not a product that uses them. It passes neither
prop anywhere, and `packages/editor` / `packages/review-editor` are untouched
by this release. Core is UNCHANGED at `0.25.5`, so **ui 0.43.0 publishes
alone**.

### 1. `AnnotationToolbar` `selectionActions` — the host's own commands on a selection

```ts
import type { SelectionAction, SelectionActionContext } from "@plannotator/ui/types";
// (also @plannotator/ui/utils/selectionActions)

interface SelectionActionContext {
  text: string;          // the toolbar's copy text, else the element's text
  blockId: string;       // the enclosing [data-block-id], '' on raw-HTML surfaces
  startOffset: number;   // offset of the selection inside that block's text
  endOffset: number;     // startOffset + text.length
  element: HTMLElement;  // the element the toolbar is anchored to
}

interface SelectionAction {
  id: string;
  label: string;
  detail?: string;         // dimmed second line
  icon?: React.ReactNode;  // a colored accent bar is drawn when absent
  onSelect(ctx: SelectionActionContext): void;
}
```

One toolbar button (a wand, `data-selection-actions`) opens the package's own
dropdown directly below it, in the quick-label picker's placement and chrome
(`components/SelectionActionsDropdown`: `SelectionActionsDropdown` is the list,
`FloatingSelectionActionsPicker` the portaled, viewport-clamped, flip-above
picker; rows carry `data-selection-action="<id>"` under `role="listbox"`).
Selecting an item calls `onSelect(ctx)` and closes the toolbar exactly as a
quick label does — **the package creates no annotation**; what an action means
is entirely the host's business.

- **Keyboard:** ArrowDown / ArrowUp move, Enter invokes, Escape closes the
  dropdown (and only the dropdown — the toolbar stays open). Nothing is
  preselected until the first arrow, the package-wide rule, so a stray Enter
  over an open dropdown never fires a host command. Pointer hover highlights a
  row and a click invokes it directly. While the dropdown is open, the
  toolbar's own type-to-comment and Alt+digit listeners stand down, the same
  way they do for `FloatingQuickLabelPicker`.
- **Where it sits:** the wand takes the slot the quick-labels Zap occupied and
  the Zap moves one place right (`Copy | Delete | Comment | Actions | Quick
  label | 👍 | Cancel`). Chosen over "actions to the right of the Zap" so that
  ONE geometry rule covers both host configurations: with `quickLabels: false`
  — the expected host setup — the wand sits exactly where the Zap sat, and a
  host that keeps both gets its own actions in the primary slot it opted into.
- `undefined` or `[]` renders no button at all, and the empty array is pinned
  by a test because "the host has no actions right now" is a real state.
- **The context is derived, not threaded.** `buildSelectionActionContext`
  (`utils/selectionActions`, pure) walks up from the anchor element for
  `[data-block-id]` and computes the offset by splitting the block's text on
  the selection — deliberately the same arithmetic
  `createAnnotationFromSource` uses, so an action sees the coordinates an
  annotation created from that same selection would carry. On a surface with
  no blocks (raw HTML) it degrades to `blockId: ''` and `startOffset: 0`
  (`endOffset` is then the selection's length; an HTML annotation itself
  stores `0`/`0`). The one deliberate deviation from the annotation path is
  a selection the block does not contain — one spanning two blocks — where
  the annotation path reports `blockText.length` and a host gets `0`.

### 2. `AnnotationToolbar` `quickLabels` — the opt-out switch

`quickLabels?: boolean`, default `true`. `false` hides the Zap picker button
**and** makes the Alt+digit label shortcuts inert on that toolbar (hiding the
button while leaving the keys live was the obvious bug; a test pins both). It
does not touch the one-click 👍, which is a separate affordance, and it does
not clamp editor mode — a host that persists `'quickLabel'` mode still keeps
that state out of `Viewer`, exactly as with `AnnotationToolstrip`'s
`hideQuickLabel` (0.35.0).

### 3. `CommentPopover` `mentionSource` — an `@` mention source for the composer

> **0.43.2 additions (opt-in, byte-identical when absent):** `MentionSource.heading?: string | null` draws one non-selectable heading row (`data-mention-heading`, e.g. "People in this workspace") above the list; `MentionPerson.avatar?: { url?, initials?, tint? }` draws an avatar (`data-mention-avatar="image" | "initials"`) before the label — an `<img>` when `url` is set, else `initials` (defaulting to the label's first letter) on a disc tinted with `tint` (any CSS color; absent means the muted surface). Neither the grammar, the keyboard state machine, `onMentionsChange`, `onPickBlocked` nor `Annotation.mentions` changes.

```ts
import type { MentionPerson, MentionSource } from "@plannotator/ui/types";
// (also @plannotator/ui/utils/mentions)

interface MentionPerson {
  readonly id: string;                    // opaque host id, reported back verbatim
  readonly kind: "user" | "agent";        // agents are never taggable in a comment
  readonly label: string;
  readonly detail: string | null;         // right-aligned hint (an email, "Agent")
  readonly canOpen: boolean;              // host access data; see onPickBlocked
}

interface MentionSource {
  readonly people: readonly MentionPerson[];
  readonly emptyNotice?: string | null;                     // honest-empty row
  readonly heading?: string | null;                         // 0.43.2: heading row above the list, absent → none
  readonly onMentionsChange?: (ids: readonly string[]) => void;
  readonly onPickBlocked?: (person: MentionPerson) => void;
}
```

This is the shape the host's own reply box already uses (`MentionPerson` is
copied field for field from its `plannotator/mention-extension.ts`), so the
host fills `people` from its existing candidate hook and nothing has to be
mapped. The **package owns the typing rules and the picker**; the host owns
the people and what a mention means.

- **The grammar is ported, not reinvented** (`utils/mentions`, pure, unit
  tested): the same `MENTION_QUERY_RE = /@[\w .-]*$/`, the same word-boundary
  guard that makes `a@b.com` never open a menu, the same users-only /
  not-already-tagged filtering on label OR detail, the same `@Label ` insertion
  with the caret after it, the same `sanitizeMentionLabel`, and the same
  surviving-token rule — deleting a token untags that person, so the body and
  the reported ids can never disagree about who was named.
- **The picker** (`components/MentionPicker`) is portaled and `position:
  fixed`, measured from the textarea's rect, above it by default and below
  when there is not 196px of headroom — the composer card clips its own box,
  so a menu positioned inside the textarea's wrapper is cut off. `role=
  "listbox"` with `data-mention-picker`, rows `data-mention-option="<id>"`, the
  empty notice `data-mention-empty` (one non-selectable row; with `people: []`
  and no notice the menu simply stays closed).
- **Keyboard** (`hooks/useMentionAutocomplete`, modelled on
  `useSkillReferenceAutocomplete` and living in the same textarea beside it —
  `handleKeyDown` offers the event to the skill hook first, then this one):
  nothing is preselected, so Enter is a newline and Tab leaves the field until
  an arrow engages a row; ArrowDown from none lands on the first row, ArrowUp
  on the last; a mouse pick uses `mousedown` + `preventDefault` so it beats the
  blur. **One deliberate difference from the `/` and `$` trigger:** the arrows
  engage this menu even on a bare `@`, and Escape closes it whenever it is
  visible. `$` and `/` are ordinary prose characters whose menu must yield the
  arrows back to caret navigation; `@` at a word boundary is an unambiguous tag
  gesture, and typing `@` then ArrowDown is how the host's own reply box
  behaves.
- **`onPickBlocked` is the no-access rule.** When a `canOpen: false` person is
  picked AND the host supplied `onPickBlocked`, the handler fires and
  **nothing is inserted** (the host shows its own no-access dialog). Without
  the handler such a person inserts like anyone else — the package never
  renders a disabled row it cannot explain. Both branches are pinned by tests.
- **The ids reach the host two ways.** `onMentionsChange(ids)` fires on every
  text change with the surviving ids, and `onSubmit` gained an optional THIRD
  argument: `onSubmit(text, images?, mentions?)`. The third argument is passed
  **only when `mentionSource` is supplied** — without one the call is the
  two-argument call it has always been (`arguments.length === 2`, pinned).
  Hosts can use either; `onMentionsChange` alone is enough for a host that
  keeps its draft state outside the popover.
- Nothing is wired to Plannotator data: there is no mention provider in this
  repo, and `configurePlannotatorUI` gains no seam for one. A host passes the
  prop where it renders the composer, the `HtmlViewer` / `Viewer` pattern.

### Threading points

- `AnnotationToolbar` (`selectionActions`, `selectionActionsIcon`, `quickLabels`) — the props live here. `selectionActionsIcon?: React.ReactNode` (0.43.1) is the glyph on the wand button, forwarded by `Viewer` (both toolbars) and `HtmlViewer`; absent → the package's own wand, which 0.43.1 also simplified to one thick diagonal with a single star (the six-spark glyph read as noise at 16px). Name, `data-selection-actions`, size and behavior of the button are untouched either way.
- `Viewer` forwards both to BOTH of its toolbars (the text-selection toolbar
  and the code-block hover toolbar).
- `HtmlViewer` forwards `selectionActions` to its selection toolbar. It does
  not take `quickLabels`: that surface is already `commentOnly`, which hides
  the Zap and the Alt+digit keys outright.
- `plan-diff/PlanCleanDiffView` mounts a toolbar too and is deliberately NOT
  threaded: it is a Plannotator-only surface (the plan-version diff) and is not
  on the supported-import list. Ask if a host needs it.
- `CommentPopover` (`mentionSource`). `Viewer` does NOT forward it: the viewer
  owns several composers and a per-composer decision belongs to the host that
  renders them. Ask if you would rather pass it once on `Viewer`.
  **Answered in 0.43.1 — both viewers now forward it; see the next section.**

### The no-op guarantee, and how it is pinned

With neither prop supplied, the rendered DOM of both components is **byte-for-byte
what `origin/main` renders**: the same components were mounted on the base commit
and on this branch in the same harness and their `outerHTML` diffed to zero
(`.annotation-toolbar` + `[data-comment-popover]`, 6376 bytes each, identical).
On top of that, committed tests pin the structure rather than a snapshot:
the default toolbar's button set and order (`Copy, Delete, Comment, Quick
label, Looks good, Cancel`), the absence of `[data-selection-actions]` and of
the picker, the exact attribute list on the Zap button, and — for the composer —
that typing `@` opens nothing and that submit stays a two-argument call.
`useMentionAutocomplete` with no source registers no listener, opens no menu
state and returns one frozen empty id array; `AnnotationToolbar` renders no
extra element and spreads no extra attributes.

Tests: `utils/mentions.test.ts` (11, DOM-free),
`components/AnnotationToolbar.selectionActions.test.tsx` (8, DOM-gated),
`components/CommentPopover.mentionSource.test.tsx` (11, DOM-gated).

## `mentionSource` on the viewers (0.43.1)

0.43.0 left `mentionSource` on `CommentPopover` alone, with an open question
("ask if you would rather pass it once on `Viewer`"). The answer is yes, so
0.43.1 threads it one level up and gives the picked ids somewhere to land.
Same ruling as 0.43.0: an opt-in host capability that changes nothing for
Plannotator's own users when it is not supplied. `packages/editor` and
`packages/review-editor` are untouched by this release; core is UNCHANGED at
`0.25.5`, so **ui 0.43.1 publishes alone**.

### 1. The prop

`Viewer` and `HtmlViewer` each gain `mentionSource?: MentionSource` — the same
type, unchanged, from `@plannotator/ui/types` (also `utils/mentions`) — and
each forwards it to EVERY comment composer it mounts:

- `Viewer` → the text-selection composer (`useAnnotationHighlighter`'s) and the
  global / code-block one.
- `HtmlViewer` → the pinpoint (selection) composer and the global one.

A host that wants mentions on a surface passes one prop instead of reaching
into the viewer's composers. Passing it directly to a `CommentPopover` you
mount yourself still works and is unchanged.

Deliberately NOT threaded: `plan-diff/PlanCleanDiffView`, `CodeFilePopout` and
`goal-setup/GoalSetupSurface` mount composers too, but they are Plannotator-only
surfaces off the supported-import list — the same line 0.43.0 drew for
`selectionActions`. Ask if a host needs one.

### 2. `Annotation.mentions` — where the ids go

```ts
interface Annotation {
  // …
  mentions?: readonly string[];   // opaque host ids, additive
}
```

`onSubmit(text, images?, mentions?)` used to stop at the viewer: the third
argument was received and dropped. It now rides onto the annotation the viewer
hands `onAddAnnotation`, on every creation path behind those composers
(`createAnnotationFromSource`, `createAnnotationFromMathSource`, the code-block
path, both global comments, and the HTML pinpoint comment).

**The presence rule** is the whole no-op guarantee, so it is worth stating
exactly: the key exists only when a `mentionSource` was supplied AND at least
one id survived to submit. No source → no third argument → no key. A source
whose tokens the author deleted before submitting → `[]` from the composer →
still no key, never an empty array. Every write is a conditional spread
(`...(mentions && mentions.length > 0 ? { mentions } : {})`), not `mentions,`,
because the bare shorthand would put the key on the object with an `undefined`
value and `'mentions' in ann` would start answering true for Plannotator.

The ids are opaque to the package. Mapping one to a person, notifying them, or
rendering an avatar is entirely the host's business — `MentionPerson.id` is
reported back verbatim, exactly as it was handed in.

### 3. What the field does NOT touch

An id from a host's directory means nothing outside that host, so the field
stays out of everything Plannotator produces:

- **Export.** `exportAnnotations`, `exportAnnotationEntry` and
  `exportLinkedDocAnnotations` never print it: an annotation carrying
  `mentions` exports byte-identically to the same annotation without it
  (`utils/parser.mentions.test.ts`). The readable `@Label` token is in the
  comment body, which is what the coding agent reads.
- **Share links.** Dropped exactly like `htmlAnchor`, `elementContext` and
  `diagramAnchor` — the compact tuple format never carried extra fields, and a
  round trip restores `mentions: undefined` (pinned in
  `utils/sharing.multiTarget.test.ts`).
- **External annotations.** `POST /api/external-annotations` builds its rows
  from an explicit field list and `PATCH` from an allowlist, so a `mentions`
  key on the wire is dropped as any unknown key is. No change was needed in
  `@plannotator/core/external-annotation`, in either runtime.
- **The feedback archive.** `packages/shared/feedback-archive.ts` copies named
  fields into its record; `mentions` is not one of them and never reaches
  `index.jsonl` or a sidecar. No change needed.
- **Drafts** carry it for free (annotations are opaque JSON to the draft
  transport), which is the behavior a host wants: a restored draft still knows
  who was named.

### 4. Edit and reply paths

There is none to thread in these two viewers: both `Viewer` composers and both
`HtmlViewer` composers are CREATION composers. Editing an existing comment
happens in `AnnotationPanel`'s card, a plain textarea that has never had an
`@` picker and takes no `mentionSource`; replies (`inReplyTo`) are created by
the WebMCP catalog, not by a composer. So no annotation's `mentions` is
rewritten after creation by this package — a host that edits a comment owns
the field from then on. If you want the panel editor to pick people too, that
is a separate prop on `AnnotationPanel` and worth asking for.

### No-op guarantee, and how it is pinned

With no `mentionSource`, both viewers mount the composers they always did, no
`@` listener is registered, no picker DOM exists, and the annotation object
handed to `onAddAnnotation` has no `mentions` key at all (`'mentions' in ann`
is false, asserted rather than `toBeUndefined()` — the difference between the
conditional spread and the bare shorthand is invisible to the latter).

Tests (both DOM-gated, both in the workflow's DOM_TESTS step):
`components/Viewer.mentionSource.test.tsx` (5) drives the real Viewer — the
selection composer through the Vim toolbar's type-to-comment gesture and the
global composer through its button — and
`components/html-viewer/HtmlViewer.mentionSource.test.tsx` (3) drives the real
HtmlViewer through a bridge pinpoint message and its global button. Plus the two DOM-free pins in
§3 above.

## Mention token chips in the composer (0.44.0)

0.43.0-0.43.2 gave the composer an `@` picker; the token it inserted was
then plain text in the textarea. 0.44.0 paints it as a **chip**, so a tag
looks the same in the picker row, in the input, and in the comment the host
posts. Same ruling as the three releases before it: an opt-in host
capability that changes nothing for Plannotator's own users when it is not
supplied. `packages/editor` and `packages/review-editor` are untouched; core
is UNCHANGED at `0.25.5`, so **ui 0.44.0 publishes alone**.

### One overlay, two sources (the refactor)

`ComposerTextarea` already used exactly the right technique for skill
references: a mirrored, aria-hidden overlay rendered BEHIND a
transparent-text textarea (a textarea cannot style substrings), sharing the
font/padding/wrapping metrics and mirroring scroll, with `.pn-ref-composing`
hiding it during IME composition. Chips do not add a second overlay — two
mirrored layers could never stay pixel-aligned with each other, and only one
of them could own the scroll sync. Instead the overlay became a TOKEN
HIGHLIGHT LAYER fed by a merged list of ranges, and it turns on when EITHER
source is active.

The range computation moved out of the render loop into
`utils/composerTokens` (pure — no DOM, no styling, no React):

- `skillTokenRanges(tokens)` — today's positioned occurrences, unchanged.
- `mentionTokenRanges(text, people)` — every occurrence of each surviving
  person's readable `@Label` token.
- `mergeTokenRanges(text, groups)` — `groups` in priority order; drops
  ranges outside `[0, text.length)` and empty/inverted ones, then keeps
  earlier `start`, longer at the same start, earlier group at the same start
  and length, and drops anything beginning inside a range already kept.
  Nothing nests, so the overlay stays a flat sequence of spans.

With a single skill source this reproduces the pre-refactor loop exactly
(which dropped a token whose `start` fell behind the cursor or whose `end`
ran past the text). The component keeps the Tailwind classes and the `data-*`
attributes in `renderTokenSpan`, both so the class scanner still sees them
and so the metric rule below is read with the classes it governs.

### The chip

A chip is painted only for a person the author PICKED whose token still
survives — `useMentionAutocomplete` now also returns those survivors as
`mentions` (frozen-empty with no source, the same treatment `mentionIds`
gets), so the ranges come from the mention id model and never from a regex
over arbitrary `@words`. Editing one byte of a token un-chips it in the same
render that drops the id from `onMentionsChange`, so a chip follows the body
rather than a stale pick. The one case where the chips and the reported IDS
can still part company is the prefix case in the limitations below, which
the chips inherit rather than introduce.

```
<span data-mention-token="user_1" data-mention-kind="user" class="…">@Marcus Chen</span>
```

- `data-mention-token` is the opaque host id; `data-mention-kind` carries
  `MentionPerson.kind` verbatim — the host's styling hook. Know what that
  means today: the picker offers USERS ONLY (`mentionMatches` drops every
  person whose `kind !== 'user'`), so only a user can be picked, only a user
  can be tagged, and the attribute only ever reads `user`. `agent` is the
  reserved value for the day agents become taggable — a host rule for
  `[data-mention-kind="agent"]` matches nothing until then.
- `MentionSource.tokenClassName?: string` (new, optional) is appended to the
  span verbatim for a host that wants its own look.
- The package default is `text-primary bg-primary/15` and a 3px radius —
  the skill-reference treatment one shade stronger, so the two token kinds in
  one overlay read as siblings. Deliberately no ring: every class it uses is
  one the package already emitted, so a host's generated CSS is unchanged
  (and so is the portable guide viewer's bundle — `guide-viewer-manifest.ts`
  needed no regeneration, which is why core is untouched).

**THE METRIC RULE (and it is the host's too).** A chip may change COLOR,
BACKGROUND, BORDER-RADIUS, BOX-SHADOW and TEXT-DECORATION only. Padding,
margin, border width, font-weight, letter-spacing and font-size all move a
glyph, and the overlay's glyphs must coincide with the textarea's own layout
or the caret drifts away from the text it is painting. A pill's horizontal
breathing room is faked with `box-shadow: 0 0 0 Npx <background>`, which
paints without occupying space — that is the way to a pill look through
`tokenClassName`, and the reason the rule bans padding rather than the
appearance.

### What did NOT change

The overlay exists for the whole life of a mention composer, not only once
somebody is tagged, so the first pick never swaps the textarea element under
the caret. IME composition, scroll sync, the resize gutter, the placeholder,
the `/` + `$` skill autocomplete and its menu, the Alt-typing path, drafts
(`initialDraft` / `draftKey`), image attachments and `Mod+Enter` submit are
all untouched, and `onSubmit(text, images?, mentions?)` is the same call.
`Viewer` and `HtmlViewer` needed no change at all: they already forward
`mentionSource` (0.43.1), and the chips are inside the composer it reaches.

Three inherited limitations are worth stating rather than fixing here:

- **Two people whose labels sanitize to the same token** are
  indistinguishable in a plain-text body, so the FIRST of them listed owns
  every occurrence of it. That is the same first-match rule
  `survivingMentions` already applies to the ids; it renders and never
  throws.
- **A restored draft has no chips** until the author picks again, because
  the survivors come from the picks made in THIS composer — exactly the same
  reason `onMentionsChange` reports `[]` for a restored draft today (0.43.x
  behavior, unchanged). It reports no STALE ids either: a reopened draft
  starts with nobody tagged, so the chips and the ids agree on "none".
- **A label that is a prefix of another label** (`Ann` and `Anna Lee`, both
  picked): the CHIPS are right — longest-wins means `@Anna Lee` is painted
  whole and is never half-covered by an `@Ann` chip. The IDS are the loose
  end: delete `@Ann` from a body that still reads `@Anna Lee` and
  `survivingMentions` keeps reporting Ann, because it asks
  `text.includes('@Ann')`. So the id list can outlive the chip. That is
  0.43.x behavior in `survivingMentions`, unchanged here — the chips only
  make it visible.

### The no-op guarantee, and how it is pinned

The same components were mounted on `origin/main` and on this branch in one
harness and their `outerHTML` diffed:

- **No `mentionSource`, no `skillReferences`:** the composer is
  byte-identical — 3192 bytes, and the same `addEventListener` and
  `setTimeout` counts (287 / 1 in that harness). No overlay element exists
  at all.
- **`skillReferences` only:** the popover (4821 bytes) and the overlay
  itself (634 bytes) are byte-identical, same listener and timer counts
  (150 / 1). `data-skill-ref-overlay="true"` is written only when
  `skillReferences` is on, so a skill composer's overlay keeps the exact
  attribute list it had; a mentions-only overlay is found by its
  `data-pn-mobile-editable-mirror` attribute instead.
- A mention composer's overlay costs exactly one extra listener (the
  textarea's `scroll`, which is what mirrors the layer) — the same one a
  skill composer has always paid.
- **The portable guide viewer's build is byte-identical** (`viewer.*.js` and
  `viewer.*.css` hashes and their SRI unchanged against `origin/main`), so
  `packages/core/guide-viewer-manifest.ts` is in sync and core is untouched.
  That is also why the default chip reuses classes the package already
  emitted instead of introducing one.

**Real-browser metric proof** (headless Chromium, throwaway Vite harness):
typing `Nice catch @ma`, picking Marcus and continuing to type, the chip's
bounding rect and the textarea's own text run for that token agree to
**0.000px** on both axes and in width — at 420px and 1200px, on a wrapped
line (3 lines above it) and with the textarea scrolled (`scrollTop` 40) —
and the caret x after the token is **0.016px** from the span's end.

Tests: `utils/composerTokens.test.ts` (16, DOM-free) and
`components/CommentPopover.mentionChips.test.tsx` (11, DOM-gated, in the
workflow's DOM_TESTS step).

## Annotation card header slot and mentions on the edit box (0.45.0)

0.43.1 closed with an open question: "Editing an existing comment happens in
`AnnotationPanel`'s card, a plain textarea that has never had an `@` picker…
If you want the panel editor to pick people too, that is a separate prop on
`AnnotationPanel` and worth asking for." It was asked for, so 0.45.0 adds it —
together with the header twin of the panel's existing `renderCardFooter`.
Same ruling as the four releases before it: opt-in host capabilities that
change nothing for Plannotator's own users when they are not supplied.
`packages/editor` and `packages/review-editor` have ZERO source diff in this
release; core is UNCHANGED at `0.25.5`, so **ui 0.45.0 publishes alone**.

### 1. `renderCardHeader` — the twin of `renderCardFooter`

```ts
renderCardHeader?: (annotation: Annotation) => React.ReactNode;
```

Rendered inside each plan-annotation card's HEADER row — the row carrying the
type word, the `diff` / page / `Unanchored` chips and `author · time` — after
the timestamp and before the built-in edit/delete cluster, which keeps the
right edge on its `ml-auto`. That is the slot for a status stamp (resolved,
needs reply, a reviewer badge); the footer remains the slot for reply and
resolve UI.

It follows the footer's contract line for line:

- The wrapper is `[data-annotation-card-header="true"]` (the footer's
  `[data-annotation-card-footer="true"]` spelled for the header — the attribute
  the host queries and styles), and it stops `click` and `keydown`
  propagation, so interacting with your stamp never selects the card.
- **It renders under `readOnly`**, exactly as the footer does and for the same
  reason: the contents are host-owned and a stamp is a read affordance. The
  built-in mutation affordances stay hidden.
- In the All-files grouped view it rides the OPEN document's cards only
  (`group.isCurrent`), the footer's rule — a slot built from the open
  document's state has nothing to say about another document's card.
- Returning `null` / `undefined` / `false` for a card renders no wrapper for
  that card. Omitting the prop renders no wrapper anywhere: there is no empty
  container to lay out or style around.
- The header row is ONE non-wrapping flex line shared with the type word, the
  `diff` / page / `Unanchored` chips and the timestamp. The wrapper is
  `min-w-0` and shrinks, but a host node that cannot shrink will overflow
  toward the built-in actions rather than wrap — keep the stamp compact, or
  give it its own truncation.

**Not on `CodeAnnotation` cards.** `CodeAnnotationCard` (the review-editor
shape) takes no `renderCardFooter` either, so neither new prop was threaded
into it; mirroring the footer is the rule. Ask if a host needs both there.

### 2. `mentionSource` — the `@` picker on the card's edit box

```ts
mentionSource?: MentionSource;   // the same type, unchanged, from 0.43.0
```

Supplied on the panel and threaded to every plan-annotation card, it gives the
card's EDIT textarea the same `@` machinery `CommentPopover` has:
`useMentionAutocomplete` over the host's `people`, the portaled `MentionPicker`,
the same grammar (`@` at a word boundary, never inside `a@b.com`), the same
no-preselection keyboard rule (Enter is a newline until an arrow engages a
row), the same `onMentionsChange`, and the same `onPickBlocked` no-access
behavior (a blocked pick inserts NOTHING and the host shows its own dialog).

**Key order at the textarea.** The menu is offered the key FIRST, then the
card's own handlers run only if it did not consume the event:

- `Escape` while the menu is open closes the MENU (the hook consumes it and
  stops propagation). A second `Escape` cancels the edit, as it always did.
- `Enter` with a row arrowed to inserts that person. `Enter` with nothing
  active is untouched — still a newline.
- `Mod+Enter` is never consumed by the menu (the hook declines any event
  carrying a modifier), so save still saves.

ARIA follows `CommentPopover`: `aria-autocomplete="list"` and
`aria-haspopup="listbox"` exist only when a source is supplied,
`aria-controls` / `aria-owns` only while the menu is open, and
`aria-activedescendant` only while a row is active. With no source all five
resolve to `undefined`, so the rendered attribute list is the one the edit box
has always had.

### 3. The save rule

`handleSaveEdit` called `onEdit({ text })`. It now calls:

```ts
if (mentionSource && mentions.length > 0) onEdit({ text: editText, mentions });
else onEdit({ text: editText });
```

which is the presence rule the creation composers already keep, one level
down: **the key exists only when a source was supplied AND at least one id
survived to save.** Never `mentions: []`, never the key with an `undefined`
value — an untouched or pick-less edit calls `onEdit({ text })` byte for byte
as it did in 0.44.0, so it can never wipe tags the annotation already carries.
`source.onMentionsChange` fires from the hook exactly as it does in the
composer, which on this surface means it reports `[]` once when the editor
OPENS, before any pick: it is the live state of this edit session, not the
annotation's stored `mentions`. Only `onEdit` is authoritative — a host that
mirrors `onMentionsChange` into its own record must not treat that opening
`[]` as a clear. The Save BUTTON and `Mod+Enter` go through the same call.

**"This edit session" is literal.** The edit box was extracted into
`AnnotationEditComposer`, mounted only while a card is in edit mode, so the
hook's tagged-people state lives and dies with one session: reopen the editor
and nobody is picked, and a save with no new pick is `{ text }` again — even
if the previous session's `@Label` token is still sitting in the body. That is
the conservative direction (the host owns `mentions` from then on, 0.43.1 §4),
and it is the same reason a restored draft starts with nobody tagged.

### 4. No chips in the edit box (known difference, and the follow-up)

A picked token renders as a CHIP in `CommentPopover` (0.44.0) and as plain
text here. The chip layer is `ComposerTextarea`'s mirrored, aria-hidden
overlay behind a transparent-text textarea, with scroll mirroring and IME
handling; the card's edit box is a plain `<textarea>` with its own sizing and
classes. Duplicating that overlay for one more textarea is exactly the "two
mirrored layers" mistake 0.44.0 avoided.

**Named follow-up: move the card's edit box onto `ComposerTextarea`.** That is
the one change that gets chips here without a second overlay, and it is a
visible change to a surface Plannotator itself renders — a separate PR with
its own no-op argument, not a rider on a seam release.

Everything else about mentions is inherited unchanged and documented in the
0.43.x / 0.44.0 sections above, including the three limits: two labels that
sanitize to the same token, a restored draft reporting no ids, and a label
that is a prefix of another label.

### 5. One internal module, not a new seam

`components/MentionAutocomplete.tsx` (`MentionAutocompleteMenu` +
`mentionActiveOptionId`) is the glue between a `useMentionAutocomplete` result
and `MentionPicker` — the id→index lookup, the no-op hover and the
`aria-activedescendant` string. It exists so the third mount did not become a
third verbatim copy of the same fifteen lines; `CommentPopover`'s two mounts
were moved onto it in the same change, with no DOM difference (proven below).
It is **internal**: it is not on the supported-import list and hosts never
touch it — they pass `mentionSource`.

### The no-op guarantee, and how it is pinned

The same components were mounted on `origin/main` and on this branch in one
harness and their `outerHTML` diffed, with `addEventListener` and `setTimeout`
counts taken across each mount. With NEITHER new prop supplied, all six are
byte-identical with identical counts:

| scenario | bytes | listeners | timers |
| --- | --- | --- | --- |
| empty panel | 733 | 140 | 0 |
| nine cards (comment, deletion, global, quick label, external `source`, unanchored, `inReplyTo` reply, a card with `renderCardFooter`, a `diffContext` card) | 17543 | 141 | 0 |
| the same panel `readOnly` | 7854 | 141 | 0 |
| a card in EDIT mode | 18586 | 142 | 0 |
| the All-files grouped view (two document groups) | 19629 | 141 | 0 |
| `CommentPopover` (the module the glue refactor touched) | 3130 | 286 | 1 |

The edit-mode row is the one that matters for the hook: mounted with
`source: undefined`, `useMentionAutocomplete` registers no listener, opens no
menu state, returns the frozen empty id array, and the picker renders nothing —
one extra listener would have shown up as 143.

On top of the diff, committed tests pin the structure rather than a snapshot:
with neither prop there is no `[data-annotation-card-header]` on any card, the
edit textarea carries none of the five mention ARIA attributes, typing `@`
opens nothing, and `onEdit` is called with an updates object whose key list is
exactly `['text']`.

Tests (both DOM-gated, both added to the workflow's DOM_TESTS step):
`components/AnnotationPanel.cardHeader.test.tsx` (6) and
`components/AnnotationPanel.editMentions.test.tsx` (10).

## Publishing & versioning

- **ui 0.45.0 (annotation card header slot + mentions on the card's edit box): `@plannotator/ui` only — `@plannotator/core` is UNCHANGED at `0.25.5`, so this publishes alone** (core 0.25.5 must already be published). Purely additive over 0.44.0, both props on `AnnotationPanel`: `renderCardHeader` (the header-row twin of `renderCardFooter`, wrapper `[data-annotation-card-header]`, renders under `readOnly`, open-document cards only in the All-files view) and `mentionSource` (the 0.43.0 type, applied to the card's EDIT box, saving `onEdit(id, { text, mentions })` only when a source was supplied and a pick survived). Nothing is removed, no new supported imports (`components/MentionAutocomplete` is internal glue), no export-, share- or archive-visible change, and Plannotator passes neither — `packages/editor` and `packages/review-editor` have zero source diff, and the panel is byte-identical to 0.44.0. Known difference from `CommentPopover`: no chips in the card's edit box (follow-up named in the section). See "Annotation card header slot and mentions on the edit box (0.45.0)".
- **ui 0.44.0 (mention token chips in the composer): `@plannotator/ui` only — `@plannotator/core` is UNCHANGED at `0.25.5`, so this publishes alone** (core 0.25.5 must already be published). Purely additive over 0.43.2: the `@Label` tokens a `mentionSource` composer inserted render as chips in the composer's existing highlight overlay, `MentionSource.tokenClassName?` lets a host restyle them (under the metric rule), `useMentionAutocomplete` also returns the surviving `mentions`, and `utils/composerTokens` joins the supported-import list. Nothing is removed, no export-, share- or archive-visible change, and Plannotator passes none of it — with neither `mentionSource` nor `skillReferences` the composer is byte-identical to 0.43.2. See "Mention token chips in the composer (0.44.0)".
- **ui 0.43.1 (`mentionSource` on the viewers): `@plannotator/ui` only — `@plannotator/core` is UNCHANGED at `0.25.5`, so this publishes alone** (core 0.25.5 must already be published). Purely additive over 0.43.0: `mentionSource` on `Viewer` and `HtmlViewer` (forwarded to every comment composer each mounts) and the optional `Annotation.mentions` field the picked ids land on, set only when a source was supplied and a token survived. Nothing is removed, no new modules, no export-, share- or archive-visible change, and Plannotator passes none of it. See "`mentionSource` on the viewers (0.43.1)".
- **ui 0.43.0 (host toolbar seams): `@plannotator/ui` only — `@plannotator/core` is UNCHANGED at `0.25.5`, so this publishes alone** (core 0.25.5 must already be published). Purely additive: `selectionActions` + `quickLabels` on `AnnotationToolbar` (forwarded by `Viewer`; `selectionActions` also by `HtmlViewer`), `mentionSource` on `CommentPopover`, an optional third `mentions` argument on that component's `onSubmit`, and the new supported modules `utils/selectionActions`, `utils/mentions`, `components/SelectionActionsDropdown`, `components/MentionPicker`, `hooks/useMentionAutocomplete`. Nothing is removed and Plannotator passes none of it. See "Host toolbar seams (0.43.0)".
- **core 0.25.5 / ui 0.42.0 (diagram FILES, `.mmd`/`.mermaid`/`.dot`/`.gv`): additive on both packages, so the next publish is core-first.** `@plannotator/core/annotatable` gains `DiagramRenderKind`, `diagramRenderKindForPath`, `isDiagramRenderKind` and `annotateDiagramRenderKind`, and its built-in annotatable sets now include the four diagram extensions (`shouldStripFrontmatter` returns false for them — Mermaid's `--- … ---` config block is content — and they can no longer be registered through `markdownExtensions`). `@plannotator/ui` gains `diagramDocumentBlocks(text, kind)` on `utils/parser` (the ONE `code` block a whole-file diagram source renders as), `shareableDocumentMarkdown(markdown, renderAs)` on `utils/sharing`, the `DocumentRenderAs` type on `types` (`'markdown' | 'html' | DiagramRenderKind`, re-exporting core's kind), and an optional `Block.diagramSourceLineOffset` that `DiagramBlock` prefers over `Block.startLine` when resolving a diagram comment's `sourceLine` (unset on every parser-produced fence, so fences are byte-identical). `useLinkedDoc`'s `renderAs`/`setRenderAs`/`LinkedDocLoadData.renderAs` widen from `'markdown' | 'html'` to `DocumentRenderAs` — source-compatible for a host that only ever passes the old two, but a host whose own state is typed `'markdown' | 'html'` must widen its setter. Since core changes, **publish `core` first** and update UI's exact core dependency before packing ui.
- **The current pair is `@plannotator/ui` `0.41.2` on `@plannotator/core` `0.25.4`.** Core is UNCHANGED from 0.41.1, so 0.41.2 publishes alone (`ui` only; core 0.25.4 must already be published). 0.41.2 ships the palette-derived Mermaid node shadow at a default of 70% (`DEFAULT_MERMAID_SHADOW_AMOUNT`) and the Settings → Display "Diagram Shadow" control (0 / 40 / 70 / 100); see "Node shadow (the one thing that is not a colour)" under "Theme-aware Mermaid diagrams (0.40.0)" for the mapping — no API removal, only additive exports (`buildMermaidShadow`, `DEFAULT_MERMAID_SHADOW_AMOUNT`, `utils/diagramShadow`).
- The pair 0.41.1 shipped as was `@plannotator/ui` `0.41.1` on `@plannotator/core` `0.25.4`. Core is UNCHANGED from 0.41.0, so 0.41.1 published alone (`ui` only; core 0.25.4 must already be published). 0.41.1 is two fixes over 0.41.0 with no API change — the diagram engine is loaded lazily by the first diagram fence instead of riding every document read, and a press on the canvas's own controls no longer comments on the part behind them; see "0.41.1 — the engine is lazy, and the controls are not part of the diagram". The 0.41.0 notes below still describe the engine itself.
- **The pair 0.41.0 shipped as was `@plannotator/ui` `0.41.0` on `@plannotator/core` `0.25.4`. Publish `core` 0.25.4 first, then `ui` 0.41.0** (both by hand from `main` after merge; CI never publishes these packages). 0.41.0 is the diagram engine (see "Diagram engine (0.41.0)"): one renderer slot and one canvas behind `MermaidBlock` / `GraphvizBlock`, the `components/diagram` surface, the Graphviz runtime slot with `@viz-js/viz` pinned `3.30.0`, and `Annotation.diagramAnchor`; core 0.25.4 adds the `diagram-anchor` subpath ui imports, so a ui 0.41.0 on a published core 0.25.3 would fail to compile in a consumer.
- The previous pair was `@plannotator/ui` `0.40.0` on `@plannotator/core` `0.25.3` (publish order the same). Three things shipped in 0.40.0: (1) **Mermaid 12.0.0**, pinned exactly (was `^11.17.2`): ELK layout by default for flowchart/state/class/ER/requirement, Safari 17.4+ / ES2024 floor, SVG ids byte-identical to 11 but `g.edgePaths` children now in declaration order, and the plan editor no longer imports `utils/mermaid-eager` (the lazy path is the default for everyone; hosts that want startup registration import the eager entry themselves) — see "Mermaid 12 (0.40.0)"; (2) **theme-aware Mermaid diagrams**: New additive exports `utils/mermaidTheme` (`buildMermaidThemeVariables`, `readThemeTokens`, `applyMermaidTheme`, `mermaidThemeKey`, `buildMermaidConfig`, `ensureContrast`, `isDarkBackground`, `MERMAID_THEME_TOKEN_NAMES`) and `utils/cssColor` (parser + OKLab/contrast toolkit). `MermaidBlock` now calls `useTheme()` and `applyMermaidTheme` before each render; `MERMAID_CONFIG`, `loadMermaidRuntime`, `mermaid-eager` and `securityLevel: 'strict'` are unchanged. A host whose document carries no theme tokens renders diagrams byte-identically to 0.39.0; a host that mounts `ThemeProvider` with `theme.css` gets diagrams in its palette and mode with no configuration. No new peer dependencies; core unchanged. See "Theme-aware Mermaid diagrams (0.40.0)".; (3) **element context through the host seam (#1521, #1549), which is what moves `core` to 0.25.3:** `@plannotator/core/html-anchor` gains `parseHtmlElementContext`, `MAX_ELEMENT_CONTEXT_BYTES` and `MAX_PAGE_URL_LENGTH`; `PersistedHtmlAnchor.elementContext?` and `HtmlAnnotationTarget.context?` now round-trip through `buildPersistedHtmlAnchor` and `projectHostThreads`. **Core changes here, so bump and publish `core` first** and update UI's exact core dependency before packing ui — a ui build that imports these from an older published core fails to compile in a consumer, the 0.38.0 failure mode. `@plannotator/ui/components/html-viewer` re-exports the validator, so 0.39.0's import site is unchanged, and rows without context stay byte-identical on the wire. `utils/parser` gains `includeOutline` on `elementContextExportBlock` / `exportAnnotationEntry`, and `exportAnnotationEntry`'s `includeRoute` now defaults to true per field. See "Element context through the host seam".
- The previous pair was `@plannotator/ui` `0.39.0` on `@plannotator/core` `0.25.2` (core unchanged; nothing under `packages/core` moved). UI 0.39.0 adds **element context** to raw-HTML and live-app pinpoint annotations (#1517, #1520): a new optional `Annotation.elementContext` (`HtmlElementContext` in `@plannotator/ui/types`) and `HtmlAnnotationTarget.context`, captured by the bridge at click time (tag, id, author classes, ancestor `path`, `role`, accessible `name`, an allowlisted `attrs` set with href/src scrubbed of query and fragment, rendered `text`, an adaptive collapsed HTML `outline`, child count, viewport `rect`, nearest `landmark` and `heading`, a `component` hint, and in live-app sessions `page`), hard-capped at 2 KiB serialized per primary and 1 KiB per extra target, and re-validated at the parent trust boundary by the new `parseHtmlElementContext` export of `@plannotator/ui/components/html-viewer`. New helpers on `@plannotator/ui/utils/parser`: `elementContextExportBlock(ann, { includeRoute })` (the fenced skeleton plus selector/path/role/name/attrs/text/box/near lines the full export now prints under a context-bearing comment) and `exportAnnotationEntry(ann, { includeRoute })` (one annotation as a standalone feedback entry, a pure helper for hosts; `AnnotationPanel`'s card chrome is unchanged from 0.38.2). The field is purely descriptive: `HtmlElementAnchor` and restore are untouched, no `BRIDGE_PROTOCOL_VERSION` bump, share links drop it like anchors, annotations without it export byte-identically, and the repaint path posts only anchors to the bridge. **Host persistence gap in 0.39.0 itself, closed in the next publish (#1521, #1549)**: as shipped, 0.39.0's `@plannotator/core/html-anchor` (`buildPersistedHtmlAnchor`, `projectHostThreads`) does not carry `elementContext`, so a host pinned to 0.39.0 that persists through those helpers drops it on save and must persist and project the field itself. The next publish carries it end to end — see "Element context through the host seam". Peer ranges are unchanged from 0.38.2: `react` / `react-dom` `^19.2.3`, `tailwindcss` as before, and `@codemirror/state ^6.7.2` beside `@codemirror/view ^6.43.10`. Decision-control change in the same window (#1516): the header primary reads `Send Feedback` / `Post Comments` with no inline count (`DecisionPrimary.count` removed; internal, not host-supported surface).
- Before that, `@plannotator/ui` `0.38.2` on `@plannotator/core` `0.25.2`. UI 0.38.2 keeps the type word in a titled alert's accessible name through a visually hidden `sr-only` span before the title instead of an `aria-label` on the title row (naming a generic `div` is prohibited by ARIA and WebKit drops it, so VoiceOver on Safari read only the bold title in 0.38.1), and loosens the React peer back to `^19.2.3` (0.38.1 declared `^19.2.8` only because the dependency batch moved it; nothing in the package needs a newer API). **Do not consume ui 0.38.0**: it imports `@plannotator/core/token-hover` (the hover-card trigger settings, #1462) but pins core 0.25.1, which never exported that subpath, so it fails to compile in any consumer; 0.38.1 is the same UI pinning core 0.25.2, which publishes `./token-hover`, the rotated `guide-viewer-manifest` pin, and the `config-types` hover fields (core 0.25.2 is the first core publish since 0.25.1 even though those changes landed over several releases; the package smoke now diffs the UI's core imports against the registry so an unpublished core subpath fails preflight instead of the consumer). UI 0.38.1 also aligns `@codemirror/state` to `^6.7.2` beside `@codemirror/view ^6.43.10`, so a consumer can no longer resolve two state copies. UI 0.38.0 also renders a GitHub alert's bold-only first body line as its title on the icon row (an emoji on that line becomes the icon; `<!-- icon: name -->` is stripped and resolved through the new `alertIconRenderer` seam, null by default; grammar in `utils/alertTitle`, importable by a host editor so it writes the bytes the reader parses; a fenced code block inside an alert body still renders as text, deferred because nesting a `CodeBlock` inside a block interacts with the positional annotation anchors and needs its own design). UI 0.38.0 carries the whole unified decision-control stack: the internal primitives (`DecisionControl`, `utils/decisionSpec`, `hooks/useDismissablePopover` — not host-supported surface, see the unsupported list; `useDismissablePopover` also replaced the hand-rolled dismissal inside `ActionMenu`/`ApproveDropdown`, both likewise unsupported) plus one blessed-barrel addition: `decisionControlShortcuts` on `@plannotator/ui/shortcuts` (pure scope data, fetch-free, same contract as the other scopes). The removal of `ToolbarButtons`' platform-mode `muted` prop is internal — `ToolbarButtons` is not host-supported surface. UI 0.37.0 added the Viewer-owned document-header seam (a new public API, hence the minor bump; 0.36.1 was reserved for it but never published) while retaining the `hideQuickLabel` and `StickyHeaderLane` seams from the 0.35.x and 0.36.0 releases; core 0.25.1 publishes the `annotation-threads` subpath already used by `AnnotationPanel` and `utils/parser`, and UI pins that corrected core exactly.
- Recent pairs, for the consumer's install matrix: ui 0.32.0 on core 0.25.0 (lockstep, `html-anchor`), ui 0.33.0 and ui 0.34.0 on core 0.25.0 (ui only), and ui 0.35.2, ui 0.36.0, and ui 0.37.0 on core 0.25.1 (0.36.1 was never published), ui 0.38.1, ui 0.38.2, and ui 0.39.0 on core 0.25.2, and ui 0.40.0 on core 0.25.3 (lockstep, `html-anchor` element context). Do not consume ui 0.35.0 externally because its published manifest contains `workspace:*`; do not consume ui 0.35.1 because its exact core 0.25.0 dependency lacks the `annotation-threads` export. Do not consume ui 0.38.0 because its exact core 0.25.1 dependency lacks the `token-hover` export.
- When both packages change, **publish `core` first**: ui 0.32.0 imports the `@plannotator/core/html-anchor` subpath, which no earlier published core (0.24.0 and before) has, just as ui 0.29.0 needed core 0.23.0 for `@plannotator/core/annotatable`. Bump core, update UI's exact core dependency to the same new version, and run `bun install` so `bun.lock` records the new workspace versions before packing either package.
- The HTML annotation seams also changed the guides.show viewer **stylesheet** (five utility rules from `HtmlSurfaceControls`; the viewer JS is unchanged), so `packages/core/guide-viewer-manifest.ts` now pins a CSS hash that exists on guides.show only after the deploy workflow has published this build's `/v1/` assets. A guide exported from this build before that deploy would pin a stylesheet the host does not serve yet: **deploy guides.show before any release that ships this manifest.**
- UI declares the already published core version exactly in its source manifest. Do not replace it with `workspace:*`: direct publication can preserve that protocol and make the package impossible to install outside this repository. Bun links the local core workspace whenever its version matches the exact dependency. Before publishing, run `bun run --cwd packages/ui smoke:package`; it checks the source and packed manifests, required tarball subpaths, local Bun linking, and a real pnpm install in an external temporary consumer. When both packages change, publish **`core` first, then `ui`**.
- **`--provenance` only works from a supported CI environment (GitHub Actions OIDC)** — a local publish fails with `Automatic provenance generation not supported for provider: null`. Until a CI publish job exists for these two packages, local publishes drop the flag. Publishing under `--tag next` first lets the consumer preflight before `npm dist-tag add <pkg>@<version> latest` promotes it.
- `styles.css` is built by the `prepack` script (`bun run build:css`) so the published tarball always carries fresh precompiled CSS; since 0.33.0 `prepack` also runs `build:bridge-assets`, which generates the gitignored `bridge-script.asset.js` and `bridge-script.lite.ts` beside their source. Both are in `files`, so a tarball built without `prepack` (a hand-rolled `npm pack --ignore-scripts`) would ship export subpaths that resolve to nothing; always build with `bun pm pack`.
- There is **no CI publish job for these two packages yet** — first publish is manual from `main` after merge. (Wiring a CI publish job is a follow-up.)

---

## The law (guardrails for anyone editing `@plannotator/ui`)

These are enforced socially and, where possible, by CI. They exist because a prior from-scratch reimplementation of this UI broke the app and was reverted.

1. **Don't reimplement the document UI from scratch.** Add a seam; don't rebuild.
2. **Every seam's default must reproduce today's Plannotator behavior.** Plannotator passes nothing and stays byte-for-byte unchanged.
3. **`@plannotator/core` is browser-safe and zero-dep — no `node:` imports.** CI enforces it.
4. **Never delete working Plannotator code until a human confirms parity in the browser.**

See `packages/ui/README.md` and `packages/ui/AGENTS.md` (CLAUDE.md symlink) for the short version that lives next to the code.
