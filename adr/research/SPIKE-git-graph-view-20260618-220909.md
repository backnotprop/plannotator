# SPIKE: Git graph view in the code review app

Date: 2026-06-18
Status: **Backlogged** — explored, not building now.

## What we explored

Idea: a git-graph view in the review app. Show a commit graph; click a commit and
its file changes load on the right — basically a cross between the all-files view
and a way to switch between different commits' diffs.

This is a research note, not a commitment. We're parking it.

## Key finding: the diff viewer is already source-agnostic

`App.tsx` fetches `/api/diff` → gets a `rawPatch` string → `parseDiffToFiles()` →
feeds the FileTree + all-files view + single-file view. The viewer doesn't care
where the patch came from. So "click a commit → see its files" = fetch that
commit's patch and feed the same pipeline.

**The Pierre diff viewer needs ~no changes.** That was the main worry, and it's
the part that's basically free.

## What's already reusable

- `runGitDiff` (packages/shared/review-core.ts) already does diff modes:
  uncommitted / staged / last-commit / merge-base / all / branch. `last-commit`
  is literally `git diff HEAD~1..HEAD` — so a single commit's diff
  (`git diff <sha>^..<sha>`) is a tiny new mode.
- `listRecentCommits()` (review-core.ts ~245) already runs one `git log --pretty`
  and returns `RecentCommit[]` (powers the base-branch picker). That's the seed
  for a commit list.
- `/api/diff/switch` already swaps the active diff and re-renders. Selecting a
  commit is conceptually another switch.

## What's net-new

1. **Per-commit diff** — extend the diff backend to take a sha
   (`git show` / `git diff <sha>^..<sha>`); context-expansion base becomes the
   parent. Small. Must be mirrored in the Pi server.
2. **Graph data** — add parent hashes (`%P`) + refs (`%D`) to the log, then
   compute lane layout (which column each dot/edge sits in). The DAG parse is
   easy; the lane/rail layout is the fiddly part.
3. **Graph UI** — rows + SVG rails (dots, colored branch lines), commit metadata,
   selection, virtualization for big repos. This is the bulk of the work.

## The real gotcha

The diff system also supports **jj and Perforce**, not just git. A commit graph
is git-specific (jj has its own log/op-log model). So this would be **git-only**
unless we later add a jj variant. Decide up front.

## Suggested phasing (if/when we pick this up)

- **Phase 1 — commit browser (small/medium):** flat commit *list* in the sidebar
  + per-commit diff mode + click loads into the existing all-files view. No viewer
  changes, modest backend add. Validates the workflow cheaply.
- **Phase 2 — the graph (medium, mostly frontend):** layer lane rails / branch
  colors on top of Phase 1's data + wiring. The "cool visualization" lives here.

## Takeaway

Very doable. Phase 1 is a surprisingly small lift because the viewer is decoupled.
Backlogged for now — revisit when there's appetite, start with Phase 1.
