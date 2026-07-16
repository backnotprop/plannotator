# SPIKE: Guided Review takeover layout in packages/review-editor/App.tsx

Date: 2026-07-02

## Question

How does `App.tsx` compose the review screen today, and what is the cleanest way to add a full-screen "Guide" takeover (per ADR 006) that hides the file tree and center dock but keeps the header and (optionally) the right sidebar — without disturbing existing state (annotations, agent jobs, diff-switch machinery)?

## 1. Render structure (App.tsx, line ~2250 on)

Top-level return, `packages/review-editor/App.tsx:2250-2256`:

```
<ThemeProvider defaultTheme="dark">
  <TooltipProvider ...>
  <ReviewStateProvider value={reviewStateValue}>
  <JobLogsProvider value={jobLogsValue}>
  {isSwitchingPRScope && <PRSwitchOverlay />}
  <div className="h-screen flex flex-col bg-background overflow-hidden">
    <header>...</header>
    <div className="flex-1 flex overflow-hidden">...</div>  {/* main row */}
  </div>
```

- **Header** (`App.tsx:2258-2668`): a flex row, `justify-between`. Left cluster (`App.tsx:2259-2324`) holds, in order: file-tree toggle button (only `shouldShowFileTree && ...`, `App.tsx:2260-2274`), a vertical divider, then either PR cluster (repo label + `PRSelector` + `StackedPRLabel`, `App.tsx:2276-2302`) or branch/repo labels (`App.tsx:2303-2320`) or a bare "Review" label in demo mode. Right cluster (`App.tsx:2326`+) holds destination dropdown, error/notice pills, and ends with `ReviewHeaderMenu` (`App.tsx:2652-2666`). **This is exactly where a "Guide" badge belongs**: as a new element in the left cluster, immediately after the file-tree toggle's divider (after `App.tsx:2274`), so it reads left-to-right as "navigation controls, then content identity."
- **Main content row** (`App.tsx:2670-2871+`): three conditional siblings inside one flex row — left panel (`SectionsPanel` or `FileTree`, gated by `shouldShowFileTree && isFileTreeOpen`), center dock (`<div className="flex-1 min-w-0 ...">`, `App.tsx:2793-2871`), and right sidebar (`ReviewSidebar`, gated by `reviewSidebar.isOpen`, `App.tsx:2874`+). A guide takeover is a **fourth sibling / branch at this same level** — see §7 for the exact insertion shape.
- `TourDialog` (`App.tsx:3125`) and `PRSwitchOverlay` (`App.tsx:2255`) are the two existing "full screen-ish" surfaces. Both are **not portals** (no `createPortal` anywhere in either file) — they're plain children rendered inline in the tree, made full-viewport purely with CSS: `PRSwitchOverlay.tsx:5` uses `fixed inset-0 z-[100]`; `TourDialog.tsx:199` uses `fixed inset-0 z-50 flex items-center justify-center`. Both float **on top of** the untouched layout underneath (dialog/backdrop pattern) — the file tree, dock, and header are still mounted and rendered behind them, just visually covered.
- **Why the guide should NOT copy this pattern**: `fixed inset-0` dialogs are correct for transient overlays (a PR switch spinner, a modal tour). The guide is a **primary reading mode** per ADR 006 — it replaces the workspace, it doesn't float above it. Modeling it as a `fixed` overlay would (a) keep the dock mounted and its resize/scroll listeners live underneath for no reason, (b) fight the header's own `z-50`, and (c) make "is the guide the current view" a z-index question instead of a layout question. The correct shape is a **conditional render branch in the main content row** (like the file-tree/dock/sidebar siblings already are), not a stacked overlay.

## 2. State ownership, existing view toggles, dock persistence

