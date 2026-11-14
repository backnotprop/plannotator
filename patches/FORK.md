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
| `rows.gitStatusPlacement: 'start'` | The status letter before the name, as in our tree |
| `rows.nameTruncation: 'end'` | A name as one string with an end ellipsis (`row-name` part), cut at a whole letter; Pierre's middle truncation left slivers of cut letters and cut names that still had room |
| `rows.nameTruncation: 'keep-tail'` | A file name as two spans in `row-name`: a stem (`[data-item-name-stem]`) that shrinks with a CSS end ellipsis, so it is cut at whole letters, and a tail (`[data-item-name-tail]`) that never shrinks: the last three graphemes of the stem plus the extension. `step0.py` … `step4.py` cut as `st…ep0.py` and stay apart, and the extension is never lost. A name that fits is drawn whole, a name of three graphemes or fewer is one span, and folders keep a plain end ellipsis. The DOM holds the whole name, so it reads and copies whole. Pierre's middle truncation drew slivers of cut letters; `'end'` dropped the extension. To drop: if upstream gains a whole-letter tail-keeping truncation, switch the two tree views to it, delete `renderTailKeptName`, `fork_graphemes` and the three `[data-item-name-*]` rules from the patch |
| `onDirectoryExpand(path)` (a tree option) | All files lists folders lazily: an unloaded folder is a path ending in `/`; when it opens we load its children and `batch` them in |
| `model.refreshRows()` | Re-runs `renderParts` and `renderRowDecoration` after the host's state (viewed, staged, comments) changes |
| Shadow parts on row sections: `row-spacing`, `row-icon row-icon-file|directory`, `row-lead`, `row-git row-git-file|directory`, `row-content` (+ `row-content-muted`, `row-content-<tone>`), `row-decoration`, `row-trail` (+ `row-lead-<tone>`, `row-trail-<tone>`), `row-part`, `row-part-<id>`, `row-part-pressed`, and `search` / `search-open` on the find box | Stable styling from outside the shadow root with `::part()`, instead of CSS against internal attributes |
| CSS variables `--trees-row-lead-columns`, `--trees-row-trail-columns`, `--trees-row-part-gap`, `--trees-row-muted-opacity`, and `--trees-row-active` (1 on a hovered, focused or selected row, else 0; always 1 without hover) | The lead and trail are grids; the host sets column widths so `+N` and `−M` line up down the panel. `--trees-row-active` lets a part (Git add) show on hover only, from outside the shadow root |

The patch is about 125 added lines. Files touched (all under `dist/`): `render/FileTreeView.js` (rendering and clicks), `render/FileTree.js` (passing `rows`, `refreshRows`), `model/FileTreeController.js` (`onDirectoryExpand`), `style.js` (the grid CSS, appended as its own string), `model/publicTypes.d.ts`, `render/FileTree.d.ts`, `index.d.ts` (types). Source maps are not updated.

## Re-sync with a new upstream version

1. Bump `@pierre/trees` in `packages/review-editor/package.json` (and every other package that lists it) and rename the `patchedDependencies` key and file to the new version.
2. `bun install`. If Bun says the patch no longer applies: `bun patch @pierre/trees`, apply the old patch by hand in the folder Bun prints (`patch -p1 < patches/...`, fix rejects; the edits are small and keyed on stable names such as `renderStyledRow` and `renderFileTreeRowContent`), then `bun patch --commit <folder>`.
3. Run the tree's tests (`FileTree.*.test.tsx`, `FileTreeNode.controls.test.tsx`) and look at the review sidebar.

## Offering it upstream

The change maps onto upstream's TypeScript sources one to one (`src/render/FileTreeView.tsx`, `src/render/FileTree.ts`, `src/model/FileTreeController.ts`, `src/style.css`, `src/model/publicTypes.ts`). An upstream PR would add the same options there, plus tests.

## Pi and other installs

The tree is bundled into the review and Inbox HTML at build time. The Pi extension ships that built HTML and does not install `@pierre/trees`, so Pi needs nothing.
