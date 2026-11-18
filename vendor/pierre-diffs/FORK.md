# Plannotator's build of @pierre/diffs

`pierre-diffs-1.7.0-beta.3-sem.6.tgz` is `@pierre/diffs` built from Pierre's unreleased `amadeus/semantic-diffs` branch, which draws semantic diffs (moved, renamed, reformatted, extracted and inlined code, with moved code folded into one row). It is installed as `@pierre/diffs-sem` (root `devDependencies`), and two builds point `@pierre/diffs` at it: the code review app (`apps/review/vite.config.ts`) and the Inbox window (the window's config in `apps/inbox/vite.config.ts`; the phone's surface and the Shape page, which share `sharedConfig`, stay on the stock package). Every `package.json` keeps the stock npm `@pierre/diffs`, so nothing published depends on this file. That includes `@plannotator/ui` and the Pi extension, which uses only `@pierre/diffs/ssr`.

| | |
|---|---|
| Upstream | github.com/pierrecomputer/pierre, branch `amadeus/semantic-diffs` |
| Upstream commit | `3eb8f393` (2026-11-12), on top of `beta-1.7` (= 1.7.0-beta.3 plus later fixes) |
| Our changes | `fork.patch`, on our fork branch `plannotator/diffs-fork`: (1) `FileDiff.loadFilesIfNecessary` returns instead of throwing when there is no `loadDiffFiles` (the same change as `patches/@pierre%2Fdiffs@1.7.0-beta.3.patch` for the stock package); (2) the first code row of a semantic region carries `data-semantic-start`, and its last row `data-semantic-end`, so code review can label and paint a region whole; (3) rows and connector paths carry a host-set origin (`data-semantic-origin`, `data-connector-origin`), used by Power Up; (4) `expandColourWaitMs` (default 300, Pierre's own wait) sets how long newly loaded or expanded lines wait for their colours before they are drawn plain and coloured when ready; (5) connector bands read in dark themes: translucent fill at 32% alpha plus a 1 px 50% edge in dark, light unchanged at 15%; (6) a band whose two ends span the same rows (no vertical travel, such as an edit or rename on one row) carries `data-connector-level` and draws without the dark edge, which would outline it as a rectangle. The version becomes `1.7.0-beta.3-sem.6` |
| Licence | Apache-2.0 (Pierre) |

## Re-sync

1. In a Pierre checkout, fetch, then `git checkout <new commit of amadeus/semantic-diffs>` and `git apply <this folder>/fork.patch`. Bump the `-sem.N` version.
2. `pnpm install --frozen-lockfile --filter "@pierre/diffs..."`, then `moon run diffs:build`, then `pnpm pack` in `packages/diffs`.
3. Replace the tarball here. Update the file name in the root `package.json`, the commit in this file and `fork.patch` (`git diff <upstream commit> -- packages/diffs/src packages/diffs/package.json`). Then `bun install`.
4. In a sem-jiff checkout (the engine behind the `@plannotator/sem-jiff` package), run `PIERRE_DIR=<pierre checkout> npm run pierre-drift`. It fails if Pierre changed the semantic types that the engine fills.

The branch is rebased about weekly, so pin by commit and tarball, never by branch name. When Pierre releases semantic diffs on npm, drop this folder and the alias.