- View-toggle flags already live as plain `useState` in `App.tsx`: `isFileTreeOpen` (`App.tsx:216`), and `reviewSidebar` via `useSidebar<ReviewSidebarTab>(false, 'annotations')` (`App.tsx:215`, hook at `packages/ui/hooks/useSidebar.ts`). `useSidebar` is generic and reusable — it returns `{ isOpen, activeTab, open, close, toggleTab }` over `useState`, no persistence, no context. A `guideOpen` boolean (or reuse `useSidebar`-shape if a guide ever needs sub-tabs) is a peer of `isFileTreeOpen`, declared alongside it near `App.tsx:216`.
- **Recommend a single `reviewView: 'dock' | 'guide'` state** (or a plain boolean `guideOpen`) rather than boolean flags on top of the existing ones — it makes "what's on screen" a single source of truth instead of `isFileTreeOpen`/dock-visible/`guideOpen` needing manual reconciliation. Toggling into guide mode does not need to touch `isFileTreeOpen` or `reviewSidebar` state at all — it only changes what's gated in the main content row (see §7); their state (file tree width, which sidebar tab) stays intact for when the user returns to the dock view.
- **Keyboard shortcut wiring**: follows the existing convention exactly. `toggleFileTree` (`Mod+B`) and `toggleSidebar` (`Mod+.`) are declared as actions in `reviewEditorShortcuts` (`packages/review-editor/shortcuts.ts:58-69`), with handlers wired via `useReviewEditorShortcuts({ handlers: { toggleFileTree: ... } })` at the call site in `App.tsx`. A `toggleGuide` action belongs in that same scope (`packages/review-editor/shortcuts.ts`, `section: 'Layout'`, alongside `toggleFileTree`/`toggleSidebar`/`toggleTour`) — note `toggleTour` (`Mod+Shift+T`, dev-only, `shortcuts.ts:70-76`) is the closest precedent for "open a full-takeover-ish surface via shortcut."
- **Does DockviewReact lose layout on unmount? Yes, decisively — and this is already load-bearing in the codebase.** `App.tsx:2809-2818` conditionally renders `<DockviewReact ... onReady={handleDockReady} />` only `files.length > 0`; when `files.length === 0` it renders an empty-state div instead (`App.tsx:2818-2870`). `handleDockReady` (`App.tsx:709-740`) calls `setDockApi(event.api)` and wires `onDidActivePanelChange` **fresh every mount** — there's no saved layout restored. A separate effect (`App.tsx:876-883`, gated on `needsInitialDiffPanel.current`) re-adds the initial diff panel only once per mount. So today, going from "has files" → "no files" → "has files again" (e.g. switching to an empty diff type and back) **already throws away the whole dock layout** (open tabs, split panels, which panel was active) and reconstructs a single default panel. This is accepted behavior for that specific transition because it's tied to a real content change (no files = nothing to show). **It is not an acceptable behavior for the guide takeover**, where the user expects to return to exactly the dock state they left. Conclusion: the guide branch must **CSS-hide the dock's wrapper**, not conditionally unmount `<DockviewReact>` the way the empty-file-tree state does.

## 3. Header badge conventions

- File-tree toggle button, exact code: `App.tsx:2262-2272`:

```tsx
<button
  onClick={() => setIsFileTreeOpen(prev => !prev)}
  className={`p-1 rounded-md transition-all focus-visible:outline-none ${
    isFileTreeOpen
      ? 'text-primary'
      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
  }`}
  title={isFileTreeOpen ? 'Hide file tree' : 'Show file tree'}
>
  <FolderTree className="w-3.5 h-3.5" />
</button>
```
Divider immediately after: `<div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />` (`App.tsx:2273`).
- There is no existing header "pill/badge button" component exactly like what ADR 006 describes (a labeled, clickable badge, not just an icon button). The closest conventions to borrow from:
  - **Destination dropdown button** (`App.tsx:2334-2348`): `flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors` — this is the right shape for a labeled pill button with an icon + text, active/inactive via background tint.
  - **`CountBadge`** (`packages/review-editor/components/CountBadge.tsx`) — "Compact mono count badge — consistent across file tree, annotations, and AI tabs," used for numeric counts, not labels.
  - **`ConventionalLabelBadge`** (`packages/review-editor/components/ConventionalLabelPicker.tsx:139-152`) — a small `cc-inline-badge cc-tone-{tone}` pill, but it's a static label, not interactive.
  - Menu-item keyboard hints use `<KbdHint>` inside `ActionMenuItem`'s `badge` prop (`ReviewHeaderMenu.tsx:163,172`) — irrelevant to a header badge's visual style but confirms `badge` as a slot-naming convention in this codebase.
  - **Recommendation**: model the Guide badge on the destination-dropdown button's classes (pill, `text-xs font-medium`, muted background, hover state), with an active/inactive treatment like the file-tree toggle (`text-primary` when the guide is open vs. `text-muted-foreground` otherwise), placed right after the file-tree toggle's divider at `App.tsx:2274`.

## 4. ReviewStateContext + JobLogsProvider access

Both providers wrap the entire screen **above** the header/content div (`App.tsx:2253-2254`, closing at `App.tsx:3149`), so anything rendered in the new guide branch — since it's a sibling deeper in that same tree, not a separate mount — has full access via `useReviewState()` (`packages/review-editor/dock/ReviewStateContext.tsx:184`) and `useJobLogs()` (`packages/review-editor/dock/JobLogsContext.tsx:21`). `ReviewState` already carries everything a guide page needs: `allAnnotations`, `onAddAnnotation`/`onSelectAnnotation`/`onNavigateToAnnotation` (diff annotation parity, ADR 006 §5), `files`/`rawPatch`, `agentJobs`, `aiMessages`/`onAskAI`, `prMetadata`. `useAgentJobs()` itself is a hook called once in `App.tsx` (its result feeds `reviewStateValue.agentJobs` and `jobLogsValue`) — a guide screen doesn't need its own subscription, it reads the same context slice `TourDialog` already does (`TourDialog.tsx:5,` `useReviewState()`). No new provider is needed; this is confirmed by `TourDialog` being a working precedent for a full-screen-ish surface consuming this context today.

