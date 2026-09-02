# @plannotator/ui

Plannotator's document UI — markdown rendering, themes, the annotation editor, settings, comments, and layout — as installable building blocks. Published so a separate app (the commercial Workspaces app) can reuse the exact same experience, while Plannotator itself stays unchanged.

Ships with **`@plannotator/core`**: a small, browser-safe, zero-dependency package of the pure utilities and types `ui` builds on (carved out so `ui` can be installed standalone without Plannotator's server code).

## Why this exists

Workspaces needs the same document experience Plannotator has — render docs, annotate, comment, theme, edit — but backed by its own infrastructure (its own storage, auth, realtime, AI). Rather than fork or rebuild, it **installs these packages and plugs in its own backend.** Plannotator passes nothing and behaves exactly as before.

## How it works: host-override seams

Every place the UI talks to a backend (loading a doc preview, saving settings, persisting drafts, streaming comments, listing files, calling AI, etc.) is an **optional seam** that defaults to Plannotator's behavior. A host swaps in its own implementations through **one call at startup**:

```ts
import { configurePlannotatorUI } from "@plannotator/ui/configure";

configurePlannotatorUI({
  storageBackend,              // where settings persist
  identityProvider,           // who the current user is
  imageSrcResolver,           // how image paths resolve to URLs
  docPreviewFetcher,
  fileTreeBackend,
  draftTransport,
  externalAnnotationTransport, // live/agent comments
  aiTransport,
  skillCatalogTransport,       // skill-reference catalog for comment composers
  skillContentTransport,       // human-only skill contents for feedback injection
  serverSync,
  webmcp,                      // browser-agent (WebMCP) provider policy: { enabled, namePrefix }
  mathRendererLoader,          // how KaTeX loads when no renderer is registered before first math render
  identityGenerator,           // sync generator behind the default "tater" name (no identityProvider)
});
```

Anything you don't pass keeps Plannotator's default. A few component-specific overrides (e.g. an "open in editor" diff action) are passed as props where you render that component.

### Resize-handle seams (`ResizeHandle` / `useResizablePanel`)

The sidebar/panel resize handle exposes seams for hosts that want different edge interactions (e.g. no hover reveal, click-to-collapse). All default to today's behavior — pass nothing and it's unchanged.

- **Suppress / restyle the hover reveal.** The inner visible track carries a `[data-resize-track]` attribute (same host-CSS pattern as the collapse button's `[data-collapse]`), and `ResizeHandle` takes a `trackClassName` prop. To kill the pop-in from host CSS:
  ```css
  [data-resize-track] { background: none !important; }
  ```
- **Click-to-collapse anywhere on the handle.** The handle can't tell a click from a drag-start on its own — the hook owns the pointer state machine. Pass `onClick` to `useResizablePanel`; it fires on pointer-up only when the pointer never traveled past `clickThreshold` (default 4px), so a genuine click on the full-width handle can collapse the panel while drags still resize:
  ```ts
  const resize = useResizablePanel({ storageKey, side: "left", onSnapClose: collapse, onClick: collapse });
  ```

Building your own tooltip and removing the built-in double-click reset are host-side concerns (override `onDoubleClick` where you render the handle).

### Lazy renderers and the eager entries (`utils/math`, `utils/generateIdentity`, `utils/mermaid`; 0.32.0)

The Mermaid runtime, the Graphviz engine, KaTeX and the username dictionary are off the static import graph of `Viewer`, so a host that bundles by route does not download them for a plain markdown read. Graphviz needs nothing from you (the block imports the engine inside its render effect and shows the source fence until the SVG lands, as it always did). Mermaid, KaTeX and the dictionary sit behind synchronous slots:

- **Math.** Without registration, a math node renders its TeX as text in the same wrapper (same `data-math-tex` / `data-math-display` / `aria-label` / class names), loads KaTeX via `import('katex')`, and re-renders typeset. To keep math typeset on the very first commit, as Plannotator does, add one line to your entry: `import "@plannotator/ui/utils/math-eager";`. To put KaTeX and its stylesheet on one lazy chunk instead, pass `mathRendererLoader`. The stylesheet remains your job either way (see "Consuming it", step 3). The default `import('katex')` is the only runtime mention of `katex` in the package and lives in `utils/math-default-loader` (0.33.0), called only while no loader is registered; a registered loader is never backfilled by it, though a default load already in flight at registration still fills the slot (pre-existing), so register the loader before the first math render. Chunk emission is static, so a bundler still emits that chunk (never requested) unless you alias the module away; see HANDOFF.md "Lazy renderers and eager entries" for the two-line alias. The Mermaid runtime has its own `import("katex")` for `$$` labels, which leaves a second, shared KaTeX chunk in a host build even with the alias; since 0.34.0 a host redirects that one import (for importers inside the `mermaid` package only) to `@plannotator/ui/utils/mermaid-math-slot`, which typesets the labels through your registered renderer, so one KaTeX chunk remains and it is yours. Recipe and measurement in HANDOFF.md, same section. `resetMathRenderer()` empties the slot only and keeps a registered loader (0.34.0); `setMathRendererLoader(null)` is the explicit way back to the package default.
- **Mermaid.** Without registration, the first diagram on a page fetches the runtime through `import('mermaid')`; a failed import is dropped from the memo, re-attempted once after a short delay, and the error panel (with the source) offers Retry, which issues another fresh attempt. Plannotator keeps Mermaid eager by policy so it can never fail separately from the app: `import "@plannotator/ui/utils/mermaid-eager";` in your entry does the same for your bundle. Honest limit of any in-page retry: a browser records a failed module fetch in its module map for the page lifetime, so a fresh `import()` of the same chunk URL rejects without a request; the retry recovers failures after the fetch (engine instantiation, initialize) and hosts that version chunk URLs. A host that needs recovery from a failed first fetch uses versioned chunk URLs or a `vite:preloadError` reload at app level.
- **Identity.** With an `identityProvider` the generator is never called and the word lists stay out of your bundle. Without one, default names come from a small built-in pool of the same `adjective-noun-tater` shape; `import "@plannotator/ui/utils/identity-tater";` registers the full dictionary, or pass your own `identityGenerator`.

Plannotator's own entries import the eager modules (`math-eager` and `identity-tater` in both `packages/editor/App.tsx` and `packages/review-editor/App.tsx`; `mermaid-eager` in the plan editor only, since the review editor never renders a Mermaid block), which is what keeps its single-file builds byte-identical and its portal entry chunk shaped as before; `tests/entry-assets.test.ts` fails if any of them is dropped. See HANDOFF.md "Lazy renderers and eager entries".

### Markdown editor extensions + wiki links (`MarkdownEditor` / `InlineMarkdown`)

- **`MarkdownEditor` takes CM6 extensions.** `extensions?: readonly Extension[]` (from `@codemirror/state`) is forwarded verbatim into the underlying editor — the seam for `wikiLinks(config)`, `y-codemirror.next` collab bindings, custom keymaps.

  > **⚠️ Captured once per `documentId` — not reactive.** The engine reads the array a single time at document mount; swapping the array later is silently ignored until a `documentId` change remounts. Pass a stable reference, and feed changing data through extension config callbacks that close over live state (refs/getters) — never through new arrays.

- **`wikiLinks` is re-exported from `@plannotator/ui/components/MarkdownEditor`** together with `WikiLinksConfig`, `WikiLinkSuggestion`, `WikiLinkResolvedTarget`, `WikiLinkStatus`. Import it from there — `@plannotator/atomic-editor` stays off the supported-import list:
  ```tsx
  import { MarkdownEditor, wikiLinks } from "@plannotator/ui/components/MarkdownEditor";

  const editorExtensions = [wikiLinks({ suggest, resolve, onOpen })]; // stable reference!
  <MarkdownEditor markdown={md} documentId={docId} editorHandleRef={ref} extensions={editorExtensions} />
  ```
- **`embedPicker(config)` and `embedSlashItem()` are re-exported from the same surface.** Compose the static item into `slashCommands({ items: [...] })` and pass the picker beside it in the stable `extensions` array. `getTargets`, `buildInsertLine`, optional `uploadTarget`, and optional `getNotice` stay live through callbacks. The host owns embed grammar and upload error UI; the package owns filtering, async anchor mapping, single-flight upload state, and paragraph-safe insertion through the re-exported `planEmbedInsert()`.
- **The viewer resolves wiki-links synchronously.** `InlineMarkdown` takes `resolveLinkedDoc?: (target) => { label?; status?: 'active' | 'deleted' } | null` — called with the raw stored target (opaque ids like `doc_01XYZ`, no `.md` normalization). Return a `label` to display live titles (stored label is the fallback, target the last resort); return `status: 'deleted'` for a muted non-link ("Document deleted") instead of a live link. Absent or `null` → rendering is unchanged. Sync-only by design: back it with an in-memory cache.

Requires `@plannotator/markdown-editor ^0.3.2` and `@plannotator/atomic-editor ^0.7.0`. See HANDOFF.md § "Wiki-link seams (0.27.0)".

### Frozen markdown diff (`MarkdownDiff`)

- **`MarkdownDiff` renders two markdown revisions as a frozen, themed comparison** — the newer revision as the real (uncollapsed) document, deletions projected struck-through in place, char/word change emphasis, a change-count toolbar with prev/next, a clickable keyboard-accessible overview rail, and a changed-line gutter. The surface is never editable (edits are rejected at the state and view boundaries; the content DOM is `contenteditable="false"`).
- **Same shim pattern as `MarkdownEditor`:** theme resolves from `ThemeProvider` (or pass `mode` directly), `gridEnabled` applies the identical card chrome, and `extensions` composes CM6 extensions — `wikiLinks` included — into the frozen view, with the same captured-once, stable-reference calling convention:
  ```tsx
  import { MarkdownDiff } from "@plannotator/ui/components/MarkdownDiff";
  import { wikiLinks } from "@plannotator/ui/components/MarkdownEditor";

  const diffExtensions = [wikiLinks({ resolve, onOpen })]; // stable reference!
  <MarkdownDiff originalMarkdown={older} modifiedMarkdown={newer} documentId={docId}
                editorHandleRef={ref} extensions={diffExtensions} />
  ```
- **Bytes are the contract:** `ref.current.getMarkdown()` / `.getOriginalMarkdown()` return the exact input strings (CRLF and trailing whitespace included); `getChangeCount()` / `goToNextChange()` / `goToPreviousChange()` drive review navigation.

Requires `@plannotator/markdown-editor ^0.4.0` and `@plannotator/atomic-editor ^0.8.0` (which adds a `@codemirror/merge` peer — declared by this package). See HANDOFF.md § "Frozen markdown diff (0.28.0)".

### Raw-HTML annotation viewer (`HtmlViewer`)

`components/html-viewer` is supported host surface as of 0.29.0: the overlay-projection annotation viewer for raw HTML (placed comment markers, pinpoint element anchors, shift-click multi-target comments). Its contract is **props plus the validated iframe message protocol** — not `configurePlannotatorUI()`, which only governs the backend surfaces around it. Drive the `annotations` prop (marker numbering derives from its array order); `readOnly` keeps markers painted and clickable while disabling all authoring. **0.29.0 also carries a breaking migration:** highlight.js is gone and `.hljs` selectors are inert — style code via the exported `pn-code` class (`CODE_BLOCK_CLASS` in `utils/codeHighlight`). See HANDOFF.md § "Raw-HTML annotation viewer + syntax-highlighting migration (0.29.0)" before upgrading from 0.28.0.

#### HTML annotation parity seams (0.32.0)

Everything a host needs around `HtmlViewer` to match Plannotator's HTML annotation experience, all additive and all defaulting to today's behavior. Requires `@plannotator/core` 0.25.0 (the `html-anchor` subpath), so install and publish core before ui:

- **`projectHostThreads(threads, { openOnly?, documentLevel?, maxTargets? })`** and **`buildPersistedHtmlAnchor(source, { maxBytes?, maxTargets? })`** from `components/html-viewer` (pure, from `@plannotator/core/html-anchor`): project stored rows onto the `annotations` prop in the order that becomes the marker numbering, and trim a composed comment's anchor for persistence with cap drops and size drops reported separately. A row with nothing restorable projects as a document-level `GLOBAL_COMMENT` by default (`documentLevel: 'global'`, never reported as unanchored) or, with `documentLevel: 'unanchored'`, as a textless page `COMMENT` the unanchored report names. **HTML-only:** the projection carries `originalText`, `htmlAnchor` and `htmlAdditionalTargets`, and pins `blockId` to `""`, offsets to `0` and no `startMeta` / `endMeta`; on the markdown `Viewer` a projected `COMMENT` with quoted text still re-anchors by whole-document text search, but with `blockId` `""` and offsets `0` it loses export ordering (every such row sorts first and ties), the "lines N-M" location label, disambiguation when the same text repeats (first match wins), and the no-flash meta restore; a host that needs those carries `blockId`, the offsets and the web-highlighter metas in its own projection.
- **`onUnanchoredChange`** is keyed to the bridge's restore (one complete report per document after the restore batch, the empty set included) and complete over the `annotations` prop: textless page rows are reported without being posted, and a locally minted id the host swapped out of its list is not. It replaces a host's `mark-applied` bookkeeping for the unanchored set; the local-to-server mark swap itself stays host-side. **Nothing is delivered before the bridge's first post-restore report for a document (per reload generation):** a prop-side change before that point does not fire the callback, so do not gate host state on a prop-side delivery arriving first; treat the first call as the restore's verdict.
- **`hooks/useHtmlRefresh({ fetchSnapshot, onSnapshot, onUnanchored?, onResult? })`**: the refresh cycle with the stale-response and document-change guards, backend behind `fetchSnapshot`.
- **`components/HtmlSurfaceControls`**: the eye / refresh / pen header controls with Plannotator's markup and `labels` overrides.
- **`AnnotationPanel` `unanchoredIds`**: an "Unanchored" chip on the listed cards.
- **`HtmlViewer` `scrollBehavior`** (`'auto'` for reduced motion) and **`maxAdditionalTargets`** (a product cap the bridge honors too). With the cap enforced upstream (bridge toggle, parent trust boundary on submit and on restore, `projectHostThreads` `maxTargets` on read), a composed comment never reaches the host with more targets than the cap, so a host's own cap-dropped handling (`capDroppedTargets` from `buildPersistedHtmlAnchor`, or a message-counting listener) is unreachable in normal operation; keep it only as a backstop for rows written by an older host build or by another writer. Byte-budget drops (`sizeDroppedTargets`) are a separate path and remain reachable.
- An `ExternalAnnotationTransport` whose `subscribe` emits `snapshot` on a host push keeps `useExternalAnnotations` off its fallback poll.

See HANDOFF.md § "HTML annotation parity seams".

#### The bridge script as an asset (`bridgeScriptUrl`; 0.33.0)

By default `HtmlViewer` inlines its 185 KB in-page bridge script into every srcdoc document. A host that serves the package's generated `components/html-viewer/bridge-script.asset.js` as a static file can pass its URL instead:

```ts
import bridgeScriptUrl from "@plannotator/ui/components/html-viewer/bridge-script.asset.js?url";

<HtmlViewer rawHtml={html} bridgeScriptUrl={bridgeScriptUrl} … />
```

The srcdoc then carries one classic `<script src>` in the exact place the inline script sat (at the end of `<head>`, before the body), the browser caches the asset across documents, and the bridge's `ready` message carries `BRIDGE_PROTOCOL_VERSION`, which the viewer checks: a stale cached asset (no stamp, or another version) logs one console warning naming both versions and shows a dismissible error banner in the surface (`onBridgeUnavailable` fires too); no `ready` within `bridgeReadyTimeoutMs` (default 5000) shows a timeout banner. The package owns that banner by default (`bridgeErrorDisplay="banner"`); a host that renders its own notice from `onBridgeUnavailable` passes `bridgeErrorDisplay="none"` (0.34.0) and no strip is rendered, while the callback and the console warning are unchanged. The URL is resolved against your document's base (`document.baseURI`) before it is written into the srcdoc, never against the framed page, so a page's own `<base href>` cannot redirect it. Plannotator passes nothing and stays inline; none of this runs on the inline path. **CSP:** the package sets no CSP `<meta>` in the srcdoc document, and the frame is an opaque origin so the classic script needs no CORS (no `crossorigin` is set), but a CSP delivered as a header on your page is inherited by the frame: allow `script-src` for the asset's origin. Because the frame is an opaque origin, an asset served with `Cross-Origin-Resource-Policy: same-origin` (common alongside COEP) is blocked; serve it with a CORP that admits cross-origin loads, or without CORP. To also drop the inline literal from your viewer chunk, alias the package's relative `./bridge-script` import (match `/^\.\/bridge-script$/`, never a bare `/\/bridge-script$/`, which would also catch another package's `bridge-script` entry) to the generated `bridge-script.lite` module (see HANDOFF.md § "HTML viewer bridge as an asset").

#### Also blessed in 0.32.0: `shortcuts` and `utils/inputMethod`

- **`@plannotator/ui/shortcuts`**: the declarative keyboard-shortcut engine (`defineShortcutScope`, `useShortcutScope`) and the per-surface scopes, including `useHtmlAnnotateShortcuts` for the Mod+Shift+A Annotate/Interact chord on HTML surfaces. Pure React plus `utils/platform`; no backend.
- **`@plannotator/ui/utils/inputMethod`**: `getInputMethod(surface)` / `saveInputMethod(method, surface)` / `refreshInputMethodStamp(method)`, the per-surface pinpoint-or-drag preference with its TTL, persisted through the `storageBackend` seam.

#### Toolstrip host props (0.35.0)

`components/AnnotationToolstrip` is supported host surface: the annotation mode toolstrip with per-tool opt-outs, all defaulting to today's rendering.

- **`hideQuickLabel`** omits the Quick Label tool. `StickyHeaderLane` forwards it, so the pinned scroll header stays consistent. It hides the button only — it does not clamp the mode, so keep host mode state out of `'quickLabel'` (including preferences restored through `utils/editorMode`).
- **`showHelpLink={false}`** for hosts: the default help modal embeds Plannotator's own video walkthroughs.
- **`hideInputMethodSwitch`** omits the pinpoint/drag input-method switch.

#### Sticky header lane host props

`components/StickyHeaderLane` is the measured compact companion to `Viewer`'s
`[data-sticky-actions]` cluster. Its defaults preserve Plannotator's ghost-header
behavior: hidden and inert at rest, then visible with card chrome once stuck.

- **`visibility="always"`** keeps the existing measured left lane visible and
  interactive at rest as well as while stuck. Resting lanes have no background,
  border, backdrop, shadow, or new document padding; stuck lanes retain the
  incumbent chrome. The lane remains zero-height and absolutely positioned, so
  the host must reserve a clear header-height region; otherwise its visible
  controls can cover and intercept interaction with document content below.
- **`sticky={false}`** uses non-sticky positioning, creates no intersection
  observer, and scrolls away normally. Pass the same value to
  `Viewer.stickyActions` so the left lane and right action cluster follow one
  policy. By itself it leaves the default stuck-only lane permanently hidden;
  combine it with `visibility="always"` for a visible non-sticky header. The
  measured Viewer-actions width is still reserved because both clusters share
  the lane at rest before they scroll away together.
- Wide, tight icon-only, and narrow stacked layouts continue to derive from the
  wrapper width and the measured action-cluster width. `hideQuickLabel` is still
  forwarded to the compact toolstrip.

#### Viewer-owned document header

Use `Viewer.annotationHeader` when the compact annotation controls must be
visible at rest. Viewer then owns one in-flow header containing those controls
on the left and its existing Global comment / Copy actions on the right:

```tsx
<Viewer
  mode={mode}
  inputMethod={inputMethod}
  stickyActions={stickyActions}
  annotationHeader={{
    onInputMethodChange: setInputMethod,
    onModeChange: setMode,
    hideQuickLabel: true,
  }}
  // ...the existing Viewer props
/>
```

The trailing action cluster keeps full-width labels unless you also pass
`actionsLabelMode` (`'full' | 'short' | 'icon'`); the header measures the real
cluster either way, so omitting it costs earlier stacking on narrow columns,
never breakage.

The header reserves its real responsive height before document content. It
keeps active labels in the wide layout, switches the compact toolstrip to
icons in the tight layout, and stacks the two clusters when narrow or wrapped.
All Viewer badge context moves into the same measured header. With
`stickyActions={true}` the complete header pins and gains the existing stuck
chrome; with `false` it remains in flow and scrolls away. The complete header
has `data-print-hide`, so it contributes no print layout.

As with Viewer's legacy sticky actions and anchor navigation, hosts with a
custom scroll element must wrap Viewer in `ScrollViewportProvider` from
`@plannotator/ui/hooks/useScrollViewport` and pass that actual scroll element.
Without the provider, CSS page stickiness can still apply, but Viewer cannot
observe the host scroller to add stuck chrome or calculate anchor clearance.

The header reuses Viewer's `[data-sticky-actions]` cluster, so host CSS that
restyled that selector for the legacy floating bar (negative margins are the
common case) applies inside the header too and pulls the action cluster out of
its row. Scope such rules away from the header, e.g.
`[data-viewer-document-header] [data-sticky-actions] { margin-top: 0; margin-right: 0; }`.

The config is intentionally typed rather than a React-node slot. Viewer reuses
its existing `mode`, `inputMethod`, and `taterMode`; the config supplies only
the state-change callbacks and optional `hideQuickLabel`. Compact toolstrips
never render the Plannotator help modal. Hiding Quick Label does not clamp the
mode, so hosts must still prevent stored `'quickLabel'` state from reaching
Viewer. Omit `annotationHeader` to preserve the legacy floating action bar
exactly. The standalone `StickyHeaderLane` remains supported for Plannotator's
hidden-at-rest ghost lane, but its always-visible mode is an overlay and is not
the in-flow host integration.

### WebMCP provider (`@plannotator/ui/webmcp`; 0.32.0)

The engine that lets a browser-integrated agent (Chrome/Edge WebMCP, `document.modelContext`) call in-page tools on a document surface. Feature-detected once; a browser without the API sees no registration, no DOM, no network, no timers. Seam: `configurePlannotatorUI({ webmcp: { enabled, namePrefix } })`, default enabled with the `plannotator.` prefix; pass `enabled: false` to keep a host page tool-free, or your own prefix to namespace the tools beside your own. There is deliberately no confirmation seam: the catalog is read-and-comment only (no approve / submit / close tools), and the agent may only edit or remove comments stamped `source: "browser-agent"`.

- `modelContext.ts` is the only file that spells the spec surface (local structural types, no `webmcp-types` dependency). A spec rename is a one-file change.
- `useToolset({ id, active, build, deps, hooks })` attaches a named tool set to the document registry; handlers read through refs, so re-renders never re-register, and `active: false` aborts every registration (what Plannotator's Settings opt-out drives).
- `AnnotationChangeTracker` / `buildNudges` are pure (no DOM): per-annotation `seq`, tombstones, a per-tab watermark with `since` override, and the nudge vocabulary every response carries.
- A host with its own document state builds the same adapter-driven catalog Plannotator uses (`packages/editor/webmcp/documentTools.ts`, `buildDocumentTools(adapter, state, options)`) over its own getters and actions; multi-document pages should register one set whose tools take `path` (the folder-session shape) rather than one set per viewer (duplicate names across sets are skipped with a warning, never replaced).
- Never register tools inside an untrusted iframe: the raw-HTML viewer's `sandbox="allow-scripts"` frame and the live-app frame carry no `allow="tools"`, and that is what keeps a framed page from impersonating the host's tools.

The one additive data-model change that rides with it: `Annotation.inReplyTo` (threaded replies; the panel indents them under the parent, the export nests them, share links drop them).

## Consuming it (e.g. from Workspaces)

```bash
npm install @plannotator/ui @plannotator/core
```

1. Call `configurePlannotatorUI({ ... })` once at startup with your backend.
2. Import the stylesheet: `import "@plannotator/ui/styles.css";` (precompiled — no Tailwind wiring needed; if you'd rather run your own Tailwind over the package source, add `@source` globs for `@plannotator/ui`'s `components/`, `hooks/`, and `utils/` dirs in your own CSS — the package doesn't ship its build entry).
3. **Load the fonts in your app entry** — the stylesheet references `--font-sans` / `--font-mono` but does not ship font binaries (standard for a shared UI package; your app owns font loading). Plannotator uses Inter + Geist Mono:
   ```ts
   import "@fontsource-variable/inter";
   import "@fontsource-variable/geist-mono";
   ```
   Or provide your own fonts and set `--font-sans` / `--font-mono` to match.
   The same policy covers math: KaTeX's stylesheet + fonts are deliberately not in `styles.css` — if you render math, load `katex/dist/katex.min.css` yourself (import, CDN tag, or self-hosted copy; see HANDOFF.md "Math rendering").
4. Import components: `import { Viewer } from "@plannotator/ui/components/Viewer";`
5. Build with a bundler that compiles TS/TSX (Vite + React 19 + Tailwind v4). The packages ship **source**, so your bundler compiles them — set `moduleResolution: "bundler"`, `allowImportingTsExtensions`, `jsx: "react-jsx"`.

## Packages & publishing

- `@plannotator/core` — pure utils + types, zero deps, browser-safe (CI enforces no `node:` imports). Published.
- `@plannotator/ui` — React components/hooks + theme + `configure()`. Depends on an exact published `@plannotator/core` version. Published.
- `@plannotator/shared`, `@plannotator/ai` — stay private to the monorepo; `shared` re-exports `core`'s modules via shims so Plannotator's internals are untouched.
- Currently `@plannotator/ui` 0.37.0 depends exactly on `@plannotator/core` 0.25.1. `core` is bumped only when something under `packages/core` changes, so `ui` can advance alone. Keep the published core version exact in `packages/ui/package.json`; do not use a `workspace:` protocol there, because a directly published manifest must remain installable outside this monorepo. Bun still links the matching local workspace during development. When both packages change, publish `core` first, then build and publish the UI tarball. See HANDOFF.md "Publishing & versioning" for the verification command.

## The one rule

**Do not reimplement the document UI from scratch.** A prior from-scratch rewrite broke the app and was reverted. The supported path is always: keep these components as-is and add a seam where a host needs different backend behavior. Never delete working Plannotator code until a human has confirmed parity in the browser.
