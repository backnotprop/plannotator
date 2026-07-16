# Recap — "Since main" git-status review view

Date: 2026-07-02
Relates to: `adr/decisions/005-since-base-github-view-default-20260701-223706.md`

## What shipped

A composite `since-base` diff — `merge-base(base, HEAD)` vs the working tree plus
untracked files — became the **default** code-review view, rendered as a
three-section git-status panel (Committed / Changes / Untracked) with a
`Sections | Tree` toggle, a first-run setup chooser, and a "baseline behind
GitHub" fetch banner. Git only; Perforce/jj/workspace/PR modes untouched.
Shared logic lives in `packages/shared/review-core.ts` and is mirrored across
both server runtimes (Bun `packages/server/review.ts`, Pi
`apps/pi-extension/server/serverReview.ts`).

## Where the implementation diverged from the spec/ADR

These are deliberate implementation-time pivots — recorded so the ADR/spec aren't
read as ground truth where they differ:

1. **Sections sidecar carries no per-file `status`.** The spec's
   `files: Record<path, { group, status, staged }>` shipped as `{ group, staged }`
   only — the client already derives A/M/D/R from the patch itself.
2. **No "Advanced" footer row in the Sections panel.** Advanced diff modes live
   in the Tree view's `DiffTypePicker` dropdown; the header `Sections | Tree`
   toggle is the path between them. The Sections panel's only comparison control
   is the base row.
3. **`DiffTypeSetupDialog` was removed, not extended.** Replaced by the richer
   two-page `ReviewSetupDialog` (panel-view + diff-type chooser with screenshot
   previews), reached from a new "Set up review view" header-menu item.
4. **Committed section is not opacity-muted.** It renders at full weight,
   distinguished by the section header/grouping only.

## Post-merge review round (2026-07-02)

A seven-agent review + the app's own PR review surfaced a batch of fixes, all
landed on this branch:

- Sections rename parser split ` -> ` on the quoted token → a dirty file could
  show as Committed. Now quote-aware (`splitPorcelainRename`, unit-tested).
- `/api/diff/switch` epoch captured after `await req.json()` → a slow-body older
  request could overwrite a newer one. Epoch now captured before any await;
  `hideWhitespace` committed only on win. Both runtimes.
- Unresolvable base no longer auto-defaults to a degraded since-base — the
  default falls through to `uncommitted`. Fingerprint/file-content degrade to
  HEAD to match the diff/sections siblings.
- `rm --cached` no longer produces two diff entries for one path (untracked
  files already in the tracked patch are dropped) — fixes wrong-file-open and
  j/k nav looping in the Sections panel. Also fixes the latent
  uncommitted/unstaged cases.
- Settings' "Default Diff View" list now preserves the sections⟺since-base
  coupling.
- Banner only treats `origin/*` as fetchable; a bare local base ("main") is
  upgraded to its tracking ref at startup so Fetch can clear it.
- `hashUntracked` resolves untracked paths against the repo toplevel (was cwd)
  so a review launched from a subdirectory isn't blind to untracked edits.
- Agent review instruction now tells agents to enumerate/inspect untracked files.
- Terminology unified: one "Committed changes" label; the live "Since <base>"
  label is dynamic (matches the header), "Since main" kept only as product copy.

## Known limitations

- **Staleness banner is scoped to the remote default base.** "Baseline behind
  GitHub" answers "is `origin/<default>` ahead of what you're comparing against."
  If a reviewer picks a *different* base branch via the base picker, no staleness
  warning is shown for that base — supporting arbitrary-base upstream staleness
  is a separate feature, not built here. The common cases are covered: the
  default base, and a bare local default name (`main`) which is canonicalized to
  its tracking ref both at startup and on every `resolveReviewBase` call.
- **Committed deletion + untracked recreation shows as a plain new file.** If a
  branch commits the deletion of `f` and the user later recreates `f` untracked,
  the since-base dedupe (`removeTrackedDeletions`) drops the committed deletion
  and the review shows only the untracked addition — the removal of the base
  version is hidden. Fixing it would require two same-path diff entries, which
  the path-keyed UI (dock panel, nav, sections map, viewed state) cannot
  represent. Accepted: the reviewer still sees the file's full current content.
- **Index-only changes are not a separate layer.** Since-base diffs the
  WORKING TREE against the merge-base — "what lands if you `git add -A &&
  git commit` right now", which is the product promise. A change that exists
  only in the index (edit → `git add` → restore the working tree to base
  content) does not appear, because committing everything now would not
  include it. Deliberate semantics, not an oversight.
- **A filename literally containing ` -> ` can misgroup in the sidebar.**
  Porcelain v1 doesn't quote plain spaces, so a rename involving such a name
  splits at the wrong separator and both sides fall back to the Committed
  group. Only `--porcelain -z` fully disambiguates; not worth the parser
  rewrite for a pathological name. Display-only.

## Reference files

- Decision: `adr/decisions/005-since-base-github-view-default-20260701-223706.md`
- Spec: `adr/specs/github-view-three-stack-20260701-222935.md`
- Intent: `adr/intent-since-base-github-view-20260701-224500.md`
- Research: `adr/research/SPIKE-github-view-composite-diff-20260701-222935.md`,
  `adr/research/synthesis-github-view-20260701-222935.md`