## 5. Persistence conventions

- **Cookie-backed settings**: `packages/ui/config/settings.ts` declares each setting as a `SettingDef` (default, `fromCookie`/`toCookie`, optional `serverKey`/`fromServer`/`toServer`), registered in the `SETTINGS` object and resolved through the `configStore` singleton (`packages/ui/config/configStore.ts`) via `useConfigValue`/`configStore.get`/`configStore.set`. `reviewPanelView` (`settings.ts:60-68`) is the closest analog — cookie-only (`serverKey: undefined`), because it's pure UI-layout preference, not something the server needs to know. **A `guideSeen` flag or "last view" preference (dock vs. guide) is exactly this shape**: cookie-only `SettingDef`, e.g. `storage.getItem('plannotator-guide-seen')`, no server sync needed unless a future requirement wants the server to pre-select the guide view on load.
- Raw cookie helpers live in `packages/ui/utils/storage.ts` (`getItem`/`setItem`/`removeItem`), deliberately cookie- not localStorage-based because each session runs on a random port and cookies are domain- not port-scoped (`storage.ts:1-8`).
- **Server-side per-session persistence**: the review server keys drafts by `contentHash(rawPatch)` (`draftKey`, `packages/server/review.ts:202`, recomputed on diff switches at `review.ts:1210,1251,1375,1488`) via `/api/draft` (`review.ts:1848-1851`). The Tour feature's checklist persistence (`PUT /api/tour/:jobId/checklist`, ADR 006 §"Reviewed checkbox" precedent) is simpler: `packages/server/tour/tour-review.ts:534-543,594,600` — an in-memory `Map<string, boolean[]>` (`tourChecklists`) keyed by job id, no disk persistence, lost on server restart. This is the explicit precedent named in ADR 006 for the guide's "Reviewed" checkbox. If guide view-state (which page you're on, which pages are marked reviewed) needs to survive a page reload within the same server session, the same in-memory-Map-keyed-by-job-id pattern applies; ADR 006 explicitly defers guide persistence beyond server memory as a later decision, so building anything more durable now would be scope creep.

## 6. Server route conventions + Pi mirror

- **`packages/server/review.ts`** matches routes with a flat, ordered `if (url.pathname === "..." && req.method === "...")` chain inside the request handler (e.g. `review.ts:1037,1087,1103,1131,1162,1167,...,2039,2065`), with regex used only for path params: Tour's two routes are the exact precedent —
  - `GET /api/tour/:jobId` → `url.pathname.match(/^\/api\/tour\/[^/]+$/)` (`review.ts:1016-1021`)
  - `PUT /api/tour/:jobId/checklist` → `url.pathname.match(/^\/api\/tour\/([^/]+)\/checklist$/)` (`review.ts:1024-1029`)
  A guide job-result endpoint (`GET /api/guide/:jobId`) and a "mark page reviewed" endpoint (`PUT /api/guide/:jobId/checklist` or similar) would follow this exact shape, added next to the Tour block (`review.ts:~1015-1030`).
- **`apps/pi-extension/server/serverReview.ts`** is **hand-maintained**, not generated — confirmed by `apps/pi-extension/vendor.sh`. Vendoring only copies **business-logic modules** verbatim (with import-path rewrites) into `apps/pi-extension/generated/`: `packages/shared/*.ts` (a large allow-list, `vendor.sh:9`), select `packages/server/*.ts` modules (`agent-review-message`, `codex-review`, `claude-review`, `review-findings`, `marker-review`, `path-utils`, `review-skill-loader`, `vendor.sh:15-25`), and `packages/server/tour/tour-review.ts` specifically (`vendor.sh:28-36`, imported by `serverReview.ts:103` as `../generated/tour-review.js`). **The HTTP route wiring itself is not vendored** — `serverReview.ts` re-implements the same route matching by hand using `node:http` primitives (regex-matched paths at `serverReview.ts:960-977`, mirroring `review.ts` almost line-for-line for the Tour routes). CLAUDE.md's "both implementations must be updated" applies literally here: adding guide routes means (a) writing `packages/server/guide/guide-review.ts` (mirroring `packages/server/tour/tour-review.ts`'s shape — job provider, schema, parser, in-memory result store), (b) adding it to `vendor.sh`'s vendored-file list (a one-line addition to the `tour-review` block's pattern, `vendor.sh:28-36`), and (c) hand-adding the matching `if (url.pathname.match(...))` blocks to `serverReview.ts` next to its existing Tour block (`serverReview.ts:959-977`).

