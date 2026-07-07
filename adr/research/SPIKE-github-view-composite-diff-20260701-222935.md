# SPIKE: "GitHub view" composite diff — feasibility check

Date: 2026-07-01
Status: Verified against code. Feeds `synthesis-github-view-20260701-222935.md` and `specs/github-view-three-stack-20260701-222935.md`.
Mockup: `adr/research/code_review_panel_three_stack_mockup.svg`

## Question

Can the three-stack panel in the mockup (Committed / Changes / Untracked, viewed
checkbox primary, staged dot, quiet stage button) be built as **one new diff type**
plus a status grouping — instead of three simultaneous diffs?

Answer: **yes.** The server's whole state machine assumes a single active patch
(`currentPatch` + one `currentDiffType` + one fingerprint in
`packages/server/review.ts:202-343`). One composite comparison fits that machine;
three parallel ones would not.

## The composite comparison

"What GitHub would see if I pushed right now" =
merge-base(origin/default, HEAD) → working tree, plus untracked.

Exact commands, all already-used primitives (`packages/shared/review-core.ts`):

```
git merge-base --end-of-options <base> HEAD          # same as merge-base mode, :691
git diff --no-ext-diff [-w] --src-prefix=a/ --dst-prefix=b/ --end-of-options <mb>
                                                     # <mb> with NO ..HEAD → compares vs working tree
+ getUntrackedFileDiffs()                            # :445 — /dev/null --no-index synthetic diffs
```

The section partition is a sidecar, not a diff:

```
git status --porcelain                               # working-tree state (already run for fingerprints, :846)
git diff --name-only <mb>..HEAD                      # the "changed on branch" file set
```

- **Committed** = in mb..HEAD set, clean in status
- **Changes** = tracked, dirty in status (M/A conjoined; staged bit from status column 1)
- **Untracked** = `??` lines

Sections sum exactly to the composite patch's file list.

## Touchpoint inventory (all verified, with line refs)

Server / shared — one new `DiffType` case each:

| File | What | Where |
|---|---|---|
| `packages/shared/review-core.ts` | `DiffType` union | :12-27 |
| " | `runGitDiff` switch — new case (mb lookup + `git diff <mb>` + untracked) | :548-764 |
| " | `getGitDiffFingerprint` — new case: HEAD sha + `hashDiffOutput([mb])` + `hashUntracked()` + base tip | :804-893; uncommitted/branch cases compose exactly the needed parts |
| " | `getFileContentsForDiff` — new case: old=`gitShow(mb)`, new=`readWorkingTree` | :895-966 |
| " | `getGitContext` diffOptions list — new option | :388-408 |
| `packages/shared/vcs-core.ts` | `GIT_DIFF_TYPES` set | :126 |
| " | `canStageFiles` — add new type (working-tree files, staging is valid) | :182-185 |
| " | `resolveInitialDiffType` — respects diffOptions, no change if option emitted | :509-525 |
| `packages/shared/config.ts` | `resolveDefaultDiffType` — add new type to whitelist, flip default (currently `'unstaged'`) | :227-231 |
| `packages/server/review.ts` | `/api/diff` + `/api/diff/switch` — generic over diffType, only needs the sections sidecar added to payloads | :912-955, :1000-1102 |
| `packages/server/agent-review-message.ts` | `getLocalDiffInstruction` — new case (target/inspect text) | case switch at :193-257 |
| Pi mirror | `apps/pi-extension` consumes a build-time copy of review-core; `serverReview.ts` needs the sidecar field mirrored | — |

Client:

| File | What |
|---|---|
| `packages/review-editor/hooks/useGitAdd.ts:17` | `STAGEABLE_DIFF_TYPES` set — add new type |
| `packages/review-editor/components/DiffTypePicker.tsx:18-35` | `OPTION_HINTS` — hint for new option |
| `packages/review-editor/components/FileTree.tsx` | Hosts all pickers (:395-470) and flat tree render (:472+). New Sections panel is a sibling view, not a FileTree rewrite |
| `packages/review-editor/App.tsx` | Payload already flows `diffType`/`base` generically; add `sections` state + Sections/Tree toggle |

## Baseline staleness ("is origin/main actually GitHub?")

`detectRemoteDefaultBranch` (`review-core.ts:213-234`) already runs
`git ls-remote --symref origin HEAD` at server start (fired at `review.ts:353-357`)
— and **discards the SHA line**. The same output contains `<sha>\tHEAD`. Keep it,
compare against local `git rev-parse origin/<branch>`, and staleness detection is
free at startup. Periodic re-check can piggyback a slower cadence next to the
existing 5s `/api/diff/fresh` poll (it's a network call — ~60s cadence, not 5s).

## Prior art in this repo

`SPIKE-git-graph-view-20260618-220909.md` (backlogged) independently confirmed:
the viewer is patch-source-agnostic (`rawPatch` → `parseDiffToFiles` → same
pipeline), and a flat commit list + per-commit diff is a small backend add. That
is exactly the future third toggle (Sections | Tree | Commits).

## Edge cases checked

- **On the default branch:** merge-base == HEAD → Committed section empty; Changes/Untracked ≡ today's uncommitted view. Degrades cleanly.
- **No remote:** `getDefaultBranch` falls back to local `main`/`master` (:195-201). View still works; staleness banner just never shows.
- **No HEAD (fresh repo):** uncommitted mode already guards with `rev-parse --verify HEAD` (:586); new mode needs the same guard (mb lookup fails → fall back to untracked-only).
- **File committed on branch AND edited now:** appears once, in Changes; its diff (mb → working tree) shows the full story. Confirmed decision — no per-file "since last commit" toggle; that intent stays in the advanced menu as the existing `last-commit` type.
- **Staged-but-reverted-in-worktree:** `git diff <mb>` reads the working tree, so the file drops out of the patch; status still shows it staged. Cosmetic only — dot renders on a file with an empty diff. Acceptable.
- **jj / p4 / workspace:** out of scope. `since-base` is git-owned via `GIT_DIFF_TYPES`; other VCS types keep their current default view untouched.

## Conclusion

No blocker found. This is one new git diff mode (~6 small case additions along an
existing, well-worn seam), one payload sidecar, one new panel component, and a
config-default flip. The expensive-looking part of the mockup — three sections —
is a client-side grouping of data the server mostly computes already.
