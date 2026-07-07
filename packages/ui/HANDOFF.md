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
| `components/InlineMarkdown` | Code-file hover previews route through the `docPreviewFetcher` seam. |
| `components/Viewer` | The full annotatable document. Required props: `markdown` and `taterMode` (pass `false`). **Pass `disableCodePathValidation` unless you implement `/api/doc/exists`** — code-path validation is a prop-level opt-out, not a `configure` seam. |
| `components/MarkdownEditor` | Theme-bridging wrapper over `@plannotator/markdown-editor`. See the Yjs note below. |
| `components/CommentPopover` | Anchor capture + comment entry. Ask-AI UI renders only if you pass `onAskAI`. |
| `components/AnnotationPanel` | Renders from your annotation state; no fetches of its own. |
| `components/ThemeProvider` | Color-mode context. |
| `components/ImageThumbnail` / `getImageSrc` | Routes through `imageSrcResolver`. |
| `components/AttachmentsButton` | Routes through `uploadTransport`. |
| Seam-backed hooks: `useAnnotationHighlighter`, `useAnnotationDraft`, `useCodeAnnotationDraft`, `useExternalAnnotations`, `useFileBrowser` | Their network access goes through the seams in the catalog above. |
| `config` (`ConfigStore`) | Persists through `storageBackend`. |

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

If Workspaces ever wants one of these surfaces, the path is the same as everything else: add a seam to the module in a Plannotator PR, don't fork the component.

### Math rendering (KaTeX): one-time setup if you render equations

The renderer's `MathBlock` (and inline math) uses KaTeX. **KaTeX's stylesheet and its ~1.1MB of math fonts are deliberately NOT in the published `styles.css`** — bundling them would 9x the CSS for every page load, math or not. This is app-developer setup, done once; end users never touch it. Pick one:

1. **Self-hosted (recommended for production):** copy `katex/dist/katex.min.css` + `katex/dist/fonts/` to your own asset origin and add one `<link rel="stylesheet">`. No third-party dependency in your serving path; fonts download lazily, only on pages that actually render math.
2. **CDN tag:** `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@<version>/dist/katex.min.css">` in your HTML — pin `<version>` to the `katex` version in `@plannotator/ui`'s package.json so CSS and the bundled KaTeX JS stay in step. Same lazy-font behavior; adds a third-party origin.
3. **Bundler import:** `import 'katex/dist/katex.min.css';` next to your `styles.css` import — your bundler ships the fonts as separate lazy-loaded files. With npm/bun this resolves out of the box (`katex` is a dependency of `@plannotator/ui` and gets hoisted); under pnpm's strict `node_modules`, add `katex` to your own dependencies to import it directly.

If you skip all three and render math, equations appear as broken-looking raw HTML — that's the symptom to recognize. If you never render math, do nothing.

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

---

## Known rough edges (and why they're fine for now)

1. **`AITransport` / `FileTreeBackend` leak `Response`.** They return raw fetch `Response` objects instead of clean domain types (`{ sessionId }`, `AsyncIterable<AIMessage>`, `{ tree, workspaceStatus }`). A reviewer correctly flagged this. We kept it deliberately: the goal of this PR was **move-don't-rewrite**, and reshaping these contracts is exactly the kind of redesign that's better driven by the real consumer (Workspaces) once you feel the pain. Plan a v2 pass on these two once you've wired them.

2. **`InlineMarkdown.tsx` is large (~1k lines)** and now hosts the `docPreviewFetcher` seam inline. Cheap future cleanup: extract the doc-preview seam into its own module so the renderer shrinks. Not blocking.

3. **Module-level singletons, not a Provider.** Covered above — safe because Workspaces is client-side, not SSR. Only revisit if SSR is added.

4. **The markdown editor can't take live-collab extensions yet.** Live multi-user editing is a hard requirement for Workspaces (its ADR 0010), and the underlying editor (`@atomic-editor/editor`, CodeMirror 6) supports extensions — but **neither wrapper layer exposes them**: `@plannotator/markdown-editor`'s `MarkdownEditorProps` has no `extensions` prop, and `@plannotator/ui`'s `MarkdownEditor` wrapper therefore can't pass one. So today you cannot thread `y-codemirror.next` (or any CM6 extension) into the editor. **Do not treat live editing as available in this release.** The plan of record (updated now that the editor is forked as `github.com/plannotator/atomic-editor`, published as `@plannotator/atomic-editor`): one atomic change threading an optional `extensions?` prop through `@plannotator/atomic-editor` and `@plannotator/markdown-editor`, then a version bump here — no monorepo import needed. Single-user editing works today; the first Workspaces UI slice doesn't need live collab.

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

## Publishing & versioning

- `@plannotator/core` and `@plannotator/ui` are versioned **in lockstep with the repo** (`@plannotator/ui` is now `0.23.0`; `@plannotator/core` is untouched by the Base UI migration and remains `0.22.0` until its next change — the ui→core dependency still resolves exactly at pack time).
- They depend on each other via `workspace:*`. At publish time that must resolve to the **exact** version in the tarball, so publish with a tool that does that resolution (the repo's existing flow uses `bun pm pack` to build the tarball, then `npm publish *.tgz --provenance --access public`). Publish **`core` first, then `ui`**.
- `styles.css` is built by the `prepack` script (`bun run build:css`) so the published tarball always carries fresh precompiled CSS.
- There is **no CI publish job for these two packages yet** — first publish is manual from `main` after merge. (Wiring a CI publish job is a follow-up.)

---

## The law (guardrails for anyone editing `@plannotator/ui`)

These are enforced socially and, where possible, by CI. They exist because a prior from-scratch reimplementation of this UI broke the app and was reverted.

1. **Don't reimplement the document UI from scratch.** Add a seam; don't rebuild.
2. **Every seam's default must reproduce today's Plannotator behavior.** Plannotator passes nothing and stays byte-for-byte unchanged.
3. **`@plannotator/core` is browser-safe and zero-dep — no `node:` imports.** CI enforces it.
4. **Never delete working Plannotator code until a human confirms parity in the browser.**

See `packages/ui/README.md` and `packages/ui/AGENTS.md` (CLAUDE.md symlink) for the short version that lives next to the code.