## 7. Implications for the guide takeover

**State**: one flag owns "is the guide open" — a plain `useState<boolean>` (`guideOpen`) or `useState<'dock'|'guide'>('view')`, declared next to `isFileTreeOpen` (`App.tsx:216`). It does not need to be layered onto `isFileTreeOpen`/`reviewSidebar` — those keep their own state untouched while the guide is open, so returning to the dock view restores exactly what was there. Persist a `guideSeen`/last-view cookie setting via `packages/ui/config/settings.ts` (cookie-only `SettingDef`, modeled on `reviewPanelView`) only if product wants the empty-state landing to remember first-time-vs-returning status; the open/closed guide state itself is transient (not persisted across reloads), matching Tour's in-memory-only precedent.

**Render approach — CSS-hide the dock, don't unmount it.** Do not reuse the `files.length > 0` conditional-unmount pattern (`App.tsx:2809-2818`) for the guide toggle — that pattern already discards dock layout on remount and is only tolerable there because it's tied to an actual content change. Concretely:
- Wrap the center-dock `<div className="flex-1 min-w-0 overflow-hidden relative">` (`App.tsx:2793`) with a container whose visibility is CSS-driven by `guideOpen` (e.g. `hidden` class, or `display: none` / absolute-position-off-screen) rather than conditionally rendering `null`. `DockviewReact` and its `dockApi` stay mounted and untouched underneath.
- Gate the file-tree panel siblings (`App.tsx:2672,2725`) with `&& !guideOpen` — these can unmount safely; the only state that must survive is dock layout, and `isFileTreeOpen`/`fileTreeResize.width` are cheap plain state that already reconstructs fine.
- Render the new guide screen as a sibling **inside the main content row** (`App.tsx:2671`+), conditioned on `guideOpen`, occupying the space the file-tree + dock would otherwise take. The right sidebar (`reviewSidebar.isOpen` block, `App.tsx:2874`+) can remain rendered as-is per ADR 006 ("right sidebar may remain") — no change needed there.
- The header (`App.tsx:2258-2668`) is untouched by `guideOpen`; only the file-tree toggle button's visual state and the new Guide badge need to react to it.

**Insertion points**:
- Guide badge: after the file-tree-toggle divider, `App.tsx:2274` (new JSX, styled per §3).
- `guideOpen` state: near `App.tsx:216`.
- `toggleGuide` shortcut action: `packages/review-editor/shortcuts.ts`, in `reviewEditorShortcuts.shortcuts` next to `toggleFileTree`/`toggleSidebar`/`toggleTour` (`shortcuts.ts:58-76`); wire the handler where `useReviewEditorShortcuts` is invoked in `App.tsx`.
- Main-row branch: guide screen conditionally rendered inside `App.tsx:2671`+, dock wrapper (`App.tsx:2793`) CSS-hidden instead of unmounted when `guideOpen`.
- Server: new `packages/server/guide/guide-review.ts` (Tour-pattern job provider) + routes next to the Tour block in `review.ts:1015-1030`; hand-mirrored routes in `serverReview.ts:959-977`'s vicinity; add the new server module to `apps/pi-extension/vendor.sh`'s vendored list.
- Guide "Reviewed" checkbox persistence: in-memory `Map` keyed by job id inside the new guide-review module, same shape as `tourChecklists` (`tour-review.ts:535,543`), exposed via a `PUT /api/guide/:jobId/checklist`-style route.

**What NOT to disturb**:
- The diff-switch machinery (`draftKey = contentHash(currentPatch)` recomputation on every switch, `review.ts:1210,1251,1375,1488`; the `{ superseded: true }` guard on concurrent `/api/diff/switch` calls documented in CLAUDE.md) runs independently of what's on screen. Because the guide takeover CSS-hides rather than unmounts the dock, in-flight diff switches, freshness polling (`useDiffFreshness`), and PR-context streaming keep running unaffected whether the guide is open or not — do not gate any of that on `guideOpen`.
- `handleDockReady`'s one-time panel bootstrap (`App.tsx:709-740`, `needsInitialDiffPanel.current` effect at `App.tsx:876-883`) must not re-fire when toggling the guide — this is exactly why unmounting the dock is the wrong approach; CSS-hide guarantees `dockApi` and its ref-gated effects never see a fresh mount.
- `ReviewStateContext`/`JobLogsProvider` composition (`App.tsx:2253-2254`) does not need to change — the guide consumes it as a sibling deeper in the tree, the same way `TourDialog` already does.
