# Recap / Handoff — PR #942: Open files in external apps + code-review UX pass

- **PR:** https://github.com/backnotprop/plannotator/pull/942
- **Branch:** `feat/openfile` (rebased onto `main` @ #936)
- **Date:** 2026-06-18
- **Scope:** 46 files, ~+2.3k / −0.4k. Pure frontend except two new server endpoints (mirrored Bun + Pi). No new diff backend.

This is a developer handoff. Read top-to-bottom to understand *why* each piece exists and *where* to look.

---

## TL;DR

One headline feature — **open the current file in an external app** — plus a batch of code-review UX improvements that came out of dogfooding, and **one real bug fix** (Cmd+click code navigation was silently dead). The semantic-diff view was also migrated from a dock panel into a sidebar accordion.

Commits (oldest → newest):

```
677ad27f feat: open the current file in an external app (review + annotate)
03821638 feat(review): file-header change letters and line counts
2cea9f31 feat(review): group the diff-settings cog with the Split/Unified toggle
384a4eff feat(review): collapse/expand-all toggle in the all-files view
797e4eeb fix(review): restore Cmd+click code navigation
9a957947 feat(review): semantic diff as a resizable sidebar accordion
7f7bd6f1 docs(adr): backlog spike — git graph view exploration
65f79376 fix(annotate): inline the open-in button beside the file name
```

---

## 1. Open file in an external app  (the headline)

**What it does:** a split-button (app icon + chevron) in both the **review file header** and the **annotate file badge**. The left half opens the current file in the last-used app; the chevron drops down every detected app (Finder/Explorer reveal, VS Code, Cursor, Zed, Sublime, terminals, Xcode, etc.) plus Copy path / Copy file diff. Picking an app opens it **and** makes it the new default — there is **no settings UI**; the dropdown *is* the preference. Ported from OpenCode's "Open in" control.

**How it works (the important part): this is a Bun/browser app, not Electron.** Launching happens **server-side**:
- `GET /api/open-in/apps` → `{ available, apps[] }`. `available=false` in remote/headless sessions (the UI hides the control). `apps` is the host-detected, launchable subset.
- `POST /api/open-in` `{ filePath, base?, appId? }` → resolves an absolute path, **containment-checks it**, then launches.

Per-kind launch semantics (`packages/server/open-in.ts` `openFileInApp`):
- **editor** → open the file (`open -a "App" file` / `<bin> file`)
- **file-manager (reveal)** → reveal it (`open -R` / `explorer /select,` / `xdg-open <dir>`)
- **terminal** → open the file's **parent directory**
- **system default** → `open` / `start` / `xdg-open` with no app

All launches use **argv arrays, never shell strings** (injection-safe), modeled on `packages/server/browser.ts`.

**Key files:**
- `packages/shared/open-in-apps.ts` — the single-source app catalog (id, label, kind, per-platform launch fields). Imported by servers + UI.
- `packages/ui/components/OpenInAppButton.tsx` — the split-button + dropdown.
- `packages/ui/components/icons/AppIcon.tsx` + `icons/app/*` — app brand icons, **base64-inlined as data-URIs** (see Gotchas: single-file HTML).
- `packages/ui/utils/storage.ts` — `getLastOpenInApp` / `setLastOpenInApp` (cookie; ports are random per invocation).
- `packages/server/open-in.ts` + endpoints in `packages/server/review.ts` & `annotate.ts`.
- **Pi mirror:** `apps/pi-extension/server/open-in-apps.ts` + endpoints in `serverReview.ts` / `serverAnnotate.ts` (`vendor.sh` copies the shared catalog).
- Review wiring: `FileHeader.tsx` (`showLabel={!isCompact}` → shows the app name when wide). Path is repo-relative → resolved server-side against the VCS root (`resolveAgentCwd`); `agentCwd` was added to `ReviewState`.
- Annotate wiring: `DocBadges.tsx` + threaded through `Viewer.tsx` ← `editor/App.tsx` (`openInAppPath = linkedDocHook.isActive ? linkedDocHook.filepath : sourceFilePath`).

**Decisions worth knowing:**
- **No "Default app" menu item** (it was tried, then removed) — last-used is the only default mechanism.
- **Reveal label is just "Finder"** (per-platform), not "Reveal in Finder".
- **Path safety:** review resolves against the VCS root server-side (not the client `base`, which is wrong when `plannotator review` runs from a subdir); annotate resolves an absolute path against its own dir. Both containment-checked.
- **Remote/PR-without-local-checkout:** the control hides (no resolvable file on disk).

---

## 2. File-header change letters + line counts  (review)

Replaced the old box status-icons with **`A`/`D`/`R` letters to the right of the path** + `+N −M` counts, matching the file tree. **Modified files stay bare** — the `+/−` already says it changed, so only add/delete/rename get a letter. Single file: `packages/review-editor/components/FileHeader.tsx` (`FileStatusLetter`, `countChanges`). Counts are derived from the patch in-component (no prop plumbing).

Also in this area: **Pierre's built-in single-file header is disabled** (`DiffViewer.tsx`, `disableFileHeader: true`) so we don't render two headers — we supply our own.

---

## 3. Settings cog grouped with the Split/Unified toggle  (review)

The diff-display settings cog (`DiffOptionsPopover`) now lives **inside the same pill** as the Split/Unified toggle, divider-separated, with an open-state that mirrors the active-segment look. `packages/review-editor/App.tsx` (toolbar) + `DiffOptionsPopover.tsx`. (This commit also carries the small `agentCwd` memo plumbing for open-in.)

---

## 4. Collapse / expand-all toggle in the all-files view  (review)

An **embedded corner cell** at the top-left of the all-files panel that folds/unfolds every file at once (smart: collapses if any open, else expands). `packages/review-editor/components/AllFilesCodeView.tsx` — iterates the CodeView items, flips `item.collapsed`, `updateItem`. This commit also flips on `useTokenTransformer` for the all-files surface (see #5).

---

## 5. Fix: Cmd+click code navigation  ⚠️ the non-obvious bug

**Symptom:** Cmd+hover/Cmd+click on a symbol did nothing — no underline cue, no References panel. Pre-existing on `main`, not caused by this branch.

**Root cause (took a headless-browser DOM inspection to find):** token-level interaction only works when Pierre wraps each token with a `data-char` attribute, which only happens when the **token transformer** runs. The renderer enables the transformer from `shouldUseTokenTransformer(options)` — but the per-component `onTokenClick`/`onTokenEnter` options are **dropped before they reach the worker**, and **highlighting runs in a web worker** whose render options come from a *separate* init config. So tokens highlighted (colors appeared) but never got `data-char` → `isTokenPointerTarget` never matched → handlers never fired. Silent no-op.

**Fix:** set `useTokenTransformer: true` on the **worker pool's** init options — `packages/review-editor/workerPool.tsx` — (plus the per-component option on `DiffViewer`/`AllFilesCodeView` as a main-thread fallback). Verified end-to-end with puppeteer: 0 → 1660 `data-char` tokens, hover cue + `/api/code-nav/resolve` both fire. **No Pierre upgrade needed** (the worker plumbing gap is the same in 1.2.8 and 1.2.10).

If token interactions ever break again, this is the first place to look.

---

## 6. Semantic diff → resizable sidebar accordion  (review)

The semantic diff used to open a **dockview panel**. It's now a **collapsible accordion pinned to the bottom of the file tree** — same entity rows (`SemanticDiffRows` reused), same click-to-navigate (`openDiffFile` + line select), sized for the sidebar, with a **vertical drag handle to resize** it.

- New: `packages/review-editor/components/SemanticDiffAccordion.tsx` (self-contained via `ReviewStateContext`; fetches the existing `/api/semantic-diff`).
- `useResizablePanel` was **generalized to a `y` axis** (was width-only) — `packages/ui/hooks/useResizablePanel.ts`. Backward-compatible (`axis` defaults to `'x'`, existing sidebar/panel resizers untouched).
- **Removed** the dock panel + button + all wiring: deleted `ReviewSemanticDiffPanel.tsx`, removed `SEMANTIC_DIFF` from `reviewPanelTypes`/`reviewPanelComponents`, dropped `isSemanticDiffActive` + the load-state callbacks from `App.tsx` and `ReviewStateContext`. `semanticDiffAvailable` stays — it's the accordion's show/hide gate.
- CSS: `.semantic-diff-accordion` scope in `review-editor/index.css` compacts the panel's rows to sidebar size.

The per-file `sem · N` badge in file headers is a separate, untouched feature.

---

## 7. Inline open-in in annotate  (fix)

After the rebase, #936 had added a `folder-file` breadcrumb variant (Close + filename). The open-in button was rendering as a standalone row stacked *above* it. Now it renders **inline to the right** within each file row (source / linked-doc breadcrumb), with a standalone fallback only when there's no file row. `packages/ui/components/DocBadges.tsx`.

---

## 8. ADR backlog spike — git graph view  (docs, not built)

`adr/research/SPIKE-git-graph-view-*.md`. Explored a commit-graph view (click a commit → its files load on the right). **Key finding:** the diff viewer is source-agnostic (consumes a `rawPatch`), so it's largely reusable; net-new work is a per-commit diff mode + the graph lane rendering; **git-only** caveat (jj/P4). **Backlogged**, two-phase plan if revisited.

---

## Cross-cutting notes / gotchas

- **Single-file HTML build.** The review/plan apps ship as one self-contained HTML file. Large assets emitted as separate files break that, which is why all app icons are **base64-inlined** in `AppIcon.tsx` rather than imported as `.svg`/`.png` URLs.
- **Two server runtimes.** Every server endpoint must exist in **both** the Bun server (`packages/server/`) and the **Pi** mirror (`apps/pi-extension/server/`), with the shared catalog vendored via `apps/pi-extension/vendor.sh`. The open-in endpoints are mirrored.
- **Build order.** Review-editor UI changes require `bun run --cwd apps/review build` **before** `bun run build:hook` (the hook copies pre-built HTML). Run `bun run typecheck` for the cross-package check.
- **Cookies, not localStorage** for persistence (open-in last-used, resize sizes) — each hook invocation runs on a random port.
- **Rebase.** Rebased cleanly onto `main` (#936, "Persist saved annotate file edits in drafts"). Only two trivial list-append conflicts (`vendor.sh`, `shared/package.json`) — kept both sides. The heavy overlap (`editor/App.tsx`, `DocBadges`, `Viewer`) auto-merged correctly (verified the open-in wiring survived). NOTE: the badge-removal branch is **not on main yet**, so those changes are not in this PR.

## How it was verified

- `bun run typecheck` and the review→hook builds green throughout.
- The open-in cross-platform launch, app detection, and both header placements were exercised live (`plannotator review` / `plannotator annotate .`).
- The code-nav fix was confirmed with a headless Chrome (puppeteer) DOM inspection — token `data-char` presence + the actual `/api/code-nav/resolve` request firing on a simulated Cmd+click.

## File index (start here)

| Area | Files |
|------|-------|
| Open-in catalog/UI | `shared/open-in-apps.ts`, `ui/components/OpenInAppButton.tsx`, `ui/components/icons/AppIcon.tsx`, `ui/utils/storage.ts` |
| Open-in server | `server/open-in.ts`, `server/review.ts`, `server/annotate.ts`, `apps/pi-extension/server/open-in-apps.ts` (+ serverReview/serverAnnotate) |
| Review header/toolbar | `review-editor/components/FileHeader.tsx`, `review-editor/components/DiffOptionsPopover.tsx`, `review-editor/App.tsx` |
| All-files / code-nav | `review-editor/components/AllFilesCodeView.tsx`, `review-editor/components/DiffViewer.tsx`, `review-editor/workerPool.tsx` |
| Semantic accordion | `review-editor/components/SemanticDiffAccordion.tsx`, `ui/hooks/useResizablePanel.ts`, `review-editor/index.css` |
| Annotate open-in | `ui/components/DocBadges.tsx`, `ui/components/Viewer.tsx`, `editor/App.tsx` |
| Backlog | `adr/research/SPIKE-git-graph-view-*.md` |

## Follow-ups / backlog

- Re-rebase once the badge-removal branch lands on `main`.
- Git-graph view (Phase 1: commit list + per-commit diff; Phase 2: graph rails) — see the spike.
- Minor open-in polish deferred during build (e.g. unused `zed-dark` icon variant, a couple low-severity review notes) — see the open-in commit's history if needed.
