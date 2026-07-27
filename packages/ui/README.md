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
  serverSync,
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

### Markdown editor extensions + wiki links (`MarkdownEditor` / `InlineMarkdown`)

- **`MarkdownEditor` takes CM6 extensions.** `extensions?: readonly Extension[]` (from `@codemirror/state`) is forwarded verbatim into the underlying editor — the seam for `wikiLinks(config)`, `y-codemirror.next` collab bindings, custom keymaps.

  > **⚠️ Captured once per `documentId` — not reactive.** The engine reads the array a single time at document mount; swapping the array later is silently ignored until a `documentId` change remounts. Pass a stable reference, and feed changing data through extension config callbacks that close over live state (refs/getters) — never through new arrays.

- **`wikiLinks` is re-exported from `@plannotator/ui/components/MarkdownEditor`** together with `WikiLinksConfig`, `WikiLinkSuggestion`, `WikiLinkResolvedTarget`, `WikiLinkStatus`. Import it from there — `@plannotator/atomic-editor` stays off the supported-import list:
  ```tsx
  import { MarkdownEditor, wikiLinks } from "@plannotator/ui/components/MarkdownEditor";

  const editorExtensions = [wikiLinks({ suggest, resolve, onOpen })]; // stable reference!
  <MarkdownEditor markdown={md} documentId={docId} editorHandleRef={ref} extensions={editorExtensions} />
  ```
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
- `@plannotator/ui` — React components/hooks + theme + `configure()`. Depends on `@plannotator/core` (exact-version lockstep). Published.
- `@plannotator/shared`, `@plannotator/ai` — stay private to the monorepo; `shared` re-exports `core`'s modules via shims so Plannotator's internals are untouched.
- Versioned in lockstep with the repo. Publish `core` then `ui`: build each tarball with **`bun pm pack`** (resolves `workspace:*` to the exact version at pack time), then **`npm publish *.tgz --provenance --access public`** — the repo's existing flow.

## The one rule

**Do not reimplement the document UI from scratch.** A prior from-scratch rewrite broke the app and was reverted. The supported path is always: keep these components as-is and add a seam where a host needs different backend behavior. Never delete working Plannotator code until a human has confirmed parity in the browser.
