# Plannotator's build of @pierre/diffs

`pierre-diffs-1.7.0-beta.3-sem.2.tgz` is `@pierre/diffs` built from Pierre's unreleased `amadeus/semantic-diffs` branch, which draws semantic diffs (moved, renamed, reformatted, extracted and inlined code, with moved code folded into one row). It is installed as `@pierre/diffs-sem` (root `devDependencies`), and the code review app's build points `@pierre/diffs` at it (`apps/review/vite.config.ts`). Every `package.json` keeps the stock npm `@pierre/diffs`, so nothing published depends on this file. That includes `@plannotator/ui` and the Pi extension, which uses only `@pierre/diffs/ssr`.

| | |
|---|---|
| Upstream | github.com/pierrecomputer/pierre, branch `amadeus/semantic-diffs` |
| Upstream commit | `3eb8f393` (2026-11-12), on top of `beta-1.7` (= 1.7.0-beta.3 plus later fixes) |
| Our changes | `fork.patch`: (1) `FileDiff.loadFilesIfNecessary` returns instead of throwing when there is no `loadDiffFiles` (the same change as `patches/@pierre%2Fdiffs@1.7.0-beta.3.patch` for the stock package); (2) the first code row of a semantic region carries `data-semantic-start`, so code review can label the region in words (`usePierreTheme.ts`). The version becomes `1.7.0-beta.3-sem.2` |
| Licence | Apache-2.0 (Pierre) |

## Re-sync

1. In a Pierre checkout, fetch, then `git checkout <new commit of amadeus/semantic-diffs>` and `git apply <this folder>/fork.patch`. Bump the `-sem.N` version.
2. `pnpm install --frozen-lockfile --filter "@pierre/diffs..."`, then `moon run diffs:build`, then `pnpm pack` in `packages/diffs`.
3. Replace the tarball here. Update the file name in the root `package.json`, the commit in this file and `fork.patch` (`git diff <upstream commit> -- packages/diffs/src packages/diffs/package.json`). Then `bun install`.
4. In `packages/sem-diff`, run `PIERRE_DIR=<pierre checkout> bun run pierre-drift`. It fails if Pierre changed the semantic types that the engine fills.

The branch is rebased about weekly, so pin by commit and tarball, never by branch name. When Pierre releases semantic diffs on npm, drop this folder and the alias.
