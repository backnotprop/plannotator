# Our fork of @pierre/trees

`@pierre/trees` 1.0.0 (Apache-2.0, The Pierre Computer Company, github.com/pierrecomputer/pierre, tag `@pierre/trees@1.0.0`) with a small patch: `patches/@pierre%2Ftrees@1.0.0.patch`, applied by Bun's `patchedDependencies` in the root `package.json`. The package's own licence and notices are untouched; the patch only adds code.

It is a patch, not a vendored copy, because the change is about 120 added lines over 7 built files and reads as a normal diff. Everything is additive: a tree that does not pass the new options renders exactly as upstream.

## What it adds, and why

Our review tree puts controls and numbers in its rows. Upstream rows take one non-clickable decoration, so this adds:

| Addition | Why |
|---|---|
| `rows.renderParts(context)` returns `{ lead, trail, muted, tone, title }` | `lead` parts sit before the name (the viewed circle, git add), `trail` parts after it (comment count, `+N`, `−M`). A `null` part keeps its column empty so columns line up. `muted` dims the name (viewed files). `tone` names a row style (group headings). `title` is the row's tooltip |
| A part with an `id` is a button (`role="button"`, `aria-pressed` from `pressed`) and calls `rows.onPartClick({ partId, path, row })`; a part may carry an icon and text together | Clicking the viewed circle or git add must not select or open the file; an open-threads count is an icon and a number |
| `rows.onDoubleClick({ path, row })` | Double-click pins a file |
| `rows.onActivate({ path, row })` | Called on every plain click of a row and on Enter or Space (the row is a button), also when that row is already selected; Pierre fires no selection change then, so clicking the highlighted file at start did nothing. Modifier clicks (range or toggle selection) do not activate. To drop: if upstream gains an activation event, use it and delete the call in the row's `onClick` |
| `rows.gitStatusPlacement: 'start'` | The status letter before the name, as in our tree |
| `rows.nameTruncation: 'end'` | A name as one string with an end ellipsis (`row-name` part), cut at a whole letter; Pierre's middle truncation left slivers of cut letters and cut names that still had room |
| `rows.nameTruncation: 'keep-tail'` with `rows.observeName(element, name, setText)` | A file name fitted to its row by the host: the patch only renders `TailKeptName`, a `row-name` span that starts with the whole name and calls `observeName` once per mount, and the host calls `setText` with the fitted text. Plannotator's `observeTreeName` (deleted with the old rows) used the shared `packages/ui/utils/textFit.ts`: one ResizeObserver for every fitted name (its `contentRect` width, no layout reads), canvas `measureText` cached by font and text, one `document.fonts` listener, and a name that fits does no fitting work. A name that does not fit becomes the start of the stem, an ellipsis, then a tail that always shows, the last three graphemes of the stem plus the extension (`st…ep0.py`); when even `…` and the tail do not fit, `…` and as much of the tail's end as fits. Cuts are by grapheme, so no letter is drawn in part. The row keeps the full name as its `aria-label` and title. Folders, and rows with no `observeName`, keep a plain end ellipsis. An earlier version measured inside the patch with a hidden probe per row and cost scrolling about 1.3 s of forced layout on 200 rows. To drop: if upstream gains a whole-letter, tail-keeping truncation, switch the two tree views to it and delete `TailKeptName` and `observeName` from the patch
| `onDirectoryExpand(path)` (a tree option) | All files lists folders lazily: an unloaded folder is a path ending in `/`; when it opens we load its children and `batch` them in |
| `searchText(path)` (a tree option) | The text a search query is matched against for a path, instead of the path itself. The Changes tree draws group headings and merged folders as synthetic paths (`Code/src∕components/x.ts`); it returns the file's real path, a folder's real path, and `''` for a group heading, so a query never matches a heading's label and `src/components` finds a merged folder's files |
| No type-to-search on rows | Pierre opens its search box with any letter or digit typed on a focused row and stops the key. The fork drops that branch (`isSearchOpenSeedKey`), so the page's one-key shortcuts (V, A, J/K, …) work on a focused row; typing in the search box itself still filters |
| `model.refreshRows()` | Re-runs `renderParts` and `renderRowDecoration` after the host's state (viewed, staged, comments) changes |
| Shadow parts on row sections: `row-spacing`, `row-icon row-icon-file|directory`, `row-lead`, `row-git row-git-file|directory`, `row-content` (+ `row-content-muted`, `row-content-<tone>`), `row-decoration`, `row-trail` (+ `row-lead-<tone>`, `row-trail-<tone>`), `row-part`, `row-part-<id>`, `row-part-pressed`, and `search` / `search-open` on the find box | Stable styling from outside the shadow root with `::part()`, instead of CSS against internal attributes |
| CSS variables `--trees-row-lead-columns`, `--trees-row-trail-columns`, `--trees-row-part-gap`, `--trees-row-muted-opacity`, and `--trees-row-active` (1 on a hovered, focused or selected row, else 0; always 1 without hover) | The lead and trail are grids; the host sets column widths so `+N` and `−M` line up down the panel. `--trees-row-active` lets a part (Git add) show on hover only, from outside the shadow root |

The patch is about 170 added lines. Files touched (all under `dist/`): `render/FileTreeView.js` (rendering and clicks), `render/FileTree.js` (passing `rows`, `refreshRows`), `model/FileTreeController.js` (`onDirectoryExpand`, `searchText`), `style.js` (the grid CSS, appended as its own string), `model/publicTypes.d.ts`, `render/FileTree.d.ts`, `index.d.ts` (types). Source maps are not updated.

## What Plannotator uses today

Since the tree took Pierre's own look (2026-11-17), Plannotator passes only `rows.renderParts` (trail parts, `muted`, `tone`, `title`; `lead` only for a group heading's icon), `rows.onDoubleClick`, `rows.onActivate`, `onDirectoryExpand`, `searchText` and `refreshRows()`, and relies on the dropped type-to-search. Clickable parts (`id`, `onPartClick`), `gitStatusPlacement: 'start'`, `nameTruncation: 'end' | 'keep-tail'` with `observeName`, and the lead and trail column variables are unused; they stay in the patch because removing them would touch the same lines the used options share. `observeTreeName` was deleted with the old rows.

## Re-sync with a new upstream version

1. Bump `@pierre/trees` in `packages/review-editor/package.json` (and every other package that lists it) and rename the `patchedDependencies` key and file to the new version.
2. `bun install`. If Bun says the patch no longer applies: `bun patch @pierre/trees`, apply the old patch by hand in the folder Bun prints (`patch -p1 < patches/...`, fix rejects; the edits are small and keyed on stable names such as `renderStyledRow` and `renderFileTreeRowContent`), then `bun patch --commit <folder>`.
3. Run the tree's tests (`FileTree.*.test.tsx`, `FileTreeNode.controls.test.tsx`) and look at the review sidebar.

## Offering it upstream

The change maps onto upstream's TypeScript sources one to one (`src/render/FileTreeView.tsx`, `src/render/FileTree.ts`, `src/model/FileTreeController.ts`, `src/style.css`, `src/model/publicTypes.ts`). An upstream PR would add the same options there, plus tests.

## Pi and other installs

The tree is bundled into the review and Inbox HTML at build time. The Pi extension ships that built HTML and does not install `@pierre/trees`, so Pi needs nothing.
