# Refactor: Commits-view structure cleanup (pre-merge, PR #994)

Status: spec for review. Behavior-preserving — zero functional change intended.
Motivated by a code-quality audit of `feat/commit-list`; ships on the same
branch before merge.

## Why

Three review rounds in a row found real defects at the same seam: the commits
session's state machine (list cache, background poll, HEAD auto-select,
loading veil) is split between `useCommitLog.ts` and `App.tsx`, and every bug
was a cross-file invariant falling out of sync — stuck loading flags, a stale
auto-select, poll/adoption races. Each was patched by threading one more
invariant across the boundary. The seam is wrong; this moves the whole
machine into one module so the invariants become locally checkable.

Two smaller items ride along: `review-core.ts` (1,637 lines) absorbing the
~230-line commit-rail block it doesn't need to own, and a 10-line predicate
copy-pasted across both server runtimes.

## R1 — `useCommitsView`: one owner for the commits-session machine

Rename `packages/review-editor/hooks/useCommitLog.ts` →
`useCommitsView.ts` (git mv) and move INTO it, verbatim in semantics:

| Piece | From | Notes |
|---|---|---|
| HEAD auto-select effect + `commitsAutoSelectDone` ref | App.tsx | inputs: `enabled`, `activeCommitSha`, `isLoadingDiff`, internal `commits`; calls the new `onOpenCommit(sha)` option |
| `commitsVeilActive` predicate | App.tsx | becomes returned `veilActive`; inputs: `enabled`, `diffError`, `activeCommitSha`, `isLoadingDiff` (options) + `error`/`isLoading`/`commits.length` (internal) |

New options: `{ enabled, contextKey, activeCommitSha, isLoadingDiff,
diffError, onOpenCommit }`. New returns: existing log surface +
`veilActive`.

**Deliberately staying in App.tsx** (each guards a flow App owns):

- `commitsCapable` / `showCommitsPanel` derivations — needed above the global
  keyboard handler (Cmd+F guard) regardless.
- `handleSelectCommit` (user clicks): composes the worktree prefix and calls
  `fetchDiffSwitch`/`openAllFilesPanel` — diff switching is App's domain. It
  is also what the hook receives as `onOpenCommit`, so auto- and user-select
  share one code path by construction.
- The Cmd+F guard, the worktree-switch commit fallback, the
  staleness-refresh `commitLog.refresh()` call, the search-clear on entry.
- Render wiring for `CommitsPanel` and the veil overlay JSX.

No logic edits — relocation only. The auto-select/veil expressions move
character-identical except for reading internal state directly instead of
through the hook's return value.

## R2 — `packages/shared/commit-history.ts`: lift the rail block out of review-core

Moves (one cohesive consumer path — `/api/commits` + the commitInfo sidecar;
none of it participates in the diff-type dispatch):

- `CommitListEntry`, `CommitHistoryPage`, `listCommitHistory`,
  `COMMIT_HISTORY_LIMIT_DEFAULT/MAX`
- `CommitDiffInfo`, `getCommitDiffInfo`

**Deliberately staying in review-core** (woven into the diff-type dispatch):
`parseCommitDiffType`, `BARE_HEX_SHA_RE`, `COMMIT_FIELD_SEP`,
`splitCommitFormatFields`, the `runGitDiff`/fingerprint/file-contents commit
cases, `getEmptyTreeSha`, and `listRecentCommits` (pre-existing, feeds
`getGitContext`).

Wiring:

- review-core exports `COMMIT_FIELD_SEP`, `splitCommitFormatFields`,
  `BARE_HEX_SHA_RE` (currently private; `listRecentCommits` still uses them,
  so they cannot simply move).
- `packages/shared/package.json` exports += `./commit-history`.
- `apps/pi-extension/vendor.sh` list += `commit-history` (vendored files
  import siblings relatively — same as pr-provider → pr-github).
- Imports update: `packages/server/review.ts`, Pi `serverReview.ts`
  (`../generated/commit-history.js`), `packages/shared/types.ts` re-exports.
- Tests: `listCommitHistory` + `getCommitDiffInfo` suites move to a new
  `commit-history.test.ts` with its own copy of the small git test harness
  (per-file harnesses are the repo's existing test style). Commit-DIFF tests
  (runGitDiff/fingerprint/file-contents) stay in `review-core.test.ts`.

## R3 — shared `isSameCwdCommitSwitch(previous, next)` predicate

New export in review-core beside its inputs (`parseWorktreeDiffType`,
`parseCommitDiffType`); both runtimes' `/api/diff/switch` handlers replace
their ~10 inline lines with one call. Unit tests: plain commit switch, same
worktree, cross-worktree, non-commit next type.

## Explicitly out of scope

- Any behavior change, however small.
- The Bun/Pi endpoint duplication (documented two-runtime architecture).
- `AllFilesCodeView`'s leadingContent machinery (the scroller owns the
  viewport; right layer).
- `hashString`/`hashFingerprintPart` duplication (pre-existing; the import
  would drag node deps into the browser bundle).
- App.tsx decomposition beyond R1.

## Execution order & gates

R3 → R2 → R1 (smallest/mechanical first, the invariant-sensitive move last),
one commit each. Every commit passes: `bun run typecheck` (runs vendor.sh),
`bun test` (1,857 baseline, plus new R3 cases), review+hook builds, binary
recompile. After R2: live `/api/commits` + commit-switch smoke through the
compiled binary. After R1: manual UI pass (enter Commits, auto-open, click
around, leave/re-enter, error paths) — client hooks have no test infra;
accepted.

## Risk

R3 none; R2 mechanical (import/vendor wiring is the only failure mode, caught
by typecheck); R1 is the one to treat carefully — mitigated by moving
expressions verbatim and by the six review rounds' worth of documented
invariants in the comments, which move with the code.
